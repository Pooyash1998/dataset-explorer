// Schema detection and row normalization. Raw rows from any dataset are turned into one "view" shape:
//   { idx, raw, turns, responses, calls, tools, extras, preview, f, _s }
// so the renderer and facets never care where the data came from.

const MSG_NAMES = ["messages", "conversations", "conversation", "chat", "dialog", "dialogue", "turns", "history", "question"];
const TOOL_NAMES = ["tools", "functions", "function", "available_tools", "tool_list"];
const CALL_NAMES = ["answers", "answer", "tool_calls", "calls", "function_call", "function_calls", "ground_truth"];
const QUERY_NAMES = ["query", "question", "prompt", "instruction", "input", "user", "user_query"];
const SYSTEM_NAMES = ["system", "system_prompt", "system_message"];
const RESPONSE_NAMES = ["chosen_response", "rejected_response", "chosen", "rejected", "response", "output", "completion",
  "target", "answer", "reply"];

export const STOP = new Set(("the a an and or of to for in on at by with from is are be can you me my your i it " +
  "this that what how please get find give tell about show which who when where would like want need").split(" "));
const REFUSE_RE = /\b(unable|can't|cannot|can not|not able|don't have|do not have|beyond|outside|not possible|isn't possible|not available|limited to|only (?:able|designed|capable))\b/i;

const ROLE_MAP = {
  human: "user", user: "user", gpt: "assistant", assistant: "assistant", model: "assistant", bot: "assistant",
  system: "system", tool: "tool", function: "tool", observation: "tool", ipython: "tool", function_response: "tool",
  tool_response: "tool",
};

// Python-style literals ('single quotes', True/False/None, trailing commas) rewritten as JSON. null if it is not one.
function pyToJson(t) {
  let out = "", i = 0;
  const n = t.length;
  while (i < n) {
    const c = t[i];
    if (c === '"' || c === "'") {
      let j = i + 1, str = "";
      while (j < n && t[j] !== c) {
        if (t[j] === "\\" && j + 1 < n) {
          const e = t[j + 1];
          if (e === "n") str += "\n"; else if (e === "t") str += "\t"; else if (e === "r") str += "\r";
          else if (e === "u" && /^[0-9a-fA-F]{4}$/.test(t.slice(j + 2, j + 6))) { str += String.fromCharCode(parseInt(t.slice(j + 2, j + 6), 16)); j += 4; }
          else str += e;
          j += 2;
        } else str += t[j++];
      }
      if (j >= n) return null;
      out += JSON.stringify(str);
      i = j + 1;
    } else if (c === "," ) {
      // drop a trailing comma
      const m = t.slice(i + 1).match(/^\s*([\]}])/);
      if (!m) out += c;
      i++;
    } else if (/[A-Za-z_]/.test(c)) {
      let j = i;
      while (j < n && /[\w.]/.test(t[j])) j++;
      const w = t.slice(i, j);
      out += w === "True" ? "true" : w === "False" ? "false" : w === "None" ? "null" : w;
      i = j;
    } else { out += c; i++; }
  }
  return out;
}

// JSON.parse that also copes with Python-style literals and literal "\n" around the value. undefined if hopeless.
export function looseParse(v) {
  if (typeof v !== "string") return v;
  let t = v.trim();
  try { return JSON.parse(t); } catch {}
  t = t.replace(/^(?:\\[nrt]|\s)+|(?:\\[nrt]|\s)+$/g, "");
  if (!(t.startsWith("{") || t.startsWith("["))) return undefined;
  try { return JSON.parse(t); } catch {}
  const j = pyToJson(t);
  if (j == null) return undefined;
  try { return JSON.parse(j); } catch { return undefined; }
}

export const tryJson = v => {
  if (typeof v !== "string") return v;
  const s = v.trim().replace(/^(?:\\[nrt]|\s)+/, "");
  if (!(s.startsWith("{") || s.startsWith("["))) return v;
  const j = looseParse(s);
  return j === undefined ? v : j;
};
const asList = v => {
  v = tryJson(v);
  if (Array.isArray(v)) return v.map(tryJson);
  return v && typeof v === "object" ? [v] : null;
};
const isObj = v => v && typeof v === "object" && !Array.isArray(v);
const words = s => new Set((String(s).toLowerCase().match(/[a-z]{4,}/g) || []).filter(w => !STOP.has(w)));

