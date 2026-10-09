// SQL over a session's two tables: raw (all columns, __idx) and derived (idx, f0..fn facet values, s search text).
const FACET_TOP = 30;
const qid = s => '"' + String(s).replace(/"/g, '""') + '"';
export const qstr = s => "'" + String(s).replace(/'/g, "''") + "'";

// Rows as the client expects them: { row_idx, row, truncated_cells }.
export async function rowsJson(conn, meta, whereSql, params = []) {
  const blob = (meta.columns || []).filter(c => /BLOB/i.test(c.type)).map(c => `NULL AS ${qid(c.name)}`);
  const star = blob.length ? `* EXCLUDE (__idx) REPLACE (${blob.join(", ")})` : "* EXCLUDE (__idx)";
  const r = await conn.runAndReadAll(
    `SELECT __idx, to_json(t) AS j FROM (SELECT __idx, ${star} FROM raw ${whereSql}) t ORDER BY __idx`, params);
  return r.getRowObjects().map(o => {
    const row = JSON.parse(o.j);
    delete row.__idx;
    return { row_idx: Number(o.__idx), row, truncated_cells: [] };
  });
}

// WHERE clause over derived. `skip` leaves one facet's own selection out (for its counts).
function predicate(meta, { filters = {}, q = "", regex = false }, skip) {
  const parts = [], params = [];
  const p = v => { params.push(v); return `$${params.length}`; };
  if (q) parts.push(regex ? `regexp_matches(s, ${p(q)}, 'i')` : `contains(s, ${p(q.toLowerCase())})`);
  for (const d of meta.defs) {
    const vals = filters[d.key];
    if (!Array.isArray(vals) || !vals.length || d.key === skip) continue;
    const ph = vals.map(v => p(String(v)));
    parts.push(d.multi ? `list_has_any(${d.col}, [${ph.join(", ")}])` : `${d.col} IN (${ph.join(", ")})`);
  }
  return { sql: parts.length ? "WHERE " + parts.join(" AND ") : "", params };
}

export const isFiltered = ({ filters = {}, q = "" }) => !!q || Object.values(filters).some(v => Array.isArray(v) && v.length);

export async function queryRows(conn, meta, body) {
  const offset = Math.max(0, Math.floor(+body.offset || 0)), length = Math.min(500, Math.max(1, Math.floor(+body.length || 100)));
  if (!isFiltered(body)) {
    return { total: meta.total, rows: await rowsJson(conn, meta, "WHERE __idx >= $1 AND __idx < $2", [offset, offset + length]) };
  }
  const { sql, params } = predicate(meta, body);
  const n = await conn.runAndReadAll(`SELECT count(*) AS n FROM derived ${sql}`, params);
  const total = Number(n.getRowObjects()[0].n);
  const sel = `SELECT idx FROM derived ${sql} ORDER BY idx LIMIT ${length} OFFSET ${offset}`;
  return { total, rows: await rowsJson(conn, meta, `WHERE __idx IN (${sel})`, params) };
}

export async function facetCounts(conns, meta, body) {
  const out = new Array(meta.defs.length);
  let next = 0;
  const worker = async conn => {
    while (next < meta.defs.length) {
      const i = next++, d = meta.defs[i];
      const { sql, params } = predicate(meta, body, d.key);
      const nn = sql ? `${sql} AND ${d.col} IS NOT NULL` : `WHERE ${d.col} IS NOT NULL`;
      const q = d.multi
        ? `SELECT x AS v, count(*) AS n FROM (SELECT unnest(${d.col}) AS x FROM derived ${nn}) GROUP BY 1`
        : `SELECT ${d.col} AS v, count(*) AS n FROM derived ${nn} GROUP BY 1`;
      const counts = new Map((await conn.runAndReadAll(q, params)).getRowObjects().map(o => [String(o.v), Number(o.n)]));
      const selected = new Set((body.filters?.[d.key] || []).map(String));
      let opts;
      if (d.dynamic) {
        const top = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, FACET_TOP).map(([v]) => v);
        opts = [...new Set([...top, ...selected])].map(v => ({ v, label: v, n: counts.get(v) || 0 }));
      } else opts = d.opts.map(o => ({ ...o, n: counts.get(o.v) || 0 }));
      out[i] = { key: d.key, label: d.label, multi: !!d.multi, opts };
    }
  };
  await Promise.all(conns.map(worker));
  return out;
}
