import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../site/_worker.js';
test('static requests delegate to Pages assets', async()=>{
 let seen;const response=await worker.fetch(new Request('https://test.invalid/faq.html'),{ASSETS:{fetch:r=>{seen=r.url;return new Response('asset');}}});
 assert.equal(seen,'https://test.invalid/faq.html');assert.equal(await response.text(),'asset');
});
test('chat rejects GET without calling external services',async()=>{
 const response=await worker.fetch(new Request('https://test.invalid/api/chat'),{});
 assert.equal(response.status,405);
});
test('missing secret fails clearly without an AI request',async()=>{
 const response=await worker.fetch(new Request('https://test.invalid/api/chat',{method:'POST',body:'{}'}),{});
 assert.equal(response.status,500);assert.deepEqual(await response.json(),{error:'server_not_configured'});
});
test('malformed JSON and empty messages are rejected',async()=>{
 for(const [body,error] of [['{','invalid_json'],['{}','missing_messages']]) {
 const response=await worker.fetch(new Request('https://test.invalid/api/chat',{method:'POST',body}),{ANTHROPIC_API_KEY:'test-only-not-a-real-key'});
 assert.equal(response.status,400);assert.equal((await response.json()).error,error);
 }
});
