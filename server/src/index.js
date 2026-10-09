import { Hono } from "hono";
import { cors } from "hono/cors";
import { serve } from "@hono/node-server";
import { config } from "./config.js";
import { DATASET_RE, HFError, listParquet } from "./hf.js";
import { allSessions, bySid, byDirectory, create, dirFor, loadFromDisk, nsFor, purgeNamespace, sweep } from "./store.js";
import { startJob } from "./indexer.js";
import { facetCounts, isFiltered, queryRows } from "./query.js";

const app = new Hono();
app.use("/api/*", cors({
  origin: config.allowedOrigins.includes("*") ? "*" : config.allowedOrigins,
  allowHeaders: ["Authorization", "Content-Type"], allowMethods: ["GET", "POST", "DELETE", "OPTIONS"], maxAge: 600,
}));
app.onError((e, c) => {
  if (!(e instanceof HFError)) console.error(e);
  const status = e instanceof HFError ? e.status : 500;
  return c.json({ error: e.message || "Server error", auth: !!e.auth }, status >= 400 && status < 600 ? status : 500);
});

const bearer = c => (c.req.header("authorization") || "").replace(/^Bearer\s+/i, "").trim();

function snapshot(s) {
  const m = s.meta;
  return {
    sid: s.sid, dataset: m.dataset, config: m.config, split: m.split, splits: m.splits, status: m.status, stage: m.stage,
    progress: m.progress, error: m.error || null, rawReady: !!m.rawReady, indexReady: !!m.indexReady, total: m.total ?? null,
    indexedRows: m.indexedRows ?? null, columns: m.columns || null, plan: m.plan || null,
    defs: (m.defs || []).map(d => ({ key: d.key, label: d.label, multi: d.multi })),
    partial: !!m.partial, private: s.ns !== "public", expiresAt: s.ns !== "public" ? m.expiresAt : null,
  };
}

function session(c) {
  const s = bySid(c.req.param("sid"));
  const token = bearer(c);
  if (!s || (s.ns !== "public" && nsFor(token) !== s.ns)) throw new HFError("Unknown or expired session.", 404);
  if (s.ns !== "public" && s.meta.expiresAt && s.meta.expiresAt < Date.now()) { s.destroy(); throw new HFError("This session expired. Open the dataset again.", 410); }
  s.meta.lastAccess = Date.now();
  return s;
}

app.get("/api/health", c => c.json({ ok: true, sessions: allSessions().length }));

app.post("/api/open", async c => {
  const body = await c.req.json().catch(() => ({}));
  const dataset = String(body.dataset || "");
  if (!DATASET_RE.test(dataset)) throw new HFError("That does not look like a dataset id.", 400);
  const token = bearer(c);

  // Public first: data readable without a token is shared. Otherwise it is private to this token.
  let ns = "public", listing;
  try { listing = await listParquet(dataset, null); }
  catch (e) {
    if (!(e instanceof HFError) || !e.auth || !token) throw e;
    ns = nsFor(token);
    listing = await listParquet(dataset, token);
  }

  const pairs = [...new Map(listing.files.map(f => [`${f.config}\0${f.split}`, { config: f.config, split: f.split }])).values()];
  const pick = pairs.find(p => p.config === body.config && p.split === body.split) || pairs.find(p => p.split === "train") || pairs[0];
  const files = listing.files.filter(f => f.config === pick.config && f.split === pick.split)
    .sort((a, b) => a.filename.localeCompare(b.filename));
  const bytes = files.reduce((n, f) => n + (f.size || 0), 0);
  if (bytes > config.maxDatasetBytes) {
    throw new HFError(`This split is ${(bytes / 1024 ** 3).toFixed(1)} GB, over the server limit of ${(config.maxDatasetBytes / 1024 ** 3).toFixed(0)} GB.`, 413);
  }

  const dir = dirFor(ns, dataset, pick.config, pick.split);
  let s = byDirectory(dir);
  if (s?.meta.status === "error") { s.destroy(); s = null; }
  const expiresAt = ns === "public" ? null
    : Math.min(Date.now() + config.privateTtlMs, Number(body.expiresAt) > Date.now() ? Number(body.expiresAt) : Infinity);
  if (!s) {
    s = create(dir, ns, {
      dataset, config: pick.config, split: pick.split, splits: pairs, status: "queued", stage: "Queued", progress: 0,
      partial: listing.partial, expiresAt,
    });
    startJob(s, files, ns === "public" ? null : token);
  } else if (ns !== "public") s.meta.expiresAt = expiresAt;
  s.meta.lastAccess = Date.now();
  return c.json(snapshot(s));
});

app.get("/api/sessions/:sid", c => c.json(snapshot(session(c))));

app.post("/api/sessions/:sid/query", async c => {
  const s = session(c), body = await c.req.json().catch(() => ({}));
  if (!s.meta.rawReady) throw new HFError("Still preparing this dataset.", 409);
  if (isFiltered(body) && !s.meta.indexReady) throw new HFError("Still indexing. Filters and search are not ready yet.", 409);
  const conn = await s.conn();
  return c.json(await queryRows(conn, s.meta, body));
});

app.post("/api/sessions/:sid/facets", async c => {
  const s = session(c), body = await c.req.json().catch(() => ({}));
  if (!s.meta.indexReady) throw new HFError("Still indexing.", 409);
  const key = JSON.stringify([body.filters || {}, body.q || "", !!body.regex]);
  if (!s.cache.has(key)) {
    const conns = await Promise.all([s.conn(), s.conn(), s.conn()]);
    const defs = await facetCounts(conns, s.meta, body);
    if (s.cache.size > 40) s.cache.delete(s.cache.keys().next().value);
    s.cache.set(key, defs);
  }
  return c.json({ defs: s.cache.get(key) });
});

app.delete("/api/sessions/:sid", c => {
  const s = session(c);
  if (s.ns !== "public") s.destroy();
  return c.json({ ok: true });
});

// Sign-out: remove everything stored for this token.
app.delete("/api/cache", c => {
  const token = bearer(c);
  if (token) purgeNamespace(nsFor(token));
  return c.json({ ok: true });
});

loadFromDisk();
setInterval(sweep, 60_000).unref();
serve({ fetch: app.fetch, port: config.port }, i => console.log(`data-explorer server on :${i.port}, data in ${config.dataDir}`));
