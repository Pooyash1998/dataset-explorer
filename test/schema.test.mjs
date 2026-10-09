import test from "node:test";
import assert from "node:assert/strict";
import { detectPlan, normalizeRow, segments, buildFacets, normTool } from "../prototype/js/schema.js";

const feats = row => Object.keys(row).map(name => ({ name, type: {} }));
const view = (rows, i = 0) => {
  const plan = detectPlan(feats(rows[0]), rows);
  return { plan, v: normalizeRow(plan, { row_idx: i, row: rows[i] }, []) };
};

test("When2Call: messages, JSON-string tools, no call", () => {
  const row = {
    tools: [JSON.stringify({ name: "get_weather", description: "Weather for a city.", parameters: { type: "dict", properties: { city: { type: "str", description: "City" } } }, required: ["city"] })],
    messages: [{ role: "user", content: "Weather in Paris?" }, { role: "assistant", content: "Which day do you mean?" }],
  };
  const { plan, v } = view([row]);
  assert.equal(plan.messages, "messages");
  assert.equal(plan.tools, "tools");
  assert.equal(v.tools[0].name, "get_weather");
  assert.equal(v.tools[0].params[0].required, true);
  assert.equal(v.calls.length, 0);
  assert.equal(v.kind, "asks a question");
});

test("xLAM: query string, tools and answers as JSON strings", () => {
  const row = {
    query: "Find stations near me",
    tools: JSON.stringify([{ name: "stations", description: "Find stations", parameters: { lat: { type: "float", description: "latitude" } } }]),
    answers: JSON.stringify([{ name: "stations", arguments: { lat: 1.5 } }]),
  };
  const { plan, v } = view([row]);
  assert.equal(plan.query, "query");
  assert.equal(plan.calls, "answers");
  assert.equal(v.calls.length, 1);
  assert.deepEqual(v.calls[0].args, { lat: 1.5 });
  assert.equal(v.tools[0].params[0].name, "lat");
});

test("empty answers column still counts as a calls column", () => {
  const row = { query: "hi", tools: "[]", answers: "[]" };
  const { plan, v } = view([row]);
  assert.equal(plan.calls, "answers");
  assert.equal(v.calls.length, 0);
});

test("ShareGPT from/value with inline <tool_call> tags", () => {
  const row = { conversations: [
    { from: "human", value: "Turn on the lights" },
    { from: "gpt", value: '<tool_call>{"name":"lights_on","arguments":{"room":"kitchen"}}</tool_call>' },
  ] };
  const { v } = view([row]);
  assert.equal(v.turns[0].role, "user");
  assert.equal(v.calls[0].name, "lights_on");
  assert.equal(v.kind, "tool call");
});

test("<TOOLCALL> blocks and <think> segments", () => {
  const segs = segments('<think>plan</think>ok <TOOLCALL>[{"name":"a","arguments":{}}]</TOOLCALL>');
  assert.deepEqual(segs.map(s => s.t), ["think", "text", "call"]);
});

test("glaive <functioncall> with single-quoted arguments", () => {
  const segs = segments(`<functioncall> {"name": "gen", "arguments": '{"length": 12}'} <|endoftext|>`);
  assert.equal(segs[0].t, "call");
  assert.deepEqual(segs[0].args, { length: 12 });
});

test("unterminated <functioncall> does not recurse forever", () => {
  const segs = segments("before <functioncall> {broken");
  assert.ok(segs.length >= 1);
});

test("USER:/ASSISTANT: transcript column", () => {
  const row = { system: "sys", chat: "USER: hi\n\n\nASSISTANT: hello <|endoftext|>" };
  const { plan, v } = view([row]);
  assert.equal(plan.transcript, "chat");
  assert.deepEqual(v.turns.map(t => t.role), ["system", "user", "assistant"]);
});

test("OpenAI tool wrapper is unwrapped", () => {
  const t = normTool({ type: "function", function: { name: "f", description: "d", parameters: { type: "object", properties: { x: { type: "integer", enum: [1, 2] } }, required: ["x"] } } });
  assert.equal(t.name, "f");
  assert.deepEqual(t.params[0].enum, ["1", "2"]);
});

test("facets: derived and generated from columns", () => {
  const rows = Array.from({ length: 30 }, (_, i) => ({
    query: `q${i}`, tools: JSON.stringify([{ name: "t", description: "d", parameters: {} }]),
    answers: JSON.stringify(i % 2 ? [{ name: "t", arguments: {} }] : []), label: i % 3 ? "a" : "b", score: i,
  }));
  const plan = detectPlan(feats(rows[0]), rows);
  const views = rows.map((r, i) => normalizeRow(plan, { row_idx: i, row: r }, []));
  const defs = buildFacets(plan, views, false);
  const keys = defs.map(d => d.key);
  assert.ok(keys.includes("n_tools"));
  assert.ok(keys.includes("col:label"));
  assert.ok(keys.includes("col:score"));
  assert.equal(views[1].f.n_calls, "1");
});

