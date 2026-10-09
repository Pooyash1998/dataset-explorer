// Client for the optional backend in server/. Every call returns parsed JSON or throws an HFError.
import { API_URL } from "./config.js";
import { HFError } from "./hf.js";

const override = () => { try { return localStorage.getItem("dx.api"); } catch { return null; } };
export const apiBase = () => (override() ?? API_URL).replace(/\/+$/, "");

let up = null, checked = 0;
export async function serverUp() {
  const base = apiBase();
  if (!base) return false;
  if (up === null || (!up && Date.now() - checked > 15000)) {
    checked = Date.now();
    try {
      const res = await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(2500) });
      up = res.ok;
    } catch { up = false; }
  }
  return up;
}

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
    up = false; checked = Date.now();
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
