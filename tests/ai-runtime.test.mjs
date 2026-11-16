import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { webcrypto } from 'node:crypto';
const source = readFileSync(new URL('../site/_worker.js', import.meta.url), 'utf8');

function wire(events, split = false) {
  const text = events.map(e => 'data: ' + JSON.stringify(e) + '\n\n').join('');
  const data = new TextEncoder().encode(text);
  return new Response(new ReadableStream({ start(c) {
    if (split) for (const byte of data) c.enqueue(new Uint8Array([byte]));
    else c.enqueue(data);
    c.close();
  } }), { headers: { 'content-type': 'text/event-stream' } });
}
function complete(output = [], tokens = 7) {
  return { type: 'response.completed', response: { status: 'completed', output, usage: { input_tokens: tokens, output_tokens: 3 } } };
}
function harness(replies = []) {
  const requests = [], tools = [];
  const c = vm.createContext({ Request, Response, Headers, URL, TextEncoder, TextDecoder,
    crypto: webcrypto, atob, btoa, ReadableStream, TransformStream, AbortController,
    setTimeout, clearTimeout, console,
    async fetch(url, options) {
      assert.equal(url, 'https://api.openai.com/v1/responses');
      requests.push({ body: JSON.parse(options.body), headers: options.headers, signal: options.signal });
      const res = replies.shift();
      if (!res) throw new Error('Unexpected provider call');
      return res;
    }
  });
  vm.runInContext(source.replace('export default {', 'globalThis.worker = {') +
    '\nglobalThis.api = { aiChat, aiInput, aiFunction, aiFailure, handleChatPost, updateProfile, meterStream, eurMicrosFor, CATASTRO_TOOL, REPORT_TOOL, aiModel };', c);
  c.runCatastroTool = async args => { tools.push(args); return { real: 'cadastre' }; };
  c.runReportTool = async args => { tools.push(args); return { url: '/r/synthetic' }; };
  c.loadProfile = async () => '';
  return { c, api: c.api, requests, tools };
}
const env = { OPENAI_API_KEY: 'synthetic-key' };
const request = () => new Request('https://local.test/api/chat', { method: 'POST' });

test('streamed Cyrillic survives fragmented bytes; contract and usage retained', async () => {
  const h = harness([wire([{ type: 'response.output_text.delta', delta: 'Привет' }, complete([{ type: 'web_search_call' }])], true)]);
  const response = await h.api.aiChat(request(), env, [{ role: 'user', content: 'Hi' }], 'system', [], {});
  let usage;
  const text = await new Response(h.api.meterStream(response.body, (...args) => { usage = args; })).text();
  assert.match(text, /Привет/); assert.match(text, /message_stop/);
  assert.deepEqual(Array.from(usage), [7, 3, 1, 'Привет']);
  assert.equal(h.requests[0].body.store, false);
  assert.equal(h.requests[0].body.stream, true);
  assert.equal(h.requests[0].headers.authorization, 'Bearer synthetic-key');
});

test('function results and reasoning retained for second round; no duplicate invocation', async () => {
  const output = [{ type: 'reasoning', encrypted_content: 'encrypted' }, { type: 'function_call', name: 'catastro_lookup', call_id: 'call-1', arguments: '{"municipio":"Mahon"}' }];
  const h = harness([wire([complete(output, 5)]), wire([{ type: 'response.output_text.delta', delta: 'Verified' }, complete([], 6)])]);
  const r = await h.api.aiChat(request(), env, [{ role: 'user', content: 'parcel' }], 'sys', [], {});
  const text = await r.text();
  assert.equal(h.tools.length, 1); assert.equal(h.requests.length, 2);
  assert.equal(h.requests[1].body.input[1].encrypted_content, 'encrypted');
  assert.equal(h.requests[1].body.input.at(-1).call_id, 'call-1');
  assert.match(h.requests[1].body.input.at(-1).output, /cadastre/);
  assert.match(text, /"input_tokens":11/);
});

