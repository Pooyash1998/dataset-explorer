// Export the rows on screen (all rows matching the filters) as JSONL, JSON or Parquet.
const isInt32 = x => Number.isInteger(x) && Math.abs(x) < 2 ** 31;

// One Parquet column from the values of one key. Nested values and mixed types are stored as JSON text.
function column(name, rows) {
  const vals = rows.map(r => r[name] ?? null);
  const seen = new Set(vals.filter(v => v !== null).map(v => Array.isArray(v) ? "json" : typeof v));
  let type = "JSON", data = vals.map(v => v === null ? null : JSON.stringify(v));
  if (seen.size === 0 || (seen.size === 1 && seen.has("string"))) { type = "STRING"; data = vals; }
  else if (seen.size === 1 && seen.has("boolean")) { type = "BOOLEAN"; data = vals; }
  else if (seen.size === 1 && seen.has("number")) {
    const ints = vals.every(v => v === null || isInt32(v));
    type = ints ? "INT32" : "DOUBLE"; data = vals;
  }
  return { name, data, type };
}

export async function toBlob(rows, format) {
  if (format === "jsonl") return new Blob([rows.map(r => JSON.stringify(r)).join("\n"), "\n"], { type: "application/x-ndjson" });
  if (format === "json") return new Blob([JSON.stringify(rows)], { type: "application/json" });
  const { parquetWriteBuffer } = await import("./vendor/parquet-writer.js");
  const names = [];
  const have = new Set();
  for (const r of rows) for (const k of Object.keys(r)) if (!have.has(k)) { have.add(k); names.push(k); }
  const buf = parquetWriteBuffer({ columnData: names.map(n => column(n, rows)) });
  return new Blob([buf], { type: "application/vnd.apache.parquet" });
}

export function download(blob, filename) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 60000);
}