// ---- shape tests ----------------------------------------------------------
const isMsg = m => isObj(m) && ("role" in m || "from" in m) && ("content" in m || "value" in m || "text" in m || "tool_calls" in m);
function isMessages(v) {
  const l = asList(v);
  if (!l || !l.length) return false;
  if (l.every(Array.isArray)) return l.every(x => x.length && x.every(isMsg)); // BFCL: list of turns
  return l.every(isMsg);
}
const isToolDef = t => {
  t = isObj(t?.function) ? t.function : t;
  return isObj(t) && typeof t.name === "string" && !("arguments" in t) && ("description" in t || "parameters" in t);
};
const isCall = c => {
  if (!isObj(c)) return false;
  if (isObj(c.function) && "name" in c.function) return true;
  if (typeof c.name === "string" && ("arguments" in c || "parameters" in c || "args" in c) && !("description" in c)) return true;
  const k = Object.keys(c);
  return k.length === 1 && isObj(c[k[0]]);
};
const shapeOf = v => {
  if (v === null || v === undefined) return null;
  const j = tryJson(v);
  if (typeof j === "string") return "string";
  if (typeof j === "number") return "number";
  if (typeof j === "boolean") return "bool";
  if (Array.isArray(j) && !j.length) return "empty";
  if (Array.isArray(j) || isObj(j)) {
    if (isMessages(j)) return "messages";
    const l = asList(j);
    if (l?.length && l.every(isToolDef)) return "tools";
    if (l?.length && l.every(isCall)) return "calls";
    return Array.isArray(j) ? "list" : "object";
  }
  return null;
};

// ---- plan: which column plays which role ------------------------------------
export function detectPlan(features, sampleRows) {
  const cols = features.map(f => f.name);
  const feat = Object.fromEntries(features.map(f => [f.name, f.type]));
  const shapes = {};
  for (const c of cols) {
    const count = {};
    for (const r of sampleRows.slice(0, 30)) {
      const s = shapeOf(r[c]);
      if (s) count[s] = (count[s] || 0) + 1;
    }
    // Empty lists carry no shape, so a column that is sometimes empty keeps its real shape.
    const { empty, ...rest } = count;
    shapes[c] = Object.entries(rest).sort((a, b) => b[1] - a[1])[0]?.[0] || (empty ? "list" : null);
  }
  const pick = (shape, names, skip = []) => {
    const ok = cols.filter(c => shapes[c] === shape && !skip.includes(c));
    return names.find(n => ok.includes(n)) || ok[0] || null;
  };
  const plan = { cols, feat, shapes };
  plan.messages = pick("messages", MSG_NAMES);
  plan.tools = pick("tools", TOOL_NAMES);
  plan.calls = pick("calls", CALL_NAMES);
  // A calls column that is empty in every sampled row (irrelevance sets) still marks "no call expected".
  if (!plan.calls) plan.calls = CALL_NAMES.find(n => shapes[n] === "list"
    && sampleRows.every(r => !asList(r[n])?.length)) || null;
  plan.alt = cols.filter(c => shapes[c] === "messages" && c !== plan.messages);
  const strCols = cols.filter(c => shapes[c] === "string");
  plan.transcript = !plan.messages && strCols.find(c => sampleRows.slice(0, 20).some(r => TRANSCRIPT_RE.test(String(r[c] ?? "")))) || null;
  const used = () => [plan.messages, plan.transcript, plan.tools, plan.calls, plan.query, plan.system, ...plan.alt,
    ...(plan.responses || [])].filter(Boolean);
  if (!plan.messages && !plan.transcript) plan.query = QUERY_NAMES.find(n => strCols.includes(n)) || null;
  plan.system = SYSTEM_NAMES.find(n => strCols.includes(n) && n !== plan.query) || null;
  plan.responses = RESPONSE_NAMES.filter(n => strCols.includes(n) && n !== plan.query && !used().includes(n)
    && n !== plan.system);
  plan.consumed = new Set(used());
  plan.hasChat = !!(plan.messages || plan.transcript || plan.query);
  return plan;
}

