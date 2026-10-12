// Reads a dataset straight from its repository files. Used when the dataset viewer cannot serve it, which is the
// case for private datasets (the viewer only supports them for PRO users and Enterprise organizations).
import { HFError, downloadFile } from "./hf.js";

const HUB = "https://huggingface.co";
const KINDS = { parquet: 0, jsonl: 1, ndjson: 1, json: 2, csv: 3, tsv: 3 };   // lower wins when a split has several
const SPLIT_RE = /^(train|training|test|testing|validation|valid|val|dev|eval)/i;
const SKIP_RE = /(^|\/)(dataset_infos|dataset_info|config|tokenizer|special_tokens_map|generation_config|\.gitattributes)\.?[^/]*$|^\./i;

const ext = p => p.split(".").pop().toLowerCase();
const encodePath = p => p.split("/").map(encodeURIComponent).join("/");

export async function listFiles(id, token, signal) {
  const res = await fetch(`${HUB}/api/datasets/${id}/tree/main?recursive=true`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {}, signal,
  });
  if (!res.ok) {
    throw new HFError(res.status === 404 || res.status === 401 || res.status === 403
      ? "This dataset is private or does not exist. Sign in with an account that can read it."
      : `Hugging Face answered HTTP ${res.status}.`, { status: res.status, auth: [401, 403, 404].includes(res.status) });
  }
  return (await res.json()).filter(f => f.type === "file").map(f => ({ path: f.path, size: f.size || 0 }));
}

// Data files grouped into splits by their names: train.jsonl, data/test-00000-of-00002.parquet, validation/x.json.
export function groupSplits(files) {
  const groups = new Map();   // "split\0stem" -> files; shards of one file share a stem
  for (const f of files) {
    if (!(ext(f.path) in KINDS) || SKIP_RE.test(f.path)) continue;
    const parts = f.path.split("/");
    const base = parts.pop().replace(/\.[^.]+$/, "");
    const stem = base.replace(/[-_]\d{3,}(-of-\d+)?$/, "");
    const hit = [base, ...parts.reverse()].map(s => s.match(SPLIT_RE)?.[1].toLowerCase()).find(Boolean);
    const split = hit ? ({ training: "train", testing: "test", valid: "validation", val: "validation" }[hit] || hit) : stem;
    const key = `${split}\0${stem}`;
    (groups.get(key) || groups.set(key, []).get(key)).push(f);
  }
  // Several different files in one split (When2Call has train_sft and train_pref) are separate configs.
  const stems = new Map();
  for (const k of groups.keys()) { const [sp, st] = k.split("\0"); (stems.get(sp) || stems.set(sp, []).get(sp)).push(st); }
  const order = ["train", "validation", "dev", "eval", "test"];
  return [...groups].map(([key, fs]) => {
    const [split, stem] = key.split("\0");
    const best = Math.min(...fs.map(f => KINDS[ext(f.path)]));
    return { config: stems.get(split).length > 1 ? stem : "default", split, files: fs.filter(f => KINDS[ext(f.path)] === best).sort((a, b) => a.path.localeCompare(b.path)) };
  }).sort((a, b) => (order.indexOf(a.split) + 1 || 99) - (order.indexOf(b.split) + 1 || 99) || a.config.localeCompare(b.config));
}

function parseCsv(text, delim) {
  const rows = [];
  let row = [], cell = "", q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; } else cell += c;
    } else if (c === '"') q = true;
    else if (c === delim) { row.push(cell); cell = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(cell); cell = "";
      if (row.length > 1 || row[0] !== "") rows.push(row);
      row = [];
    } else cell += c;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  const [head, ...rest] = rows;
  return rest.map(r => Object.fromEntries(head.map((h, i) => [h, r[i] ?? ""])));
}

// JSON-safe copy of a value read from Parquet (64-bit integers come back as BigInt).
export const plain = v => typeof v === "bigint" ? Number(v)
  : Array.isArray(v) ? v.map(plain)
  : v && typeof v === "object" && v.constructor === Object ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, plain(x)]))
  : v;

async function parseFile(buf, path, lib) {
  const kind = ext(path);
  if (kind === "parquet") return (await lib().then(l => l.parquetReadObjects({ file: buf, compressors: l.compressors }))).map(plain);
  const text = new TextDecoder().decode(buf);
  if (kind === "jsonl" || kind === "ndjson") return text.split("\n").filter(l => l.trim()).map(l => JSON.parse(l));
  if (kind === "csv" || kind === "tsv") return parseCsv(text, kind === "tsv" ? "\t" : ",");
  const j = JSON.parse(text);
  if (Array.isArray(j)) return j;
  const arrays = Object.values(j).filter(Array.isArray);
  return arrays.length === 1 ? arrays[0] : [j];
}

// All rows of one split, in file order. onProgress gets a fraction between 0 and 1.
export async function loadSplit(id, sp, token, signal, onProgress) {
  const lib = () => import("./vendor/parquet.js");
  const total = sp.files.reduce((a, f) => a + f.size, 0) || 1;
  let before = 0;
  const rows = [];
  for (const f of sp.files) {
    const buf = await downloadFile(`${HUB}/datasets/${id}/resolve/main/${encodePath(f.path)}`, token, signal,
      got => onProgress?.((before + got) / total));
    before += f.size;
    for (const r of await parseFile(buf, f.path, lib)) rows.push(r);
  }
  const names = [];
  for (const r of rows.slice(0, 200)) for (const k of Object.keys(r)) if (!names.includes(k)) names.push(k);
  return { rows, features: names.map(name => ({ name, type: {} })) };
}