test('tool error becomes evidence of failure instead of fabricated facts', async () => {
  const h = harness([wire([complete([{ type: 'function_call', name: 'catastro_lookup', call_id: 'c', arguments: '{}' }])]), wire([complete()])]);
  h.c.runCatastroTool = async () => { throw new Error('offline'); };
  await (await h.api.aiChat(request(), env, [], 'sys', [], {})).text();
  assert.match(h.requests[1].body.input.at(-1).output, /tool_failed/);
});

test('provider auth errors are sanitized, never fallback to Anthropic', async () => {
  const h = harness([new Response('{"error":"synthetic-key"}', { status: 401 })]);
  const res = await h.api.aiChat(request(), env, [], '', [], {});
  assert.equal(res.status, 503); assert.equal((await res.json()).error, 'ai_authentication_failed');
  assert.equal(h.requests.length, 1);
});

test('interrupted stream produces error, no successful completion or profile text', async () => {
  const h = harness([wire([{ type: 'response.output_text.delta', delta: 'partial' }])]);
  const r = await h.api.aiChat(request(), env, [], '', [], {});
  let usage;
  const text = await new Response(h.api.meterStream(r.body, (...a) => { usage = a; })).text();
  assert.match(text, /"type":"error"/); assert.doesNotMatch(text, /message_stop/);
  assert.equal(usage[3], '');
});

test('tool round cap refuses rather than losing gathered results', async () => {
  const h = harness(Array.from({ length: 4 }, () => wire([complete([{ type: 'function_call', name: 'catastro_lookup', call_id: 'c', arguments: '{}' }])])));
  const text = await (await h.api.aiChat(request(), env, [], '', [], {})).text();
  assert.equal(h.requests.length, 4); assert.equal(h.tools.length, 3);
  assert.match(text, /"type":"error"/);
});

test('PDF and image attachments map into Responses without browser credentials', () => {
  const h = harness();
  const result = h.api.aiInput([{ role: 'user', content: [{ type: 'document', source: { data: 'cGRm', media_type: 'application/pdf' } }, { type: 'image', source: { data: 'aW1n', media_type: 'image/png' } }, { type: 'text', text: 'Question' }] }]);
  assert.equal(result[0].content[0].file_data, 'data:application/pdf;base64,cGRm');
  assert.equal(result[0].content[1].image_url, 'data:image/png;base64,aW1n');
  assert.equal(result[0].content[2].type, 'input_text');
});

test('route validates input and attachments before provider access', async () => {
  const h = harness();
  const req = body => new Request('https://local.test/api/chat', { method: 'POST', body: JSON.stringify(body) });
  const res = await h.api.handleChatPost(req({ messages: [{ role: 'user', content: 'Hello' }], attachments: [{ type: 'text/html', data: 'eA==' }] }), env, {}, {});
  assert.equal(res.status, 415); assert.equal(h.requests.length, 0);
  const noKey = await h.api.handleChatPost(req({ messages: [{ role: 'user', content: 'Hi' }] }), {}, {}, {});
  assert.equal(noKey.status, 503);
});

test('profile updater uses OpenAI and stores only completed text', async () => {
  const h = harness([new Response(JSON.stringify({ status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: 'New note' }] }] }))]);
  let note;
  h.c.saveProfile = async (env, id, text) => { note = text; };
  await h.api.updateProfile(env, {}, 'synthetic-user', 'said', 'answer');
  assert.equal(note, 'New note'); assert.equal(h.requests.length, 1);
});

test('function schemas preserved, model override and verified fallback pricing', async () => {
  const h = harness();
  assert.equal(h.api.aiModel({ OPENAI_MODEL: 'custom-model' }), 'custom-model');
  assert.equal(h.api.aiFunction(h.api.REPORT_TOOL).name, 'property_report');
  const cost = await h.api.eurMicrosFor({}, { usdToEur: 1, searchUsd: 0 }, 'gpt-6-astra', 1000000, 1000000, 0, 0);
  assert.equal(cost, 60000000);
  assert.doesNotMatch(source, /api\.anthropic\.com|env\.ANTHROPIC_API_KEY/);
});