// ---- content parsing ---------------------------------------------------------
const TRANSCRIPT_RE = /(?:^|\n)\s*(?:USER|ASSISTANT|HUMAN):\s/;
const SPEAKER_RE = /(?:^|\n)\s*(USER|ASSISTANT|HUMAN|SYSTEM|FUNCTION RESPONSE|TOOL):\s*/g;
const TAG_RE = /<(TOOLCALL|tool_calls?|function_calls?|think|thinking|reasoning|tool_response|tool_result|function_response|observation)>([\s\S]*?)(?:<\/\1>|$)/gi;
const RESULT_TAGS = new Set(["tool_response", "tool_result", "function_response", "observation"]);
const THINK_TAGS = new Set(["think", "thinking", "reasoning"]);

// Some datasets store newlines as the two characters backslash and n. Show them as line breaks.
export function cleanText(t) {
  if (typeof t !== "string" || !t.includes("\\")) return t;
  const lit = (t.match(/\\n/g) || []).length;
  if (!lit || lit <= (t.match(/\n/g) || []).length) return t;
  return t.replace(/\\r\\n|\\n/g, "\n").replace(/\\t/g, "\t").replace(/\\"/g, '"');
}

export function normCall(c) {
  c = tryJson(c);
  if (!isObj(c)) return { name: "", args: c, raw: c };
  const f = isObj(c.function) ? c.function : c;
  let name = f.name, args = f.arguments ?? f.parameters ?? f.args;
  // Malformed rows sometimes nest the name inside the arguments: {"arguments": {..., "name": "f"}}
  if (name === undefined && isObj(args) && typeof args.name === "string") {
    name = args.name;
    args = Object.fromEntries(Object.entries(args).filter(([k]) => k !== "name"));
  }
  if (name === undefined) {
    const k = Object.keys(c);
    if (k.length === 1 && !["arguments", "parameters", "args"].includes(k[0])) { name = k[0]; args = c[k[0]]; }
  }
  return { name: String(name ?? ""), args: tryJson(args ?? {}), raw: c };
}

function callsFrom(v) {
  const l = asList(v);
  return l ? l.filter(x => isObj(x)).map(normCall) : [];
}

// Glaive: <functioncall> {"name": "f", "arguments": '{"a": 1}'}
function glaiveCall(body) {
  const j = tryJson(body);
  if (isObj(j)) return normCall(j);
  const name = body.match(/"name":\s*"([^"]+)"/)?.[1];
  const args = body.match(/"arguments":\s*'([\s\S]*)'\s*}\s*$/)?.[1];
  return name ? { name, args: tryJson(args ?? "{}"), raw: body } : null;
}
const GLAIVE_RE = /<functioncall>\s*(\{[\s\S]*?\})\s*(?=<\|endoftext\|>|$)/g;

// "USER: ... ASSISTANT: ..." transcripts into message-like turns.
function transcriptTurns(text) {
  const parts = String(text).replace(/<\|endoftext\|>/g, "").split(SPEAKER_RE);
  const out = [];
  for (let i = 1; i < parts.length; i += 2) out.push({ role: parts[i].toLowerCase().replace("function response", "tool").replace("human", "user"), content: parts[i + 1].trim() });
  return out;
}

