import { parseDatasetId, getSplits, getRows, HFError, PAGE_LEN, onRetryNotice } from "./hf.js";
import { detectPlan, normalizeRow, normalizeLocal, buildFacets } from "./schema.js";
import { oauthEnabled, oauthToken, session, signIn, signOut, handleRedirect } from "./auth.js";
import { esc, fmt, highlight, renderRow, renderListItem } from "./render.js";
import * as api from "./remote.js";

const LIST_PAGE = 200;     // rows per page in the list pane
const BLOCK_ROWS = 300;    // loaded before the explorer opens
const AUTO_ROWS = 1000;    // loaded quietly afterwards
const MORE_ROWS = 5000;
const CONCURRENCY = 3;
const EXAMPLES = [
  "nvidia/When2Call", "MadeAgents/xlam-irrelevance-7.5k", "Team-ACE/ToolACE",
  "NousResearch/hermes-function-calling-v1", "glaiveai/glaive-function-calling-v2",
];

const $ = id => document.getElementById(id);
const store = {
  get: (k, s = localStorage) => { try { return s.getItem(k); } catch { return null; } },
  set: (k, v, s = localStorage) => { try { s.setItem(k, v); } catch {} },
  del: (k, s = localStorage) => { try { s.removeItem(k); } catch {} },
};

// ---- state ------------------------------------------------------------------
let S = null;          // the open dataset, null on the landing page
let loadCtl = null;    // AbortController for everything in flight
let renderedDetail = null, refreshTimer = 0, toastTimer = 0;

function newState(src) {
  return {
    src, local: src.kind === "local", plan: null, byIdx: new Map(), pages: new Set(), views: [], filtered: [],
    defs: [], filters: {}, expanded: new Set(), query: "", matchRe: null, searchRe: null, regexBad: false,
    sel: -1, start: 0, tab: "view", total: 0, partial: false, hasTools: false, busy: false, error: "", splits: [],
    remote: src.kind === "remote", count: 0, page: [], base: 0, reqId: 0, rx: "", counts: {},
    index: { ready: true, progress: 1, stage: "", rows: 0 },
  };
}

// ---- views / routing -----------------------------------------------------------
function showView(name) {
  for (const v of ["landing", "loading", "explorer"]) $(v).hidden = v !== name;
  window.scrollTo(0, 0);
}

function cancelLoad() {
  loadCtl?.abort();
  loadCtl = null;
}

