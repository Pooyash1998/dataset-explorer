// Calls to Hugging Face. Only huggingface.co / hf.co hosts are ever contacted.
const API = "https://datasets-server.huggingface.co";
export const DATASET_RE = /^[\w.-]+(\/[\w.-]+)?$/;

export class HFError extends Error {
  constructor(message, status = 500, auth = false) { super(message); this.status = status; this.auth = auth; }
}

const okHost = u => { try { const h = new URL(u).hostname; return h === "huggingface.co" || h.endsWith(".huggingface.co") || h === "hf.co"; } catch { return false; } };
const sleep = ms => new Promise(r => setTimeout(r, ms));

export async function hfFetch(url, token, init = {}) {
  if (!okHost(url)) throw new HFError("Refusing to fetch a non-Hugging Face URL.", 400);
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, { ...init, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...init.headers } });
    if ((res.status === 429 || res.status >= 500) && attempt < 4) { await sleep(1000 * 2 ** attempt); continue; }
    return res;
  }
}

// Parquet shards of the auto-converted copy, for every config and split.
export async function listParquet(dataset, token) {
  const res = await hfFetch(`${API}/parquet?dataset=${encodeURIComponent(dataset).replace("%2F", "/")}`, token);
  if (!res.ok) {
    let msg = "";
    try { msg = (await res.json()).error || ""; } catch {}
    const auth = [401, 403, 404].includes(res.status) || /gated|authenticat|private/i.test(msg);
    throw new HFError(msg || `Hugging Face answered HTTP ${res.status}.`, res.status === 404 ? 404 : res.status, auth);
  }
  const d = await res.json();
  const files = (d.parquet_files || []).filter(f => okHost(f.url));
  if (!files.length) throw new HFError("This dataset has no Parquet files yet. It may still be converting.", 404);
  return { files, partial: !!d.partial };
}