// Split text into text / think / call / result segments.
export function segments(text, inner = false) {
  const out = [];
  let last = 0, m;
  text = String(text ?? "");
  if (!inner && text.includes("<functioncall>")) {
    const segsOut = [];
    let at = 0;
    GLAIVE_RE.lastIndex = 0;
    while ((m = GLAIVE_RE.exec(text))) {
      const c = glaiveCall(m[1]);
      if (m.index > at) segsOut.push(...segments(text.slice(at, m.index), true));
      segsOut.push(c ? { t: "call", ...c } : { t: "text", v: m[0] });
      at = GLAIVE_RE.lastIndex;
    }
    if (at < text.length) segsOut.push(...segments(text.slice(at), true));
    return segsOut;
  }
  TAG_RE.lastIndex = 0;
  while ((m = TAG_RE.exec(text))) {
    if (m.index > last) out.push({ t: "text", v: text.slice(last, m.index) });
    const tag = m[1].toLowerCase(), body = m[2].trim();
    if (THINK_TAGS.has(tag)) out.push({ t: "think", v: cleanText(body) });
    else if (RESULT_TAGS.has(tag)) out.push({ t: "result", v: tryJson(cleanText(body)) });
    else {
      const calls = callsFrom(body);
      if (calls.length) calls.forEach(c => out.push({ t: "call", ...c }));
      else out.push({ t: "badcall", v: cleanText(body) });
    }
    last = TAG_RE.lastIndex;
    if (m[0] === "") TAG_RE.lastIndex++;
  }
  if (last < text.length) out.push({ t: "text", v: text.slice(last) });
  return out.map(s => (s.t === "text" ? { ...s, v: cleanText(s.v) } : s)).filter(s => s.t !== "text" || s.v.trim());
}

function contentText(c) {
  if (typeof c === "string") return c;
  if (Array.isArray(c)) return c.map(p => (typeof p === "string" ? p : p?.text ?? "")).filter(Boolean).join("\n");
  return c == null ? "" : JSON.stringify(c);
}

function normTurn(m) {
  const roleRaw = String(m.role ?? m.from ?? "").toLowerCase();
  const role = ROLE_MAP[roleRaw] || roleRaw || "unknown";
  const raw = contentText(m.content ?? m.value ?? m.text);
  let segs = role === "tool" ? [{ t: "result", v: tryJson(cleanText(raw)) }]
    : role === "system" ? [{ t: "text", v: cleanText(raw) }]
    : segments(raw);
  if (m.tool_calls) callsFrom(m.tool_calls).forEach(c => segs.push({ t: "call", ...c }));
  if (m.function_call) segs.push({ t: "call", ...normCall(m.function_call) });
  return { role, segs };
}

// ---- tools -------------------------------------------------------------------
function normParams(p) {
  p = tryJson(p);
  if (!isObj(p)) return [];
  if (isObj(p.properties)) {
    const req = new Set(p.required || []);
    return Object.entries(p.properties).filter(([, v]) => isObj(v)).map(([k, v]) => paramRow(k, v, req.has(k)));
  }
  // xLAM style: {"city": {"type": "str, optional", "default": ...}}
  return Object.entries(p).filter(([, v]) => isObj(v)).map(([k, v]) => {
    const typ = String(v.type ?? "");
    const hasDefault = "default" in v && v.default !== null && v.default !== "";
    return paramRow(k, v, !/optional/i.test(typ) && !hasDefault);
  });
}
function paramRow(name, v, required) {
  const type = Array.isArray(v.type) ? v.type.join(" | ") : isObj(v.type) ? JSON.stringify(v.type) : String(v.type ?? "");
  return {
    name, type, required,
    default: "default" in v ? JSON.stringify(v.default) : null,
    desc: String(v.description ?? ""),
    enum: Array.isArray(v.enum) ? v.enum.map(String) : null,
  };
}
export function normTool(t) {
  t = tryJson(t);
  if (isObj(t?.function)) t = t.function;
  if (!isObj(t)) return null;
  const params = normParams(t.parameters);
  const extraReq = new Set(Array.isArray(t.required) ? t.required : []);
  params.forEach(p => { if (extraReq.has(p.name)) p.required = true; });
  return { name: String(t.name ?? ""), description: String(t.description ?? ""), params };
}

// ---- tools written into a system prompt ----------------------------------------
// Glaive, ToolACE and Hermes put the function definitions in the system prompt as JSON. Find them there.
function balanced(text, start) {
  const open = text[start], close = open === "{" ? "}" : "]";
  let depth = 0, inStr = false, q = "";
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (inStr) {
      if (c === "\\") i++;
      else if (c === q) inStr = false;
    } else if (c === '"') { inStr = true; q = c; }
    else if (c === open) depth++;
    else if (c === close && --depth === 0) return i;
  }
  return -1;
}

