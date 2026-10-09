// Client for the optional backend in server/. Every call returns parsed JSON or throws an HFError.
import { API_URL } from "./config.js";
import { HFError } from "./hf.js";

const override = () => { try { return localStorage.getItem("dx.api"); } catch { return null; } };
export const apiBase = () => (override() ?? API_URL).replace(/\/+$/, "");

let up = false, warming = null;
const sleep = ms => new Promise(r => setTimeout(r, ms));
export const isUp = () => up;

// Free hosting sleeps when idle and takes up to a minute to wake. Poll /api/health until it answers.
export function warmUp(maxMs = 60000) {
  const base = apiBase();
  if (!base) return Promise.resolve(false);
  if (up) return Promise.resolve(true);
  warming ||= (async () => {
    const end = Date.now() + maxMs;
    while (Date.now() < end) {
      try {
        const res = await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(8000) });
        if (res.ok) { up = true; return true; }
      } catch {}
      await sleep(2500);
    }
    return false;
  })().finally(() => { warming = null; });
  return warming;
}
export const serverUp = () => warmUp();
export const keepAlive = () => { if (up) fetch(`${apiBase()}/api/health`).catch(() => { up = false; }); };

export async function call(method, path, { body, token, signal } = {}) {
  let res;
  try {
    res = await fetch(apiBase() + path, {
      method, signal,
      headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body ? { "Content-Type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch (e) {
    if (e.name === "AbortError") throw e;
    up = false;
    const err = new HFError("Could not reach the server.");
    err.fallback = true;
    throw err;
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new HFError(data.error || `The server answered HTTP ${res.status}.`, { status: res.status, auth: !!data.auth });
    err.fallback = res.status >= 500 || res.status === 413;
    throw err;
  }
  return data;
}

export const openRemote = (body, token, signal) => call("POST", "/api/open", { body, token, signal });
export const snapshot = (sid, token, signal) => call("GET", `/api/sessions/${sid}`, { token, signal });
export const queryRows = (sid, body, token, signal) => call("POST", `/api/sessions/${sid}/query`, { body, token, signal });
export const queryFacets = (sid, body, token, signal) => call("POST", `/api/sessions/${sid}/facets`, { body, token, signal });
export const purgeCache = token => token ? call("DELETE", "/api/cache", { token }).catch(() => {}) : Promise.resolve();
