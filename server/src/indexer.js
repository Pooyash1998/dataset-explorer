// The background job: download Parquet, load it into DuckDB, then index facets and search text for every row.
import fs from "node:fs";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { config } from "./config.js";
import { hfFetch, HFError } from "./hf.js";
import { dirSize } from "./store.js";
import { rowsJson, qstr } from "./query.js";
import { detectPlan, normalizeRow, buildDefs } from "../../prototype/js/schema.js";

const CHUNK = config.chunkRows;
const SEARCH_CHARS = Number(process.env.SEARCH_CHARS || 8000);
let running = 0;
const waiting = [];
const slot = async () => {
  if (running >= config.maxJobs) await new Promise(r => waiting.push(r));
  running++;
  return () => { running--; waiting.shift()?.(); };
};
const yieldLoop = () => new Promise(r => setImmediate(r));

export function startJob(sess, files, token) {
  const m = sess.meta;
  sess.job = (async () => {
    const release = await slot();
    try {
      await download(sess, files, token);
      await load(sess);
      await index(sess);
      m.status = "ready"; m.stage = "ready"; m.progress = 1;
      m.bytes = dirSize(sess.dir);
    } catch (e) {
      m.status = "error";
      m.error = e instanceof HFError ? e.message : `Processing failed: ${e.message}`;
      console.error("job failed", m.dataset, e);
    } finally {
      release();
      sess.job = null;
      sess.save();
    }
  })();
}

async function download(sess, files, token) {
  const m = sess.meta, parts = path.join(sess.dir, "parts");
  fs.mkdirSync(parts, { recursive: true });
  m.status = "downloading"; m.stage = "Downloading"; m.progress = 0;
  const totalBytes = files.reduce((n, f) => n + (f.size || 0), 0) || 1;
  let done = 0;
  for (const [i, f] of files.entries()) {
    const res = await hfFetch(f.url, token);
    if (!res.ok) throw new HFError(`Could not download ${f.filename} (HTTP ${res.status}).`, res.status, res.status === 401 || res.status === 403);
    const out = path.join(parts, `${String(i).padStart(4, "0")}.parquet`);
    const count = new Transform({ transform(chunk, _e, cb) { done += chunk.length; m.progress = Math.min(1, done / totalBytes); cb(null, chunk); } });
    await pipeline(Readable.fromWeb(res.body), count, fs.createWriteStream(out));
  }
}

async function load(sess) {
  const m = sess.meta, parts = path.join(sess.dir, "parts");
  m.status = "loading"; m.stage = "Loading into the database"; m.progress = 0;
  const list = fs.readdirSync(parts).sort().map(f => qstr(path.join(parts, f)));
  const c = await sess.conn();
  // Streaming the scan (no row-order buffering) keeps memory flat; __idx is assigned once here and kept.
  await c.run("SET preserve_insertion_order = false");
  await c.run(`CREATE OR REPLACE TABLE raw AS SELECT row_number() OVER () - 1 AS __idx, * FROM read_parquet([${list.join(", ")}], union_by_name = true)`);
  await c.run("RESET preserve_insertion_order");
  m.total = Number((await c.runAndReadAll("SELECT count(*) AS n FROM raw")).getRowObjects()[0].n);
  const d = (await c.runAndReadAll("DESCRIBE SELECT * EXCLUDE (__idx) FROM raw")).getRowObjects();
  m.columns = d.map(r => ({ name: r.column_name, type: r.column_type }));
  fs.rmSync(parts, { recursive: true, force: true });
  m.rawReady = true;
  sess.save();
}

async function index(sess) {
  const m = sess.meta;
  m.status = "indexing"; m.stage = "Indexing for search and filters"; m.progress = 0;
  const c = await sess.conn();
  const features = m.columns.map(col => ({ name: col.name, type: { dtype: col.type } }));

  // Roles and facet definitions come from an evenly spread sample.
  const k = Math.max(1, Math.floor(m.total / 3000));
  const sample = await rowsJson(c, m, `WHERE __idx % ${k} = 0 LIMIT 3000`);
  const plan = detectPlan(features, sample.map(r => r.row));
  const views = sample.map(r => normalizeRow(plan, r, features));
  const defs = buildDefs(plan, views, false);
  m.plan = { ...plan, consumed: [...plan.consumed] };
  m.defs = defs.map((d, i) => ({
    key: d.key, label: d.label, multi: !!d.multi, dynamic: !!d.dynamic, col: `f${i}`, opts: d.dynamic ? null : d.opts,
  }));
  sess.save();

  const n = Math.min(m.total, config.indexMaxRows);
  m.indexedRows = n;
  const file = path.join(sess.dir, "index.jsonl");
  fs.rmSync(file, { force: true });
  const fd = fs.openSync(file, "a");
  for (let start = 0; start < n; start += CHUNK) {
    const rows = await rowsJson(c, m, "WHERE __idx >= $1 AND __idx < $2", [start, Math.min(n, start + CHUNK)]);
    const lines = rows.map(r => {
      const v = normalizeRow(plan, r, features);
      const o = { idx: r.row_idx, s: v._s.slice(0, SEARCH_CHARS) };
      defs.forEach((d, i) => { const x = d.val(v); if (x !== undefined && x !== null) o[`f${i}`] = x; });
      return JSON.stringify(o);
    });
    fs.writeSync(fd, lines.join("\n") + "\n");
    m.progress = Math.min(1, (start + CHUNK) / n);
    await yieldLoop();
  }
  fs.closeSync(fd);

  m.stage = "Building the index"; m.progress = 1;
  const cols = [`'idx': 'BIGINT'`, `'s': 'VARCHAR'`, ...m.defs.map(d => `'${d.col}': '${d.multi ? "VARCHAR[]" : "VARCHAR"}'`)];
  await c.run(`CREATE OR REPLACE TABLE derived AS SELECT * FROM read_json(${qstr(file)}, format = 'newline_delimited', columns = {${cols.join(", ")}}) ORDER BY idx`);
  fs.rmSync(file, { force: true });
  m.indexReady = true;
}