export function toolsFromText(text) {
  if (typeof text !== "string" || text.length < 20 || text.length > 80000) return [];
  const found = [];
  let tries = 0;
  for (let i = 0; i < text.length && tries < 150; i++) {
    const c = text[i];
    if (c !== "{" && c !== "[") continue;
    if (!/^\s*[{"']/.test(text.slice(i + 1, i + 60))) continue;
    tries++;
    const end = balanced(text, i);
    if (end < 0) continue;
    const j = looseParse(text.slice(i, end + 1));
    const list = Array.isArray(j) ? j : j && typeof j === "object" ? [j] : [];
    const defs = list.map(tryJson).filter(isToolDef);
    if (defs.length && defs.length === list.length) { found.push(...defs); i = end; }
  }
  return found.map(normTool).filter(Boolean);
}

// ---- rows --------------------------------------------------------------------
const textOf = segs => segs.filter(s => s.t === "text").map(s => s.v).join("\n");

function classify(turnsOrResp, calls) {
  if (calls.length) return "tool call";
  const text = textOf(turnsOrResp || []);
  if (!text.trim()) return "none";
  if (text.includes("?")) return "asks a question";
  return REFUSE_RE.test(text) ? "refuses" : "other text";
}

export function normalizeRow(plan, item, features) {
  const raw = item.row;
  const turns = [];
  if (plan.system && raw[plan.system]) turns.push({ role: "system", segs: segments(raw[plan.system]) });
  if (plan.messages) {
    let l = asList(raw[plan.messages]) || [];
    if (l.length && l.every(Array.isArray)) l = l.flat();
    l.filter(isMsg).forEach(m => turns.push(normTurn(m)));
  } else if (plan.transcript) {
    transcriptTurns(raw[plan.transcript] ?? "").forEach(m => turns.push(normTurn(m)));
  } else if (plan.query && raw[plan.query]) {
    turns.push({ role: "user", segs: [{ t: "text", v: String(raw[plan.query]) }] });
  }
  const responses = [
    ...plan.alt.filter(c => raw[c] != null).map(c => ({
      label: c, segs: (asList(raw[c]) || []).filter(isMsg).flatMap(m => normTurn(m).segs),
    })),
    ...plan.responses.filter(c => raw[c] != null && raw[c] !== "").map(c => ({ label: c, segs: segments(raw[c]) })),
  ];
  const callCol = plan.calls ? callsFrom(raw[plan.calls]) : [];
  const tools = plan.tools ? (asList(raw[plan.tools]) || []).map(normTool).filter(Boolean) : [];

  // No tools column: look for definitions written into the system prompt.
  let fromSystem = false;
  if (!tools.length) {
    for (const t of turns) {
      if (t.role !== "system") continue;
      const found = toolsFromText(textOf(t.segs));
      if (found.length) { tools.push(...found); t.hasTools = true; fromSystem = true; }
    }
  }

  const inlineCalls = [...turns, ...responses].flatMap(x => x.segs).filter(s => s.t === "call");
  const calls = [...callCol, ...inlineCalls];

  const userText = turns.filter(t => t.role === "user").map(t => textOf(t.segs)).join("\n");
  const lastAsst = [...turns].reverse().find(t => t.role === "assistant");
  const replySegs = lastAsst ? lastAsst.segs : responses[0]?.segs;
  const kind = classify(replySegs, replySegs?.some(s => s.t === "call") || callCol.length ? [1] : []);

  let overlap = 0;
  if (tools.length && userText) {
    const qw = words(userText);
    for (const t of tools) {
      const nm = t.name.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/[_.]/g, " ");
      const tw = words(nm + " " + t.description);
      let n = 0;
      for (const w of qw) if (tw.has(w)) n++;
      overlap = Math.max(overlap, n);
    }
  }

  const extras = plan.cols.filter(c => !plan.consumed.has(c)).map(c => [c, raw[c], plan.feat[c]]);

  const v = {
    idx: item.row_idx, raw, turns, responses, calls, callCol, tools, extras,
    trunc: item.truncated_cells?.length ? item.truncated_cells : null,
    n_tools: tools.length, overlap, kind, toolsFromSystem: fromSystem,
    multi: turns.filter(t => t.role === "user").length > 1 || turns.some(t => t.role === "system"),
  };
  v.preview = previewOf(v, plan);
  v._s = searchText(v);
  return v;
}

// Rows already in the prototype's local normalized shape (prototype/data/*.jsonl).
export function normalizeLocal(r, i) {
  const turns = r.turns.map(t => ({ role: t.role, segs: [{ t: "text", v: t.content }] }));
  const responses = r.answer != null ? [{ label: "dataset answer", segs: segments(r.answer) }] : [];
  const calls = (r.calls || []).map(normCall);
  const v = {
    idx: i, id: r.id, raw: r, turns, responses, calls, callCol: calls, extras: [], trunc: null,
    tools: r.tools.map(t => ({ ...t, params: t.params.map(p => ({ ...p, enum: null })) })),
    n_tools: r.n_tools, overlap: r.overlap, kind: { call: "tool call", asks: "asks a question", refuses: "refuses",
      other: "other text", none: "none" }[r.kind] || r.kind,
    multi: r.multi, expect: r.expect,
  };
  v.preview = previewOf(v, null);
  v._s = searchText(v);
  return v;
}

function previewOf(v, plan) {
  const u = v.turns.find(t => t.role === "user");
  let s = u ? textOf(u.segs) : "";
  if (!s) s = textOf(v.turns[0]?.segs || []);
  if (!s && v.responses[0]) s = textOf(v.responses[0].segs);
  if (!s && plan) {
    for (const [, val] of v.extras) if (typeof val === "string" && val.trim()) { s = val; break; }
    if (!s) s = Object.entries(v.raw).map(([k, x]) => `${k}: ${typeof x === "object" ? JSON.stringify(x) : x}`).join("  ");
  }
  return s.replace(/\s+/g, " ").trim().slice(0, 240);
}

function searchText(v) {
  const parts = [];
  for (const t of [...v.turns, ...v.responses]) for (const s of t.segs) parts.push(s.t === "call" ? s.name + " " + JSON.stringify(s.args) : typeof s.v === "string" ? s.v : JSON.stringify(s.v));
  for (const c of v.calls) parts.push(c.name);
  for (const t of v.tools) parts.push(t.name, t.description);
  for (const [, val] of v.extras) parts.push(typeof val === "string" ? val : val == null ? "" : JSON.stringify(val));
  return parts.join("\n").toLowerCase().slice(0, 30000);
}

// ---- facets --------------------------------------------------------------------
const bucket = (n, edges) => {
  for (const [max, label] of edges) if (n <= max) return label;
};
const TOOLS_B = n => bucket(n, [[0, "0"], [1, "1"], [4, "2-4"], [Infinity, "5+"]]);
const OPTS = (...a) => a.map(([v, label]) => ({ v, label: label ?? v }));

// Facets that depend on the detected roles, not on column values.
function derivedDefs(plan, views, local) {
  const defs = [];
  if (local) defs.push({
    key: "expect", label: "Dataset label", opts: OPTS(["call", "call"], ["no_call", "no call"], ["any_call", "any call"]),
    val: v => v.expect,
  });
  if (views.some(v => v.tools.length) || local) defs.push({
    key: "n_tools", label: "Tools offered", opts: OPTS(["0"], ["1"], ["2-4", "2–4"], ["5+"]), val: v => TOOLS_B(v.n_tools),
  });
  if (views.some(v => v.calls.length)) defs.push({
    key: "n_calls", label: "Tool calls", opts: OPTS(["0", "none"], ["1"], ["2+", "2 or more"]),
    val: v => (v.calls.length === 0 ? "0" : v.calls.length === 1 ? "1" : "2+"),
  });
  if (views.some(v => v.kind !== "none")) defs.push({
    key: "kind", label: "Assistant reply", opts: OPTS(["tool call"], ["asks a question"], ["refuses"], ["other text"], ["none", "no reply in data"]),
    val: v => v.kind,
  });
  if (views.some(v => v.overlap > 0) && views.some(v => v.tools.length)) defs.push({
    key: "overlap", label: "Query words found in a tool", opts: OPTS(["0", "none"], ["1", "1 word"], ["2+", "2+ words"]),
    val: v => (v.overlap === 0 ? "0" : v.overlap === 1 ? "1" : "2+"),
  });
  if (views.some(v => v.turns.length)) defs.push({
    key: "turns", label: "Conversation", opts: OPTS(["single", "single turn"], ["multi", "multi-turn / system prompt"]),
    val: v => (v.multi ? "multi" : "single"),
  });
  return defs;
}

const fmtNum = n => (Number.isInteger(n) ? String(n) : String(+n.toPrecision(3)));

// Facets generated from the remaining columns: categories, numeric ranges, list lengths.
function columnDefs(plan, views) {
  const defs = [];
  if (!plan) return defs;
  for (const c of plan.cols) {
    if (plan.consumed.has(c)) continue;
    const vals = views.map(v => v.raw[c]);
    const nn = vals.filter(x => x !== null && x !== undefined && x !== "");
    if (nn.length < Math.min(views.length, 10) * 0.5) continue;
    const label = c.replace(/_/g, " ");
    const scalar = nn.every(x => ["string", "boolean", "number"].includes(typeof x));
    if (scalar) {
      const distinct = new Map();
      for (const x of nn) distinct.set(String(x), (distinct.get(String(x)) || 0) + 1);
      const avgLen = nn.reduce((a, x) => a + String(x).length, 0) / nn.length;
      const isNum = nn.every(x => typeof x === "number");
      if (isNum && distinct.size > 12) {
        const lo = Math.min(...nn), hi = Math.max(...nn);
        if (lo === hi) continue;
        const step = (hi - lo) / 5, edges = [0, 1, 2, 3, 4, 5].map(i => lo + step * i);
        const name = i => `${fmtNum(edges[i])} to ${fmtNum(edges[i + 1])}`;
        const binOf = x => Math.max(0, Math.min(4, Math.floor((x - lo) / step)));
        defs.push({ key: "col:" + c, label, opts: [0, 1, 2, 3, 4].map(i => ({ v: name(i), label: name(i) })),
          val: v => { const x = v.raw[c]; return typeof x === "number" ? name(binOf(x)) : undefined; } });
      } else if (distinct.size >= 2 && distinct.size <= 30 && avgLen <= 60 &&
        (distinct.size <= 12 || distinct.size / nn.length < 0.3)) {
        const opts = [...distinct.entries()].sort((a, b) => b[1] - a[1]).map(([v]) => ({ v, label: v }));
        defs.push({ key: "col:" + c, label, opts, dynamic: true, val: v => { const x = v.raw[c]; return x == null || x === "" ? undefined : String(x); } });
      }
    } else if (nn.every(Array.isArray)) {
      const flat = nn.flat();
      if (flat.length && flat.every(x => typeof x === "string" && x.length <= 40)) {
        const distinct = new Map();
        for (const x of flat) distinct.set(x, (distinct.get(x) || 0) + 1);
        if (distinct.size >= 2 && distinct.size <= 40) {
          const opts = [...distinct.entries()].sort((a, b) => b[1] - a[1]).slice(0, 30).map(([v]) => ({ v, label: v }));
          defs.push({ key: "col:" + c, label, opts, dynamic: true, multi: true, val: v => (Array.isArray(v.raw[c]) ? v.raw[c].map(String) : undefined) });
          continue;
        }
      }
      defs.push({ key: "len:" + c, label: `${label} (length)`, opts: OPTS(["0"], ["1"], ["2-4"], ["5+"]),
        val: v => (Array.isArray(v.raw[c]) ? TOOLS_B(v.raw[c].length) : undefined) });
    }
  }
  return defs.slice(0, 8);
}

export function buildDefs(plan, views, local) {
  return [...derivedDefs(plan, views, local), ...columnDefs(plan, views)];
}

export function applyDefs(defs, views) {
  for (const v of views) {
    v.f = {};
    for (const d of defs) v.f[d.key] = d.val(v);
  }
}

export function buildFacets(plan, views, local) {
  const defs = buildDefs(plan, views, local);
  applyDefs(defs, views);
  return defs;
}

// Searchable text of a row, lowercased (also used by the server index).
export const searchTextOf = v => v._s;
