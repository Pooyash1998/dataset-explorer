// Session registry and the on-disk cache. Private (token) data lives under its own namespace and is deleted
// when its expiry passes, when the user signs out, or on request.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DuckDBInstance } from "@duckdb/node-api";
import { config } from "./config.js";

export const nsFor = token => (token ? "u-" + crypto.createHash("sha256").update(token).digest("hex").slice(0, 24) : "public");
const slug = s => String(s).replace(/[^\w.-]+/g, "_");
export const dirFor = (ns, dataset, cfg, split) => path.join(config.dataDir, ns, `${slug(dataset)}__${slug(cfg)}__${slug(split)}`);

const sessions = new Map();   // sid -> Session
const byDir = new Map();      // dir -> Session

export class Session {
  constructor(dir, ns, meta) {
    this.dir = dir; this.ns = ns; this.meta = meta;
    this.db = null; this.dbOpened = 0; this.cache = new Map(); this.job = null; this.inflight = 0;
  }
  get sid() { return this.meta.sid; }
  save() { fs.mkdirSync(this.dir, { recursive: true }); fs.writeFileSync(path.join(this.dir, "meta.json"), JSON.stringify(this.meta)); }
  touch() { this.meta.lastAccess = Date.now(); this.dbOpened = Date.now(); }
  // Run fn while this session's database is guaranteed to stay open.
  async use(fn) {
    this.inflight++;
    try { return await fn(); } finally { this.inflight--; }
  }
  async conn() {
    if (!this.db) {
      // Each open database has its own memory pool, so keep only a few open and close the least recently used.
      const open = allSessions().filter(s => s.db && s !== this && !s.job && !s.inflight).sort((a, b) => a.dbOpened - b.dbOpened);
      let count = allSessions().filter(s => s.db).length;
      while (count >= config.maxOpenDbs && open.length) { open.shift().closeDb(); count--; }
      this.db = await DuckDBInstance.create(path.join(this.dir, "db.duckdb"), {
        memory_limit: config.duckMemory, threads: config.duckThreads,
      });
    }
    this.touch();
    return this.db.connect();
  }
  closeDb() { try { this.db?.closeSync?.(); } catch {} this.db = null; }
  destroy() {
    this.closeDb();
    sessions.delete(this.sid); byDir.delete(this.dir);
    fs.rmSync(this.dir, { recursive: true, force: true });
  }
}

export function create(dir, ns, meta) {
  const s = new Session(dir, ns, { sid: crypto.randomBytes(12).toString("hex"), createdAt: Date.now(), lastAccess: Date.now(), ...meta });
  sessions.set(s.sid, s); byDir.set(dir, s);
  s.save();
  return s;
}
export const bySid = sid => sessions.get(sid);
export const byDirectory = dir => byDir.get(dir);
export const allSessions = () => [...sessions.values()];

// Rebuild the registry from disk after a restart.
export function loadFromDisk() {
  if (!fs.existsSync(config.dataDir)) return;
  for (const ns of fs.readdirSync(config.dataDir)) {
    const nsDir = path.join(config.dataDir, ns);
    if (!fs.statSync(nsDir).isDirectory()) continue;
    for (const d of fs.readdirSync(nsDir)) {
      const dir = path.join(nsDir, d);
      try {
        const meta = JSON.parse(fs.readFileSync(path.join(dir, "meta.json"), "utf8"));
        if (meta.status !== "ready") { fs.rmSync(dir, { recursive: true, force: true }); continue; } // unfinished job
        const s = new Session(dir, ns, meta);
        sessions.set(s.sid, s); byDir.set(dir, s);
      } catch { fs.rmSync(dir, { recursive: true, force: true }); }
    }
  }
}

const dirSize = dir => {
  let n = 0;
  for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, f.name);
    n += f.isDirectory() ? dirSize(p) : fs.statSync(p).size;
  }
  return n;
};

// Delete expired private data, idle public data, and the least recently used public data over the size cap.
export function sweep() {
  const now = Date.now();
  for (const s of allSessions()) {
    if (s.job) continue;
    const priv = s.ns !== "public";
    if (priv && s.meta.expiresAt && s.meta.expiresAt < now) s.destroy();
    else if (!priv && now - s.meta.lastAccess > config.publicIdleMs) s.destroy();
    else if (s.db && !s.inflight && now - s.dbOpened > 10 * 60_000) s.closeDb();
  }
  const pub = allSessions().filter(s => s.ns === "public" && !s.job).sort((a, b) => a.meta.lastAccess - b.meta.lastAccess);
  let total = pub.reduce((n, s) => n + (s.meta.bytes || 0), 0);
  for (const s of pub) { if (total <= config.cacheMaxBytes) break; total -= s.meta.bytes || 0; s.destroy(); }
}

export function purgeNamespace(ns) {
  for (const s of allSessions()) if (s.ns === ns) s.destroy();
  if (ns !== "public") fs.rmSync(path.join(config.dataDir, ns), { recursive: true, force: true });
}

export { dirSize };