import { looseParse, cleanText, normCall } from "../prototype/js/schema.js";
import { renderMarkdown } from "../prototype/js/markdown.js";

test("looseParse reads Python-style literals", () => {
  assert.deepEqual(looseParse("{'a': [1, 'x', True, None,], \"b\": 'it\\'s'}"), { a: [1, "x", true, null], b: "it's" });
  assert.equal(looseParse("not json"), undefined);
});

test("literal backslash-n becomes a line break only when it dominates", () => {
  assert.equal(cleanText("a\\nb\\nc"), "a\nb\nc");
  assert.equal(cleanText("line1\nline2 and a literal \\n"), "line1\nline2 and a literal \\n");
});

test("tool call with literal newlines and Python lists (hermes row 1864 shape)", () => {
  const text = `<tool_call>\\n{"arguments": {"queries": ['one', 'two'], "name": "Extractor"}}\\n</tool_call>`;
  const segs = segments(text);
  assert.equal(segs.length, 1);
  assert.equal(segs[0].t, "call");
  assert.equal(segs[0].name, "Extractor");
  assert.deepEqual(segs[0].args, { queries: ["one", "two"] });
});

test("normCall accepts OpenAI style calls with JSON string arguments", () => {
  const c = normCall({ id: "1", type: "function", function: { name: "f", arguments: '{"x": 1}' } });
  assert.equal(c.name, "f");
  assert.deepEqual(c.args, { x: 1 });
});

test("system prompts are not parsed for tool calls", () => {
  const row = { conversations: [{ from: "system", value: "Reply in <tool_call>{\"name\": <fn>}</tool_call> form" }, { from: "human", value: "hi" }] };
  const { v } = view([row]);
  assert.deepEqual(v.turns[0].segs.map(s => s.t), ["text"]);
});

test("markdown never lets raw HTML through", () => {
  const html = renderMarkdown('<script>alert(1)</script> and <img src=x onerror=1> [x](javascript:alert(1))');
  assert.ok(!html.includes("<script"));
  assert.ok(!html.includes("<img"));
  assert.ok(!html.includes('href="javascript'));
});

test("markdown: headings, lists, code, tables, tags, search marks", () => {
  const md = "# Title\n\n- one\n- **two**\n\n```js\nlet a = 1 < 2\n```\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n<passage>x</passage>";
  const html = renderMarkdown(md, /two/gi);
  assert.match(html, /class="mh mh1">Title/);
  assert.match(html, /<ul><li[^>]*>one<\/li>/);
  assert.match(html, /<strong><mark>two<\/mark><\/strong>/);
  assert.match(html, /let a = 1 &lt; 2/);
  assert.match(html, /<th>a<\/th>/);
  assert.match(html, /class="xtag">&lt;passage&gt;/);
});

test("markdown leaves snake_case and arithmetic alone", () => {
  const html = renderMarkdown("call get_user_name with 2 * 3 * 4");
  assert.ok(!html.includes("<em>"));
});

import { toolsFromText } from "../prototype/js/schema.js";

test("tools written into a glaive style system prompt", () => {
  const sys = `SYSTEM: You are a helpful assistant with access to the following functions. Use them if required -
{
    "name": "calculate_median",
    "description": "Calculate the median of a list of numbers",
    "parameters": { "type": "object", "properties": { "numbers": { "type": "array", "items": { "type": "number" }, "description": "A list of numbers" } }, "required": ["numbers"] }
}

{ "name": "other", "description": "Another one", "parameters": { "type": "object", "properties": {} } }`;
  const t = toolsFromText(sys);
  assert.deepEqual(t.map(x => x.name), ["calculate_median", "other"]);
  assert.equal(t[0].params[0].required, true);
});

test("tools in a ToolACE style array and a Hermes <tools> block", () => {
  const a = toolsFromText('Here is a list of functions in JSON format that you can invoke:\n[{"name": "a", "description": "d", "parameters": {"type": "dict", "properties": {}}}]\nShould you decide...');
  assert.equal(a[0].name, "a");
  const b = toolsFromText('<tools>\n[{"type": "function", "function": {"name": "b", "description": "d", "parameters": {"type": "object", "properties": {}}}}]\n</tools>\nFor each call use <tool_call>\n{"name": <function-name>, "arguments": <args-dict>}\n</tool_call>');
  assert.deepEqual(b.map(x => x.name), ["b"]);
});

test("a system prompt with no tool JSON yields nothing, and views pick up system tools", () => {
  assert.deepEqual(toolsFromText("You are helpful. Reply as {name: x}."), []);
  const row = { system: 'SYSTEM: functions -\n{"name": "f", "description": "d", "parameters": {"type": "object", "properties": {}}}', chat: "USER: hi\n\n\nASSISTANT: yo" };
  const { v } = view([row]);
  assert.equal(v.tools[0].name, "f");
  assert.equal(v.n_tools, 1);
  assert.equal(v.toolsFromSystem, true);
});
