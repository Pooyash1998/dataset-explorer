// Register a public OAuth app (no secret) at https://huggingface.co/settings/applications/new, then paste its
// client id here. Redirect URI: the exact URL this site is served from, e.g. https://your-app.vercel.app/
// (http://localhost works on any port once http://localhost/ is registered). Leave empty to hide sign-in.
export const HF_CLIENT_ID = "67164b0a-c11c-435c-b743-4611614505e9";
export const HF_SCOPES = "openid profile gated-repos";

// Optional backend (server/ in this repo, deployed e.g. on Render). With it, whole datasets are indexed and
// searched on the server. Leave empty to run in the browser only. A "dx.api" value in localStorage overrides it.
export const API_URL = "https://dataset-explorer-server.onrender.com";
