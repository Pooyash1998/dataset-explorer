// "Sign in with Hugging Face": OAuth 2.0 authorization code flow with PKCE, entirely in the browser.
import { HF_CLIENT_ID, HF_SCOPES } from "./config.js";

const HUB = "https://huggingface.co";
const KEY = "dx.oauth";       // { token, exp, name, avatar }
const PENDING = "dx.oauth.pending";

export const oauthEnabled = !!HF_CLIENT_ID;
const redirectUri = () => location.origin + location.pathname;

const read = (k, s) => { try { return JSON.parse(s.getItem(k) || "null"); } catch { return null; } };
const write = (k, v, s) => { try { s.setItem(k, JSON.stringify(v)); } catch {} };

const b64url = buf => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const rand = n => b64url(crypto.getRandomValues(new Uint8Array(n)));

export function session() {
  const s = read(KEY, localStorage);
  if (!s) return null;
  if (s.exp && s.exp < Date.now()) { localStorage.removeItem(KEY); return null; }
  return s;
}
export const oauthToken = () => session()?.token || "";
export function signOut() { try { localStorage.removeItem(KEY); } catch {} }

export async function signIn(returnHash = "#/") {
  if (!crypto?.subtle) throw new Error("Sign-in needs a secure page (https or localhost).");
  const verifier = rand(48), state = rand(16);
  write(PENDING, { verifier, state, returnHash }, sessionStorage);
  const challenge = b64url(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)));
  location.href = `${HUB}/oauth/authorize?` + new URLSearchParams({
    client_id: HF_CLIENT_ID, redirect_uri: redirectUri(), response_type: "code", scope: HF_SCOPES,
    state, code_challenge: challenge, code_challenge_method: "S256",
  });
}

// Call once on startup. Returns the hash to go back to when it just completed a sign-in, "" if nothing to do,
// or throws with a readable message if the sign-in failed.
export async function handleRedirect() {
  const q = new URLSearchParams(location.search);
  if (!q.has("code") && !q.has("error")) return "";
  const pending = read(PENDING, sessionStorage);
  history.replaceState(null, "", location.pathname + (pending?.returnHash || "#/"));
  try { sessionStorage.removeItem(PENDING); } catch {}
  if (q.get("error")) throw new Error(q.get("error_description") || "Sign-in was cancelled.");
  if (!pending || pending.state !== q.get("state")) throw new Error("Sign-in expired. Please try again.");
  const res = await fetch(`${HUB}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code", code: q.get("code"), redirect_uri: redirectUri(),
      client_id: HF_CLIENT_ID, code_verifier: pending.verifier,
    }),
  });
  const tok = await res.json().catch(() => ({}));
  if (!res.ok || !tok.access_token) throw new Error(tok.error_description || "Hugging Face did not accept the sign-in.");
  const s = { token: tok.access_token, exp: tok.expires_in ? Date.now() + tok.expires_in * 1000 - 60000 : 0 };
  try {
    const u = await (await fetch(`${HUB}/oauth/userinfo`, { headers: { Authorization: `Bearer ${s.token}` } })).json();
    s.name = u.preferred_username || u.name; s.avatar = u.picture;
  } catch {}
  write(KEY, s, localStorage);
  return pending.returnHash || "#/";
}