function route() {
  cancelLoad();
  clearTimeout(refreshTimer);
  const h = location.hash;
  let m;
  if ((m = h.match(/^#\/ds\/([^?]+)(?:\?(.*))?$/))) {
    const q = new URLSearchParams(m[2] || "");
    openDataset(decodeURIComponent(m[1]), q.get("config"), q.get("split"));
  } else if ((m = h.match(/^#\/local\/([\w.-]+)$/))) {
    openLocal(m[1]);
  } else {
    S = null;
    document.title = "Data Explorer";
    showView("landing");
    renderLanding();
  }
}
window.addEventListener("hashchange", route);

const dsHash = (id, config, split) =>
  `#/ds/${id}` + (config ? `?${new URLSearchParams({ config, split })}` : "");

function go(hash) {
  if (location.hash === hash) route(); else location.hash = hash;
}

// ---- landing ---------------------------------------------------------------------
const getToken = () => oauthToken();

function recents() {
  try { return JSON.parse(store.get("dx.recent") || "[]"); } catch { return []; }
}
function remember(id, config, split) {
  const list = recents().filter(r => r.id !== id);
  list.unshift({ id, config, split, ts: Date.now() });
  store.set("dx.recent", JSON.stringify(list.slice(0, 8)));
}

async function renderLanding() {
  $("examples").innerHTML = EXAMPLES.map(id => `<button class="chip-btn" data-ds="${esc(id)}">${esc(id)}</button>`).join("");
  $("open-error").hidden = true;

  renderAccount();
  if (api.apiBase()) {
    if (!api.isUp()) $("engine").textContent = "Waking the server, it sleeps when idle. You can open a dataset already.";
    api.warmUp().then(up => {
      $("engine").textContent = up ? "Server connected: whole datasets are indexed and searched on the server."
        : "Browser mode: rows are loaded a few thousand at a time.";
      $("engine").dataset.up = up ? "1" : "";
    });
  } else $("engine").textContent = "Browser mode: rows are loaded a few thousand at a time.";
  const rec = recents();
  $("recent").hidden = !rec.length;
  $("recent-list").innerHTML = rec.map(r => `<a class="shelf-item" href="${esc(dsHash(r.id, r.config, r.split))}">
    <span class="t">${esc(r.id)}</span><span class="s">${r.config ? esc(r.config + " / " + r.split) : ""}</span></a>`).join("");

  // Local samples exist only when prototype/build_data.py has been run, so only look for them in local development.
  const dev = ["localhost", "127.0.0.1", "[::1]"].includes(location.hostname);
  $("local").hidden = true;
  if (dev) try {
    const res = await fetch("data/index.json");
    const idx = res.ok ? await res.json() : [];
    if (Array.isArray(idx) && idx.length && !S) {
      $("local").hidden = false;
      $("local-list").innerHTML = idx.map(d => `<a class="shelf-item" href="#/local/${esc(d.key)}">
        <span class="t">${esc(d.title)}</span><span class="s">${fmt(d.rows)} rows</span></a>`).join("");
    }
  } catch { $("local").hidden = true; }
}

function renderAccount() {
  const me = session();
  $("signin-row").hidden = !oauthEnabled || !!me;
  $("account").hidden = !me;
  if (me) {
    $("account").innerHTML = `${me.avatar ? `<img src="${esc(me.avatar)}" alt="">` : ""}<span class="nm">${esc(me.name || "Signed in")}</span>
      <button class="link-btn" id="signout">Sign out</button>`;
  }
}
// The free server can restart (it has little memory) and forget a dataset. Carry on in browser mode.
function sessionLost() {
  const src = S?.src;
  toast("The server restarted and lost this dataset. Continuing in browser mode.");
  if (src?.id) openHF(src.id, src.config, src.split);
}
const startSignIn = () => signIn(location.hash || "#/").catch(e => toast(e.message));
$("signin").onclick = startSignIn;
$("load-signin").onclick = startSignIn;
$("account").addEventListener("click", async ev => {
  if (ev.target.id !== "signout") return;
  await api.purgeCache(getToken());   // the server deletes everything it stored for this token
  signOut();
  renderAccount();
});

function submitOpen(raw) {
  const id = parseDatasetId(raw);
  const err = $("open-error");
  if (!id) {
    err.textContent = "That does not look like a dataset id. Use owner/name, for example nvidia/When2Call.";
    err.hidden = false;
    $("ds-input").focus();
    return;
  }
  err.hidden = true;
  go(dsHash(id));
}

$("open-form").addEventListener("submit", ev => { ev.preventDefault(); submitOpen($("ds-input").value); });
$("examples").addEventListener("click", ev => {
  const b = ev.target.closest("[data-ds]");
  if (b) { $("ds-input").value = b.dataset.ds; submitOpen(b.dataset.ds); }
});
$("recent-clear").addEventListener("click", () => { store.del("dx.recent"); renderLanding(); });

// ---- loading screen ----------------------------------------------------------------
onRetryNotice(msg => {
  const el = $("load-note");
  el.textContent = msg;
  el.hidden = !msg || $("loading").hidden;
  if (S && !$("explorer").hidden) { S.note = msg; setStatus(); }
});

const STEPS = ["Finding the dataset", "Reading its schema", "Loading the first rows"];
function loadUI(title, steps) {
  showView("loading");
  $("load-title").textContent = title;
  $("load-steps").innerHTML = steps.map(s => `<li><span class="dot"></span><span>${esc(s)}</span></li>`).join("");
  $("load-error").hidden = true; $("load-note").hidden = true; $("load-token").hidden = true; $("load-retry").hidden = true;
  $("load-cancel").hidden = false;
  setBar(null);
  $("load-steps").parentElement.querySelector(".spinner").hidden = false;
}
function setStep(i, state) {
  const li = $("load-steps").children[i];
  if (li) li.className = state;
}
function setBar(p) {
  $("load-bar").hidden = p === null;
  $("load-bar").firstElementChild.style.width = `${Math.round((p || 0) * 100)}%`;
}
function loadFail(step, e) {
  setStep(step, "fail");
  setBar(null);
  $("load-steps").parentElement.querySelector(".spinner").hidden = true;
  const msg = e instanceof HFError ? e.message : `Something went wrong: ${e?.message || e}`;
  $("load-error").textContent = e?.auth ? `${msg}` : msg;
  $("load-error").hidden = false;
  $("load-token").hidden = !e?.auth;
  $("load-signin").hidden = !oauthEnabled || !!session();
  $("load-retry").hidden = false;
}
$("load-cancel").onclick = () => { cancelLoad(); go("#/"); };
setInterval(() => { if (S?.remote) api.keepAlive(); }, 8 * 60_000);
$("load-retry").onclick = () => // Finish an OAuth sign-in first (the redirect lands on ?code=...), then route.
handleRedirect().catch(e => toast(e.message)).finally(route);

// ---- opening a Hugging Face dataset --------------------------------------------------
function pickSplit(splits, config, split) {
  return splits.find(s => s.config === config && s.split === split)
    || splits.find(s => s.split === "train") || splits[0];
}

async function openDataset(id, config, split) {
  if (api.apiBase() && !api.isUp()) {
    loadUI(id, ["Waking the server"]);
    setStep(0, "active");
    $("load-note").textContent = "The free server sleeps when idle and can take up to a minute to wake.";
    $("load-note").hidden = false;
    
  }
  if (await api.serverUp()) {
    try { return await openRemote(id, config, split); }
    catch (e) {
      if (e.name === "AbortError") return;
      if (!e.fallback) return; // already shown on the loading screen
      toast(`${e.message} Using browser mode instead.`);
    }
  }
  return openHF(id, config, split);
}

const REMOTE_STEPS = ["Connecting to the server", "Downloading the dataset", "Loading it into the database", "Reading its schema"];
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function openRemote(id, wantConfig, wantSplit) {
  const ctl = loadCtl = new AbortController();
  const token = getToken();
  const me = session();
  S = null;
  document.title = `${id} \u00b7 Data Explorer`;
  loadUI(id, REMOTE_STEPS);
  let step = 0;
  try {
    setStep(0, "active");
    let snap = await api.openRemote({ dataset: id, config: wantConfig, split: wantSplit, expiresAt: me?.exp || undefined }, token, ctl.signal);
    setStep(0, "done");
    for (;;) {
      if (snap.status === "error") {
        // Too big for the small free server: carry on in the browser instead.
        if (/out of memory|over the server limit/i.test(snap.error)) throw Object.assign(new HFError("This dataset is too big for the free server."), { fallback: true });
        throw Object.assign(new HFError(snap.error), { auth: /gated|authenticat|access/i.test(snap.error) });
      }
      const at = snap.status === "queued" || snap.status === "downloading" ? 1 : snap.status === "loading" ? 2 : 3;
      for (let i = 1; i < at; i++) setStep(i, "done");
      setStep(step = at, "active");
      setBar(at === 1 ? snap.progress : null);
      if (snap.plan && snap.rawReady) break;
      await sleep(600);
      if (ctl.signal.aborted) return;
      snap = await api.snapshot(snap.sid, token, ctl.signal);
    }
    setStep(3, "done");
    const st = newState({ kind: "remote", id, config: snap.config, split: snap.split, sid: snap.sid, token });
    st.splits = snap.splits;
    st.total = snap.total;
    st.partial = snap.partial;
    st.plan = { ...snap.plan, consumed: new Set(snap.plan.consumed) };
    st.features = snap.columns.map(c => ({ name: c.name, type: { dtype: c.type } }));
    st.hasTools = !!st.plan.tools;
    st.index = { ready: snap.indexReady, progress: snap.progress, stage: snap.stage, rows: snap.indexedRows };
    S = st;
    remember(id, snap.config, snap.split);
    openExplorer();
    if (!st.index.ready) monitorIndex(st, ctl);
  } catch (e) {
    if (e.name === "AbortError") return;
    if (e.fallback) throw e;
    loadFail(step, e);
  }
}

// After the explorer opens, keep polling until the server has indexed every row.
async function monitorIndex(st, ctl) {
  while (S === st && !st.index.ready && !ctl.signal.aborted) {
    await sleep(900);
    try {
      const snap = await api.snapshot(st.src.sid, st.src.token, ctl.signal);
      if (S !== st) return;
      st.index = { ready: snap.indexReady, progress: snap.progress, stage: snap.stage, rows: snap.indexedRows, error: snap.error };
      if (snap.status === "error") { toast(`Indexing failed: ${snap.error}`); st.index.ready = false; setStatus(); return; }
    } catch (e) {
      if (e.name === "AbortError") return;
      if (e.status === 404 || e.status === 410) { sessionLost(); return; }
    }
    setStatus();
    if (!st.index.ready) renderFilters();
  }
  if (S === st && st.index.ready) { setStatus(); applyFilters({ resetSel: false }); }
}

async function openHF(id, wantConfig, wantSplit) {
  const ctl = loadCtl = new AbortController();
  const token = getToken();
  S = null;
  document.title = `${id} · Data Explorer`;
  loadUI(id, STEPS);
  let step = 0;
  try {
    setStep(0, "active");
    const splits = await getSplits(id, token, ctl.signal);
    const sp = pickSplit(splits, wantConfig, wantSplit);
    setStep(0, "done"); setStep(step = 1, "active");

    const first = await getRows(id, sp.config, sp.split, 0, PAGE_LEN, token, ctl.signal);
    const st = newState({ kind: "hf", id, config: sp.config, split: sp.split, token });
    st.splits = splits;
    st.total = first.total;
    st.partial = first.partial;
    st.features = first.features;
    st.plan = detectPlan(first.features, first.rows.map(r => r.row));
    S = st;
    ingest(first.rows, 0);
    setStep(1, "done"); setStep(step = 2, "active");

    const pages = pagesFor(Math.min(BLOCK_ROWS, st.total)).filter(o => !st.pages.has(o));
    setBar(1 / Math.max(1, pages.length + 1));
    await loadPages(pages, ctl.signal, (d, n) => setBar((d + 1) / (n + 1)));
    setStep(2, "done");
    if (ctl.signal.aborted) return;

    remember(id, sp.config, sp.split);
    openExplorer();
    // Keep going quietly so facets and search see more of the dataset.
    const more = pagesFor(Math.min(AUTO_ROWS, st.total)).filter(o => !st.pages.has(o));
    if (more.length) backgroundLoad(more, ctl);
  } catch (e) {
    if (e.name === "AbortError") return;
    loadFail(step, e);
  }
}

const pagesFor = n => Array.from({ length: Math.ceil(n / PAGE_LEN) }, (_, i) => i * PAGE_LEN);

function ingest(items, offset) {
  for (const it of items) {
    if (!S.byIdx.has(it.row_idx)) S.byIdx.set(it.row_idx, normalizeRow(S.plan, it, S.features));
  }
  S.pages.add(offset);
}

async function loadPages(offsets, signal, onProgress) {
  const st = S;
  let done = 0, failed = null, next = 0;
  const worker = async () => {
    while (next < offsets.length && !failed && !signal.aborted) {
      const off = offsets[next++];
      try {
        const d = await getRows(st.src.id, st.src.config, st.src.split, off, PAGE_LEN, st.src.token, signal);
        if (S !== st) return;
        ingest(d.rows, off);
      } catch (e) {
        if (e.name === "AbortError") return;
        failed = e;
        return;
      }
      onProgress?.(++done, offsets.length);
      if (S === st && !$("explorer").hidden) scheduleRefresh();
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, offsets.length) }, worker));
  if (failed) throw failed;
}

async function backgroundLoad(offsets, ctl = loadCtl) {
  const st = S;
  if (!ctl || st.busy) return;
  st.busy = true; st.error = "";
  setStatus();
  try {
    await loadPages(offsets, ctl.signal);
  } catch (e) {
    st.error = e.message;
    toast(`Stopped loading rows: ${e.message}`);
  }
  st.busy = false;
  if (S === st) { refresh(); setStatus(); }
}

// ---- opening local samples ---------------------------------------------------------------
async function openLocal(key) {
  const ctl = loadCtl = new AbortController();
  S = null;
  let title = key;
  document.title = `${key} · Data Explorer`;
  loadUI(key, ["Downloading rows", "Preparing the explorer"]);
  try {
    setStep(0, "active");
    const res = await fetch(`data/${key}.jsonl`, { signal: ctl.signal });
    if (!res.ok) throw new HFError(`No local file for "${key}". Run python prototype/build_data.py first.`);
    const len = +res.headers.get("content-length") || 0;
    const reader = res.body.getReader(), dec = new TextDecoder();
    let got = 0, text = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      got += value.length;
      text += dec.decode(value, { stream: true });
      if (len) setBar(got / len);
    }
    setStep(0, "done"); setStep(1, "active"); setBar(null);
    await new Promise(r => setTimeout(r, 0));
    const st = newState({ kind: "local", key });
    st.plan = { cols: [], feat: {}, consumed: new Set() };
    S = st;
    text.split("\n").filter(Boolean).forEach((l, i) => st.byIdx.set(i, normalizeLocal(JSON.parse(l), i)));
    st.total = st.byIdx.size;
    setStep(1, "done");
    openExplorer();
  } catch (e) {
    if (e.name === "AbortError") return;
    loadFail(0, e);
  }
}

// ---- explorer ------------------------------------------------------------------------------
function openExplorer() {
  const src = S.src;
  showView("explorer");
  $("explorer").dataset.pane = "list";
  const nm = $("ds-name");
  nm.textContent = src.kind === "local" ? `${src.key} (local)` : src.id;
  if (src.kind !== "local") nm.href = `https://huggingface.co/datasets/${src.id}`; else nm.removeAttribute("href");
  const sel = $("split-select");
  sel.hidden = S.splits.length < 2;
  const plain = new Set(S.splits.map(s => s.config)).size === 1;
  sel.innerHTML = S.splits.map((s, i) =>
    `<option value="${i}"${s.config === src.config && s.split === src.split ? " selected" : ""}>${esc(plain ? s.split : `${s.config} / ${s.split}`)}</option>`).join("");
  $("search").value = "";
  $("more-btn").hidden = S.local || S.remote;
  $("search").disabled = S.remote && !S.index.ready;
  if (S.remote) applyFilters({ resetSel: true }); else refresh({ resetSel: true });
  setStatus();
  $("list").focus({ preventScroll: true });
}

$("split-select").onchange = ev => {
  const s = S.splits[+ev.target.value];
  go(dsHash(S.src.id, s.config, s.split));
};

function setStatus() {
  if (!S) return;
  if (S.remote) {
    const ix = S.index, pct = Math.round((ix.progress || 0) * 100);
    $("status-spin").hidden = ix.ready;
    $("search").disabled = !ix.ready;
    $("search").placeholder = ix.ready ? "Search all rows" : "Search (after indexing)";
    $("status-text").textContent = `${fmt(S.total)} rows${S.partial ? " (partial dataset)" : ""}` +
      (ix.ready ? (ix.rows && ix.rows < S.total ? ` \u00b7 search covers the first ${fmt(ix.rows)}` : "") : ` \u00b7 ${ix.stage || "indexing"} ${pct}%`);
    return;
  }
  const n = S.views.length;
  $("status-spin").hidden = !S.busy;
  if (S.note) { $("status-spin").hidden = false; $("status-text").textContent = S.note; return; }
  $("status-text").textContent = S.local ? `${fmt(n)} rows`
    : `${fmt(n)} of ${fmt(S.total)} rows loaded${S.partial ? " (partial dataset)" : ""}${S.busy ? "…" : ""}`;
  $("more-btn").disabled = false;
}

function scheduleRefresh() {
  if (refreshTimer) return;
  refreshTimer = setTimeout(() => { refreshTimer = 0; if (S) { refresh(); setStatus(); } }, 250);
}

// Data changed: rebuild facets, then re-filter.
function refresh({ resetSel = false } = {}) {
  S.views = [...S.byIdx.values()].sort((a, b) => a.idx - b.idx);
  S.hasTools = S.views.some(v => v.tools.length > 0);
  S.defs = buildFacets(S.plan, S.views, S.local);
  for (const [key, set] of Object.entries(S.filters)) {
    const d = S.defs.find(x => x.key === key);
    if (!d) { delete S.filters[key]; continue; }
    for (const v of [...set]) if (!d.opts.some(o => o.v === v)) set.delete(v);
    if (!set.size) delete S.filters[key];
  }
  applyFilters({ resetSel });
}

function passes(v, key) {
  const set = S.filters[key], val = v.f[key];
  return Array.isArray(val) ? val.some(x => set.has(x)) : set.has(val);
}
function passesSearch(v) {
  if (S.matchRe) return S.matchRe.test(v._s);
  return !S.query || v._s.includes(S.query);
}

// Single pass: the filtered rows, plus facet counts that ignore each facet's own selection.
function applyFilters(opts = {}) {
  return S.remote ? applyRemote(opts) : applyLocal(opts);
}

const filtersBody = () => ({
  filters: Object.fromEntries(Object.entries(S.filters).map(([k, v]) => [k, [...v]])),
  q: S.matchRe ? S.rx : S.query, regex: !!S.matchRe,
});

async function applyRemote({ resetSel = false } = {}) {
  const id = ++S.reqId, st = S, body = filtersBody();
  const start = resetSel ? 0 : S.start;
  const filtered = !!body.q || Object.keys(S.filters).length > 0;
  try {
    const [page, fac] = await Promise.all([
      api.queryRows(S.src.sid, { ...body, offset: start, length: LIST_PAGE }, S.src.token),
      S.index.ready ? api.queryFacets(S.src.sid, body, S.src.token) : null,
    ]);
    if (id !== S.reqId || S !== st) return;
    S.count = page.total;
    S.base = filtered && S.index.rows ? S.index.rows : S.total;
    S.page = page.rows.map(it => normalizeRow(S.plan, it, S.features));
    S.start = start;
    if (fac) {
      S.defs = fac.defs.map(d => ({ key: d.key, label: d.label, opts: d.opts }));
      S.counts = Object.fromEntries(fac.defs.map(d => [d.key, new Map(d.opts.map(o => [o.v, o.n]))]));
    } else { S.defs = []; S.counts = {}; }
    if (resetSel || S.sel < start || S.sel >= start + S.page.length) S.sel = S.count ? start : -1;
    renderFilters(); renderList(); renderDetail();
  } catch (e) {
    if (e.name === "AbortError" || id !== S.reqId) return;
    if (e.status === 404 || e.status === 410) { sessionLost(); return; }
    toast(e.message);
  }
}

function applyLocal({ resetSel = false } = {}) {
  const keys = Object.keys(S.filters);
  const counts = Object.fromEntries(S.defs.map(d => [d.key, new Map()]));
  const bump = (key, val) => {
    const m = counts[key];
    if (!m || val === undefined) return;
    for (const x of Array.isArray(val) ? val : [val]) m.set(x, (m.get(x) || 0) + 1);
  };
  const prev = !resetSel && S.sel >= 0 ? S.filtered[S.sel] : null;
  const out = [];
  for (const v of S.views) {
    if (!passesSearch(v)) continue;
    let fails = 0, failKey = null;
    for (const k of keys) if (!passes(v, k)) { fails++; failKey = k; if (fails > 1) break; }
    if (fails === 0) { out.push(v); for (const d of S.defs) bump(d.key, v.f[d.key]); }
    else if (fails === 1) bump(failKey, v.f[failKey]);
  }
  S.filtered = out;
  S.counts = counts;
  S.sel = prev ? out.indexOf(prev) : -1;
  if (S.sel < 0 && out.length) S.sel = 0;
  if (resetSel || S.sel < 0) S.start = 0;
  else if (S.sel < S.start || S.sel >= S.start + LIST_PAGE) S.start = Math.floor(S.sel / LIST_PAGE) * LIST_PAGE;
  S.start = Math.min(S.start, Math.max(0, Math.floor((out.length - 1) / LIST_PAGE) * LIST_PAGE));
  S.count = out.length; S.base = S.views.length;
  S.page = out.slice(S.start, S.start + LIST_PAGE);
  renderFilters();
  renderList();
  renderDetail();
}

const ctx = () => ({
  sel: S.sel, searchRe: S.searchRe, hasTools: S.hasTools, plan: S.plan, tab: S.tab,
  pos: S.sel, count: S.count,
});
const cur = () => S.page[S.sel - S.start];

function renderFilters() {
  const active = Object.keys(S.filters).length + (S.query || S.matchRe ? 1 : 0);
  $("clear-all").hidden = !active;
  if (S.remote && !S.index.ready) {
    $("filters").innerHTML = `<div class="empty-filters"><span class="spinner sm"></span> ${esc(S.index.stage || "Indexing")} ${Math.round((S.index.progress || 0) * 100)}%. Filters and search appear when it finishes.</div>`;
    return;
  }
  if (!S.defs.length) {
    $("filters").innerHTML = `<div class="empty-filters">No filterable columns found in the loaded rows.</div>`;
    return;
  }
  $("filters").innerHTML = S.defs.map(d => {
    const m = S.counts[d.key];
    const sel = S.filters[d.key];
    const max = Math.max(1, ...d.opts.map(o => m.get(o.v) || 0));
    const open = S.expanded.has(d.key);
    const LIMIT = 10;
    let opts = d.opts;
    if (!open && opts.length > LIMIT) {
      opts = [...opts.slice(0, LIMIT), ...opts.slice(LIMIT).filter(o => sel?.has(o.v))];
    }
    const rows = opts.map(o => {
      const n = m.get(o.v) || 0, on = sel?.has(o.v);
      return `<div class="opt${on ? " on" : ""}${n ? "" : " zero"}" data-k="${esc(d.key)}" data-v="${esc(o.v)}" role="checkbox" aria-checked="${!!on}" tabindex="0">
        <span class="bar-fill" style="width:${Math.round(n / max * 100)}%"></span>
        <span class="lbl" title="${esc(o.label)}">${esc(o.label)}</span><span class="n">${fmt(n)}</span></div>`;
    }).join("");
    const toggle = d.opts.length > LIMIT
      ? `<button class="link-btn more-opts" data-more="${esc(d.key)}">${open ? "Show fewer" : `Show all ${d.opts.length}`}</button>` : "";
    return `<div class="group"><h3>${esc(d.label)}</h3>${rows}${toggle}</div>`;
  }).join("");
}

function renderList() {
  const total = S.count, start = S.start, end = Math.min(start + LIST_PAGE, total);
  const filtering = total !== S.base;
  const pager = total > LIST_PAGE ? `<span class="pages"><button id="pg-prev" ${start ? "" : "disabled"} aria-label="Previous page">&lsaquo;</button>
    <span>${fmt(start + 1)}&ndash;${fmt(end)}</span><button id="pg-next" ${end < total ? "" : "disabled"} aria-label="Next page">&rsaquo;</button></span>` : "";
  $("list-head").innerHTML = `<span><b>${fmt(total)}</b>${filtering ? ` of ${fmt(S.base)}` : ""} rows</span>${pager}
    <button class="mobile-only" id="show-filters">Filters</button>`;
  if (!total) {
    const any = Object.keys(S.filters).length || S.query || S.matchRe;
    $("list").innerHTML = `<div class="empty"><b>No rows match</b>${any ? `Try removing a filter or changing the search.<br><br><button id="empty-clear">Clear all</button>` : "This split has no rows."}</div>`;
    return;
  }
  const c = ctx();
  $("list").innerHTML = S.page.map((v, k) => renderListItem(v, start + k, c)).join("");
}

function renderDetail() {
  const el = $("detail");
  document.querySelectorAll(".tab").forEach(t => t.classList.toggle("on", t.dataset.tab === S.tab));
  const none = S.sel < 0;
  $("copy").disabled = $("prev").disabled = $("next").disabled = none;
  if (none) { renderedDetail = null; el.innerHTML = `<div class="empty">Select a row to see it here.</div>`; return; }
  const v = cur();
  if (!v) { el.innerHTML = `<div class="empty">Loading row\u2026</div>`; return; }
  if (v === renderedDetail && el.dataset.tab === S.tab) {
    const p = el.querySelector(".pos");
    if (p) p.textContent = `${fmt(S.sel + 1)} of ${fmt(S.count)}`;
    return;
  }
  renderedDetail = v;
  el.dataset.tab = S.tab;
  el.innerHTML = renderRow(v, ctx());
  el.scrollTop = 0;
}

async function goPage(start) {
  if (!S.remote) { S.start = start; S.page = S.filtered.slice(start, start + LIST_PAGE); return; }
  const id = ++S.reqId, st = S;
  try {
    const page = await api.queryRows(S.src.sid, { ...filtersBody(), offset: start, length: LIST_PAGE }, S.src.token);
    if (id !== S.reqId || S !== st) return false;
    S.count = page.total;
    S.page = page.rows.map(it => normalizeRow(S.plan, it, S.features));
    S.start = start;
  } catch (e) { toast(e.message); return false; }
}

async function select(i, { pane = false } = {}) {
  if (i < 0 || i >= S.count) return;
  if (i < S.start || i >= S.start + LIST_PAGE) {
    if ((await goPage(Math.floor(i / LIST_PAGE) * LIST_PAGE)) === false) return;
    S.sel = i;
    renderList();
  } else {
    const old = $("list").querySelector(".item.sel");
    S.sel = i;
    old?.classList.remove("sel");
    $("list").querySelector(`.item[data-i="${i}"]`)?.classList.add("sel");
  }
  $("list").querySelector(".item.sel")?.scrollIntoView({ block: "nearest" });
  renderDetail();
  if (pane) $("explorer").dataset.pane = "detail";
}

// ---- events -------------------------------------------------------------------------------------
function toggleFilter(key, val) {
  const set = S.filters[key] || (S.filters[key] = new Set());
  set.has(val) ? set.delete(val) : set.add(val);
  if (!set.size) delete S.filters[key];
  applyFilters({ resetSel: true });
}
function clearAll() {
  S.filters = {};
  $("search").value = "";
  setQuery("");
  applyFilters({ resetSel: true });
}

$("filters").addEventListener("click", ev => {
  const more = ev.target.closest("[data-more]");
  if (more) {
    const k = more.dataset.more;
    S.expanded.has(k) ? S.expanded.delete(k) : S.expanded.add(k);
    renderFilters();
    return;
  }
  const o = ev.target.closest(".opt");
  if (o) toggleFilter(o.dataset.k, o.dataset.v);
});
$("filters").addEventListener("keydown", ev => {
  if ((ev.key === " " || ev.key === "Enter") && ev.target.classList.contains("opt")) {
    ev.preventDefault();
    toggleFilter(ev.target.dataset.k, ev.target.dataset.v);
  }
});
$("clear-all").onclick = clearAll;

$("list").addEventListener("click", ev => {
  const it = ev.target.closest(".item");
  if (it) select(+it.dataset.i, { pane: true });
  if (ev.target.id === "empty-clear") clearAll();
});
$("list-head").addEventListener("click", ev => {
  const b = ev.target.closest("button");
  if (!b) return;
  const dir = b.id === "pg-prev" ? -1 : b.id === "pg-next" ? 1 : 0;
  if (dir) goPage(Math.max(0, S.start + dir * LIST_PAGE)).then(r => { if (r !== false) { S.sel = S.start; renderList(); renderDetail(); $("list").scrollTop = 0; } });
  if (b.id === "show-filters") $("explorer").dataset.pane = "filters";
});

function setQuery(raw) {
  const v = raw.trim();
  S.query = ""; S.matchRe = null; S.searchRe = null; S.regexBad = false; S.rx = "";
  const m = v.match(/^\/(.+)\/$/);
  if (m) {
    try { S.matchRe = new RegExp(m[1], "i"); S.searchRe = new RegExp(m[1], "gi"); S.rx = m[1]; }
    catch { S.regexBad = true; }
  } else if (v) {
    S.query = v.toLowerCase();
    S.searchRe = new RegExp(v.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi");
  }
  $("search-clear").hidden = !v;
  $("search-kbd").hidden = !!v;
  const note = $("search-note");
  note.classList.toggle("bad", S.regexBad);
  note.innerHTML = S.regexBad ? "Not a valid regular expression" : `Plain text, or <code>/regex/</code>`;
}
let searchTimer;
$("search").addEventListener("input", ev => {
  clearTimeout(searchTimer);
  const val = ev.target.value;
  searchTimer = setTimeout(() => { setQuery(val); applyFilters({ resetSel: true }); }, 180);
  $("search-clear").hidden = !val.trim();
  $("search-kbd").hidden = !!val.trim();
});
$("search-clear").onclick = () => { $("search").value = ""; setQuery(""); applyFilters({ resetSel: true }); $("search").focus(); };

const randomRow = () => { if (S?.count) select(Math.floor(Math.random() * S.count), { pane: true }); };
$("random").onclick = randomRow;
$("prev").onclick = () => select(S.sel - 1);
$("next").onclick = () => select(S.sel + 1);
$("hide-filters").onclick = () => { $("explorer").dataset.pane = "list"; };
$("back-list").onclick = () => { $("explorer").dataset.pane = "list"; };
$("copy").onclick = async () => {
  const v = cur();
  if (!v) return;
  try { await navigator.clipboard.writeText(JSON.stringify(v.raw, null, 2)); toast("Row copied as JSON"); }
  catch { toast("Could not copy"); }
};
document.querySelector(".tabs").addEventListener("click", ev => {
  const t = ev.target.closest(".tab");
  if (t && S) { S.tab = t.dataset.tab; renderDetail(); }
});

// Load more menu
function openMenu() {
  const left = Math.max(0, S.total - S.views.length), pending = S.busy;
  const item = (id, title, sub, off) => `<button role="menuitem" data-act="${id}" ${off ? "disabled" : ""}>${esc(title)}<span class="sub">${esc(sub)}</span></button>`;
  $("more-menu").innerHTML = left === 0 && !pending
    ? `<div class="none">All ${fmt(S.total)} rows are loaded.</div>`
    : [
      pending ? item("stop", "Stop loading", "Keep the rows loaded so far", false) : "",
      item("more", `Load ${fmt(Math.min(MORE_ROWS, left))} more rows`, "The next rows in order", pending || !left),
      item("all", `Load all ${fmt(left)} remaining rows`, `${fmt(Math.ceil(left / PAGE_LEN))} requests to Hugging Face`, pending || !left),
      item("sample", `Random sample of ${fmt(Math.min(1000, left))} rows`, "Spread across the whole dataset", pending || !left),
    ].join("");
  $("more-menu").hidden = false;
  $("more-btn").setAttribute("aria-expanded", "true");
}
function closeMenu() { $("more-menu").hidden = true; $("more-btn").setAttribute("aria-expanded", "false"); }
$("more-btn").onclick = ev => { ev.stopPropagation(); $("more-menu").hidden ? openMenu() : closeMenu(); };
document.addEventListener("click", ev => { if (!ev.target.closest(".menu-wrap")) closeMenu(); });
$("more-menu").addEventListener("click", ev => {
  const b = ev.target.closest("button[data-act]");
  if (!b) return;
  closeMenu();
  const todo = pagesFor(S.total).filter(o => !S.pages.has(o));
  const act = b.dataset.act;
  if (act === "stop") { cancelLoad(); loadCtl = new AbortController(); S.busy = false; setStatus(); return; }
  if (!loadCtl) loadCtl = new AbortController();
  if (act === "more") backgroundLoad(todo.slice(0, MORE_ROWS / PAGE_LEN));
  if (act === "all") {
    if (todo.length > 300 && !confirm(`This makes ${todo.length} requests and may take a while. Continue?`)) return;
    backgroundLoad(todo);
  }
  if (act === "sample") {
    const pick = [...todo].sort(() => Math.random() - .5).slice(0, 10);
    backgroundLoad(pick);
  }
});

// Theme
function toggleTheme() {
  const dark = document.documentElement.dataset.theme
    ? document.documentElement.dataset.theme === "dark"
    : matchMedia("(prefers-color-scheme: dark)").matches;
  const next = dark ? "light" : "dark";
  document.documentElement.dataset.theme = next;
  store.set("dx.theme", next);
}
document.querySelectorAll("[data-theme-toggle]").forEach(b => b.addEventListener("click", toggleTheme));

// Keyboard
document.addEventListener("keydown", ev => {
  if (ev.key === "Escape") { closeMenu(); document.activeElement?.blur?.(); return; }
  if (!S || $("explorer").hidden) return;
  const tag = document.activeElement?.tagName;
  if (["INPUT", "SELECT", "TEXTAREA"].includes(tag) || ev.metaKey || ev.ctrlKey || ev.altKey) return;
  if (ev.target.classList?.contains("opt") && ev.key === " ") return;
  switch (ev.key) {
    case "j": case "ArrowDown": select(S.sel + 1); break;
    case "k": case "ArrowUp": select(S.sel - 1); break;
    case "r": randomRow(); break;
    case "/": $("search").focus(); break;
    default: return;
  }
  ev.preventDefault();
});

function toast(msg) {
  const t = $("toast");
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 2600);
}

// Finish an OAuth sign-in first (the redirect lands on ?code=...), then route.
handleRedirect().catch(e => toast(e.message)).finally(route);
