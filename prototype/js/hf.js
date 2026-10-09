// Thin client for the Hugging Face datasets-server API (CORS-enabled, no backend needed).
const API = "https://datasets-server.huggingface.co";
export const PAGE_LEN = 100; // the rows endpoint caps a page at 100

export class HFError extends Error {
  constructor(message, { status = 0, auth = false } = {}) {
    super(message);
    this.status = status;
    this.auth = auth;
  }
}

// Accepts "owner/name", "name", or a huggingface.co / hf.co dataset link.
export function parseDatasetId(input) {
  let s = String(input || "").trim();
  if (!s) return null;
  const url = s.match(/^(?:https?:\/\/)?(?:www\.)?(?:huggingface\.co|hf\.co)\/datasets\/([^/?#\s]+(?:\/[^/?#\s]+)?)/i);
  if (url) s = url[1];
  s = s.replace(/^datasets\//, "").replace(/\/+$/, "");
  const m = s.match(/^([\w.-]+)(?:\/([\w.-]+))?$/);
  return m ? (m[2] ? `${m[1]}/${m[2]}` : m[1]) : null;
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

// Called with a message while a request is being retried, and with "" when it recovers.
let notify = () => {};
export const onRetryNotice = fn => { notify = fn; };

// Pacing shared by patient (background) requests. The gap between request starts widens on a rate limit and
// relaxes slowly. After a rate limit every request waits out a cool-down first, because requests that are
// blocked still count against the limit.
const MIN_GAP = 80, MAX_GAP = 1500, MIN_COOL = 20000, MAX_COOL = 90000;
let gap = MIN_GAP, nextAt = 0, blockedUntil = 0, cool = MIN_COOL, lastOk = 0;
const aborted = () => new DOMException("Aborted", "AbortError");

async function pace(signal) {
  const at = Math.max(Date.now(), nextAt);
  nextAt = at + gap;
  if (at > Date.now()) await sleep(at - Date.now());
  // A cool-down may have started while this request was waiting its turn.
  while (Date.now() < blockedUntil && !signal?.aborted) await sleep(Math.min(1000, blockedUntil - Date.now()));
  if (signal?.aborted) throw aborted();
}

// patient: never give up on rate limits or network errors, only on real errors (auth, not found).
async function get(path, params, token, signal, patient = false) {
  const url = `${API}${path}?${new URLSearchParams(params)}`;
  const headers = token ? { Authorization: `Bearer ${token}` } : {};
  for (let attempt = 0; ; attempt++) {
    if (patient) await pace(signal);
    let res = null;
    try { res = await fetch(url, { headers, signal }); }
    catch (e) { if (e.name === "AbortError") throw e; }
    // A 429 from the CDN carries no CORS headers, so the browser reports it as a failed fetch (res === null).
    const transient = !res || res.status === 429 || res.status >= 500;
    if (res?.ok) {
      if (patient) { gap = Math.max(MIN_GAP, gap * 0.97); cool = Math.max(MIN_COOL, cool * 0.8); lastOk = Date.now(); }
      if (attempt) notify("");
      return res.json();
    }
    if (patient && !res && attempt >= 2 && Date.now() - lastOk < 4000) {
      // Other requests keep succeeding, so this page itself is the problem (the CDN answers oversized pages with a bare 413).
      throw new HFError("This page of rows is too large to fetch.", { status: 413 });
    }
    // Rate limits and network errors are waited out for good; a server error that repeats is given up on.
    if (transient && (attempt < 4 || (patient && (!res || res.status === 429 || attempt < 8)))) {
      if (patient && attempt < 2) { await sleep(1000); continue; }
      if (patient) {
        if (blockedUntil - Date.now() < cool / 2) { blockedUntil = Date.now() + cool; gap = Math.min(MAX_GAP, Math.max(gap * 2, 300)); cool = Math.min(MAX_COOL, cool * 1.5); }
        notify(`Hugging Face is rate limiting, resuming in about ${Math.ceil((blockedUntil - Date.now()) / 1000)}s`);
        continue;
      }
      notify("Hugging Face is slow or rate limiting requests, retrying\u2026");
      await sleep(Math.min(1500 * 2 ** attempt, 30000));
      if (signal?.aborted) throw aborted();
      continue;
    }
    notify("");
    if (!res) throw new HFError("Could not reach Hugging Face. You may be offline, or it is rate limiting your network. Wait a minute and try again.");
    let msg = "";
    try { msg = (await res.json()).error || ""; } catch {}
    const auth = [401, 403, 404].includes(res.status) || /gated|authenticat|private/i.test(msg);
    throw new HFError(msg || `Hugging Face answered HTTP ${res.status}.`, { status: res.status, auth });
  }
}

export async function getSplits(dataset, token, signal) {
  const d = await get("/splits", { dataset }, token, signal);
  if (!d.splits?.length) {
    throw new HFError(d.pending?.length
      ? "Hugging Face is still processing this dataset. Try again in a minute."
      : "This dataset has no viewable splits (its format may not be supported by the Hugging Face viewer).");
  }
  return d.splits;
}

export async function getRows(dataset, config, split, offset, length, token, signal, patient = false) {
  try {
    const d = await get("/rows", { dataset, config, split, offset, length }, token, signal, patient);
    return { features: d.features, rows: d.rows, total: d.num_rows_total, partial: !!d.partial };
  } catch (e) {
    if (e.status !== 413) throw e;
    // Too big to send in one piece: fetch it in halves. A single row that is still too big is skipped.
    if (length <= 1) return { rows: [] };
    const h = Math.ceil(length / 2);
    const [x, y] = [await getRows(dataset, config, split, offset, h, token, signal, patient),
      await getRows(dataset, config, split, offset + h, length - h, token, signal, patient)];
    return { features: x.features || y.features, rows: [...x.rows, ...y.rows], total: x.total ?? y.total, partial: x.partial || y.partial };
  }
}

// The auto-converted Parquet files of one split, in order. Throws if there are none.
export async function getParquetFiles(dataset, config, split, token, signal) {
  const d = await get("/parquet", { dataset }, token, signal);
  const files = (d.parquet_files || []).filter(f => f.config === config && f.split === split)
    .sort((a, b) => a.filename.localeCompare(b.filename));
  if (!files.length) throw new HFError("No Parquet files for this split.");
  return files;
}

// Downloads a whole file in one request, reporting progress. Few requests, so the rate limit does not matter.
export async function downloadFile(url, token, signal, onProgress) {
  const res = await fetch(url, { headers: token ? { Authorization: `Bearer ${token}` } : {}, signal });
  if (!res.ok) throw new HFError(`Hugging Face answered HTTP ${res.status}.`, { status: res.status, auth: [401, 403, 404].includes(res.status) });
  const total = +res.headers.get("content-length") || 0;
  const reader = res.body.getReader();
  const parts = [];
  let got = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value); got += value.length;
    onProgress?.(got, total);
  }
  const out = new Uint8Array(got);
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out.buffer;
}
