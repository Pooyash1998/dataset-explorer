// A small, safe Markdown renderer for chat text. Everything is escaped first, so no raw HTML ever gets through.
// Search matches are marked with sentinel characters before rendering and turned into <mark> at the end.
const OPEN = "\u0001", CLOSE = "\u0002", HOLD = "\u0003";

const esc = s => s.replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

function sentinels(text, re) {
  text = text.replace(/[\u0001-\u0003]/g, "");
  if (!re) return text;
  let out = "", last = 0, m;
  re.lastIndex = 0;
  while ((m = re.exec(text))) {
    if (!m[0]) { re.lastIndex++; continue; }
    out += text.slice(last, m.index) + OPEN + m[0] + CLOSE;
    last = m.index + m[0].length;
  }
  return out + text.slice(last);
}

const finish = html => html.replaceAll(OPEN, "<mark>").replaceAll(CLOSE, "</mark>");

// Wrapper tags such as <passage> or <tools>, shown as quiet chips so the structure is easy to see.
const tagChips = html => html.replace(/&lt;(\/?[A-Za-z][\w:.-]*)((?:(?!&gt;)[^\n]){0,160})&gt;/g,
  '<span class="xtag">&lt;$1$2&gt;</span>');

function inlineText(s) {
  const held = [];
  const hold = h => { held.push(h); return HOLD + (held.length - 1) + HOLD; };
  let t = esc(s);
  t = t.replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g,
    (_, label, url) => hold(`<a href="${url}" target="_blank" rel="noopener noreferrer">${label}</a>`));
  t = t.replace(/(^|[\s(])(https?:\/\/[^\s<]+?)(?=[.,;:!?)]*(?:\s|$))/g,
    (_, pre, url) => pre + hold(`<a href="${url}" target="_blank" rel="noopener noreferrer">${url}</a>`));
  t = t.replace(/\*\*(?=\S)([\s\S]*?\S)\*\*/g, "<strong>$1</strong>");
  t = t.replace(/(^|[\s(>])__(?=\S)([\s\S]*?\S)__(?=[\s).,;:!?<]|$)/g, "$1<strong>$2</strong>");
  t = t.replace(/(^|[\s(>])\*(?=[^\s*])([^*\n]*?[^\s*])\*(?=[\s).,;:!?<]|$)/g, "$1<em>$2</em>");
  t = t.replace(/(^|[\s(>])_(?=[^\s_])([^_\n]*?[^\s_])_(?=[\s).,;:!?<]|$)/g, "$1<em>$2</em>");
  t = t.replace(/~~(?=\S)([^~\n]*?\S)~~/g, "<del>$1</del>");
  t = tagChips(t);
  return t.replace(new RegExp(HOLD + "(\\d+)" + HOLD, "g"), (_, i) => held[+i]);
}

function inline(s) {
  // Code spans first: nothing inside them is formatted.
  return s.split(/(`[^`\n]+`)/).map((part, i) =>
    i % 2 ? `<code>${esc(part.slice(1, -1))}</code>` : inlineText(part)).join("");
}

const isFence = l => /^\s*(```|~~~)/.test(l);
const isHeading = l => /^#{1,6}\s+\S/.test(l);
const isRule = l => /^\s*([-*_])(\s*\1){2,}\s*$/.test(l);
const isQuote = l => /^\s*>/.test(l);
const isItem = l => /^\s*([-*+]|\d+[.)])\s+\S/.test(l);
const isTableSep = l => l.includes("|") && /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(l);
const cells = l => l.trim().replace(/^\||\|$/g, "").split("|").map(c => c.trim());

export function renderMarkdown(raw, re) {
  const lines = sentinels(String(raw ?? ""), re).replace(/\r\n?/g, "\n").split("\n");
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const l = lines[i];
    if (!l.trim()) { i++; continue; }

    if (isFence(l)) {
      const lang = l.trim().replace(/^(```|~~~)/, "").trim();
      const buf = [];
      i++;
      while (i < lines.length && !isFence(lines[i])) buf.push(lines[i++]);
      i++;
      out.push(`<pre class="code"${lang ? ` data-lang="${esc(lang)}"` : ""}><code>${esc(buf.join("\n"))}</code></pre>`);
    } else if (isHeading(l)) {
      const m = l.match(/^(#{1,6})\s+(.*?)\s*#*\s*$/);
      out.push(`<div class="mh mh${m[1].length}">${inline(m[2])}</div>`);
      i++;
    } else if (isRule(l)) {
      out.push("<hr>");
      i++;
    } else if (isQuote(l)) {
      const buf = [];
      while (i < lines.length && isQuote(lines[i])) buf.push(lines[i++].replace(/^\s*>\s?/, ""));
      out.push(`<blockquote>${inline(buf.join("\n"))}</blockquote>`);
    } else if (l.includes("|") && i + 1 < lines.length && isTableSep(lines[i + 1])) {
      const head = cells(l);
      i += 2;
      const rows = [];
      while (i < lines.length && lines[i].includes("|") && lines[i].trim()) rows.push(cells(lines[i++]));
      out.push(`<div class="tbl"><table><thead><tr>${head.map(c => `<th>${inline(c)}</th>`).join("")}</tr></thead><tbody>${
        rows.map(r => `<tr>${head.map((_, k) => `<td>${inline(r[k] ?? "")}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`);
    } else if (isItem(l)) {
      const ordered = /^\s*\d/.test(l);
      const items = [];
      while (i < lines.length && (isItem(lines[i]) || (items.length && /^\s{2,}\S/.test(lines[i])))) {
        const m = lines[i].match(/^(\s*)([-*+]|\d+[.)])\s+(.*)$/);
        if (m) items.push({ depth: Math.min(3, Math.floor(m[1].length / 2)), text: m[3] });
        else items[items.length - 1].text += "\n" + lines[i].trim();
        i++;
      }
      const tag = ordered ? "ol" : "ul";
      out.push(`<${tag}>${items.map(it => `<li style="margin-left:${it.depth * 1.2}em">${inline(it.text)}</li>`).join("")}</${tag}>`);
    } else {
      const buf = [];
      while (i < lines.length && lines[i].trim() && !isFence(lines[i]) && !isHeading(lines[i]) && !isRule(lines[i])
        && !isQuote(lines[i]) && !isItem(lines[i]) && !(lines[i].includes("|") && isTableSep(lines[i + 1] || ""))) buf.push(lines[i++]);
      out.push(`<p>${inline(buf.join("\n"))}</p>`);
    }
  }
  return finish(out.join(""));
}
