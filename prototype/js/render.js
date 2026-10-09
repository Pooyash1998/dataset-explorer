// HTML renderers for one row. Everything returns strings; app.js owns the DOM and events.
import { tryJson } from "./schema.js";

export const esc = s => String(s ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
export const fmt = n => Number(n).toLocaleString("en-US");

// Escape text and wrap regex matches in <mark>. The regex must be global.
export function highlight(text, re) {
  text = String(text ?? "");
  if (!re) return esc(text);
  let out = "", last = 0, m;
  re.lastIndex = 0;
  while ((m = re.exec(text))) {
    if (!m[0]) { re.lastIndex++; continue; }
    out += esc(text.slice(last, m.index)) + `<mark>${esc(m[0])}</mark>`;
    last = m.index + m[0].length;
  }
  return out + esc(text.slice(last));
}

const isObj = v => v && typeof v === "object" && !Array.isArray(v);
const pretty = v => (typeof v === "string" ? v : JSON.stringify(v, null, 2));

function jsonBlock(v) {
  const s = esc(pretty(v));
  return `<pre class="json">${s.replace(
    /(&quot;(?:\\.|[^&\\])*?&quot;)(\s*:)?|\b(true|false|null)\b|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/g,
    (m, str, colon, lit, num) => str ? (colon ? `<span class="jk">${str}</span>${colon}` : `<span class="js">${str}</span>`)
      : lit ? `<span class="jl">${lit}</span>` : `<span class="jn">${num}</span>`)}</pre>`;
}

function renderArgs(args) {
  if (isObj(args) && Object.keys(args).length) {
    return `<div class="args">${Object.entries(args).map(([k, v]) => `<div class="arg"><code class="ak">${esc(k)}</code>
      <span class="av">${typeof v === "string" ? esc(v) : esc(JSON.stringify(v))}</span></div>`).join("")}</div>`;
  }
  if (isObj(args)) return `<div class="muted small">no arguments</div>`;
  return jsonBlock(args);
}

function renderCall(c, i) {
  return `<div class="call"><div class="call-head"><span class="ico">fn</span><b>${esc(c.name || "(unnamed call)")}</b>${i != null ? `<span class="muted small">call ${i}</span>` : ""}</div>${renderArgs(c.args)}</div>`;
}

function renderSegs(segs, hl) {
  let n = 0;
  return segs.map(s => {
    if (s.t === "text") return `<div class="txt">${highlight(s.v, hl)}</div>`;
    if (s.t === "think") return `<details class="think"><summary>thinking</summary><div class="txt">${highlight(s.v, hl)}</div></details>`;
    if (s.t === "call") return renderCall(s, ++n);
    if (s.t === "result") return typeof s.v === "string" ? `<div class="txt">${highlight(s.v, hl)}</div>` : jsonBlock(s.v);
    return "";
  }).join("");
}

function renderTurn(t, hl) {
  let body = renderSegs(t.segs, hl) || `<span class="muted">(empty)</span>`;
  const len = t.segs.reduce((n, s) => n + (typeof s.v === "string" ? s.v.length : 0), 0);
  if (t.role === "system" && len > 600) {
    const first = (t.segs.find(s => s.t === "text")?.v || "").replace(/\s+/g, " ").trim().slice(0, 180);
    body = `<details class="long"><summary><span class="muted">${esc(first)}\u2026</span> <span class="more">show all ${fmt(len)} characters</span></summary>${body}</details>`;
  }
  return `<div class="msg ${esc(t.role)}"><div class="role">${esc(t.role)}</div><div class="mbody">${body}</div></div>`;
}

function renderTool(t, overlapRe, open) {
  const params = t.params.map(p => `<div class="param">
    <div class="pline"><code>${esc(p.name)}</code><span class="ptype">${esc(p.type)}</span>${p.required ? `<span class="req">required</span>` : ""}
    ${p.default !== null ? `<span class="def">default ${esc(p.default)}</span>` : ""}</div>
    ${p.enum ? `<div class="enum">${p.enum.map(e => `<span class="chip">${esc(e)}</span>`).join("")}</div>` : ""}
    ${p.desc ? `<div class="pdesc">${highlight(p.desc, overlapRe)}</div>` : ""}</div>`).join("");
  const short = t.description.length > 140 ? t.description.slice(0, 140) + "…" : t.description;
  return `<details class="tool"${open ? " open" : ""}><summary><b>${highlight(t.name, overlapRe)}</b>
    <span class="muted tdesc">${highlight(short, overlapRe)}</span><span class="np">${t.params.length} param${t.params.length === 1 ? "" : "s"}</span></summary>
    <div class="tbody">${t.description ? `<div class="txt">${highlight(t.description, overlapRe)}</div>` : ""}
    ${params || `<div class="muted small">no parameters</div>`}</div></details>`;
}

function renderValue(v, feat) {
  const type = feat?._type;
  if (v === null || v === undefined) return `<span class="muted">null</span>`;
  if (type === "Image" && v.src) return `<img class="media" loading="lazy" src="${esc(v.src)}" alt="">`;
  if (type === "Audio" && v[0]?.src) return `<audio controls src="${esc(v[0].src)}"></audio>`;
  if (typeof v === "string") {
    const j = tryJson(v);
    if (j !== v) return jsonBlock(j);
    return `<div class="txt scroll">${esc(v)}</div>`;
  }
  if (typeof v === "object") return jsonBlock(v);
  return `<code>${esc(v)}</code>`;
}

export function overlapRegex(view) {
  const text = view.turns.filter(t => t.role === "user").map(t => t.segs.filter(s => s.t === "text").map(s => s.v).join(" ")).join(" ");
  const ws = [...new Set(text.toLowerCase().match(/[a-z]{4,}/g) || [])].slice(0, 80);
  return ws.length ? new RegExp(`\\b(?:${ws.join("|")})\\b`, "gi") : null;
}

export function renderRow(v, ctx) {
  const hl = ctx.searchRe;
  const ov = v.tools.length ? overlapRegex(v) : null;
  const chips = [
    v.tools.length || ctx.hasTools ? `<span class="chip">${v.n_tools} tool${v.n_tools === 1 ? "" : "s"}</span>` : "",
    v.calls.length ? `<span class="chip is-call">${v.calls.length} call${v.calls.length === 1 ? "" : "s"}</span>` : "",
    v.expect ? `<span class="chip ${v.expect === "no_call" ? "ok" : "is-call"}">label: ${esc(v.expect.replace("_", " "))}</span>` : "",
  ].join("");

  const head = `<div class="dhead"><span class="rowid">#${esc(v.id ?? v.idx)}</span>${chips}
    <span class="muted small pos">${fmt(ctx.pos + 1)} of ${fmt(ctx.count)}</span></div>
    ${v.trunc ? `<div class="notice">Some cells were truncated by Hugging Face (${esc(v.trunc.join(", "))}).</div>` : ""}`;

  if (ctx.tab === "raw") return head + jsonBlock(v.raw);

  const parts = [];
  if (v.turns.length) parts.push(`<h2>Conversation</h2>${v.turns.map(t => renderTurn(t, hl)).join("")}`);
  for (const r of v.responses) {
    parts.push(`<h2>${esc(r.label.replace(/_/g, " "))}</h2><div class="msg answer"><div class="mbody">${renderSegs(r.segs, hl)}</div></div>`);
  }
  if (ctx.plan?.calls) {
    parts.push(`<h2>${esc(ctx.plan.calls.replace(/_/g, " "))}</h2>${v.callCol.length
      ? v.callCol.map((c, i) => renderCall(c, i + 1)).join("") : `<div class="muted">No tool calls (empty).</div>`}`);
  }
  if (v.tools.length) {
    parts.push(`<h2>Tools offered <span class="count">${v.tools.length}</span></h2>${v.tools.map(t => renderTool(t, ov, v.tools.length <= 3)).join("")}`);
  } else if (ctx.hasTools) parts.push(`<h2>Tools offered</h2><div class="muted">No tools offered.</div>`);
  if (v.extras.length) {
    parts.push(`<h2>${parts.length ? "Other fields" : "Fields"}</h2><div class="kv">${v.extras.map(([k, val, f]) =>
      `<div class="k">${esc(k)}</div><div class="v">${renderValue(val, f)}</div>`).join("")}</div>`);
  }
  return head + parts.join("");
}

export function renderListItem(v, i, ctx) {
  const q = highlight(v.preview, ctx.searchRe) || `<span class="muted">(empty)</span>`;
  const badges = [];
  if (v.expect) badges.push(`<span class="chip ${v.expect === "no_call" ? "ok" : "is-call"}">${esc(v.expect.replace("_", " "))}</span>`);
  if (v.calls.length) badges.push(`<span class="chip is-call">${v.calls.length} call${v.calls.length === 1 ? "" : "s"}</span>`);
  if (ctx.hasTools) badges.push(`<span class="muted">${v.n_tools} tool${v.n_tools === 1 ? "" : "s"}</span>`);
  return `<div class="item${i === ctx.sel ? " sel" : ""}" data-i="${i}" role="option">
    <div class="q">${q}</div><div class="meta"><span class="rid">#${esc(v.id ?? v.idx)}</span>${badges.join("")}</div></div>`;
}
