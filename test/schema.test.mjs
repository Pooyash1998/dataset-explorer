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
