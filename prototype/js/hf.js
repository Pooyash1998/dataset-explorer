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

async function get(path, params, token, signal) {
  const url = `${API}${path}?${new URLSearchParams(params)}`;
  const headers = token ? { Authorization: `Bearer ${token}` } : {};
  for (let attempt = 0; ; attempt++) {
    let res = null;
    try { res = await fetch(url, { headers, signal }); }
    catch (e) { if (e.name === "AbortError") throw e; }
    // A 429 from the CDN carries no CORS headers, so the browser reports it as a failed fetch (res === null).
    const transient = !res || res.status === 429 || res.status >= 500;
    if (res?.ok) { if (attempt) notify(""); return res.json(); }
    if (transient && attempt < 4) {
      notify("Hugging Face is slow or rate limiting requests, retrying\u2026");
      await sleep(1500 * 2 ** attempt);
      if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
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

export async function getRows(dataset, config, split, offset, length, token, signal) {
  const d = await get("/rows", { dataset, config, split, offset, length }, token, signal);
  return { features: d.features, rows: d.rows, total: d.num_rows_total, partial: !!d.partial };
}
