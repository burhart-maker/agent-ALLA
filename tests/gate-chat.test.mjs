import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';
import assert from 'node:assert/strict';
import test from 'node:test';

// Evaluate the complete production module, exposing internals only in this
// isolated context. No production exports, dependencies or network calls change.
const source = readFileSync(process.env.ALLA_TEST_WORKER || new URL('../site/_worker.js', import.meta.url), 'utf8');
const context = vm.createContext({
  Request, Response, Headers, URL, TextEncoder, TextDecoder, crypto: webcrypto,
  atob, btoa, ReadableStream, TransformStream, console,
  fetch() { throw new Error('Tests must never call an external provider'); }
});
vm.runInContext(source.replace('export default {', 'globalThis.worker = {') +
  '\nglobalThis.api = { gateChat, loadSettings, nowSec };', context);
const { gateChat, loadSettings, nowSec } = context.api;

test('missing usage database refuses paid provider access', async () => {
  const result = await gateChat(new Request('https://local.test/api/chat'), {}, {});
  assert.equal(result.response.status, 503);
  assert.equal((await result.response.json()).error, 'usage_unavailable');
});

function fixture({ billing = false, used = 0, user = null, sub = null, spent = 0 } = {}) {
  const queries = [];
  const env = { DB: { prepare(sql) {
    queries.push(sql);
    return {
      bind(...args) { this.args = args; return this; },
      async all() {
        assert.equal(sql, 'SELECT key, value FROM settings');
        return { results: [{ key: 'billing_enabled', value: billing ? '1' : '0' }] };
      },
      async first() {
        if (sql.includes('JOIN users')) return user;
        if (sql.includes('COUNT(*)')) return { n: used };
        if (sql.includes('FROM subscriptions')) return sub;
        if (sql.includes('SUM(eur_micros)')) return { spent };
        throw new Error('Unexpected query: ' + sql);
      }
    };
  } } };
  const request = new Request('https://local.test/api/chat', {
    method: 'POST', headers: { 'cf-connecting-ip': '192.0.2.1', ...(user ? { cookie: 'alla_session=synthetic-test-token' } : {}) }
  });
  return { env, request, queries };
}

async function run(options) {
  const f = fixture(options);
  const cfg = await loadSettings(f.env);
  return { ...(await gateChat(f.request, f.env, cfg)), queries: f.queries };
}
async function refused(options, status, error) {
  const result = await run(options);
  assert.equal(result.response?.status, status);
  assert.match(result.response.headers.get('content-type'), /application\/json/);
  assert.equal((await result.response.json()).error, error);
  assert.ok(result.queries.every(q => /^SELECT/.test(q)), 'entitlement performs no writes or charges');
}

for (const billing of [false, true]) {
  test(`anonymous boundary, billing=${billing}`, async () => {
    assert.equal((await run({ billing, used: 4 })).actor.kind, 'anon');
    await refused({ billing, used: 5 }, 401, 'sign_in_required');
    await refused({ billing, used: 6 }, 401, 'sign_in_required');
  });
  test(`trial messages boundary, billing=${billing}`, async () => {
    const user = { id: 'synthetic-user', trial_messages: 24, trial_started_at: nowSec() };
    assert.equal((await run({ billing, user })).actor.kind, 'trial');
    await refused({ billing, user: { ...user, trial_messages: 25 } }, 402, 'trial_over');
  });
  test(`trial clock, billing=${billing}`, async () => {
    const user = { id: 'synthetic-user', trial_messages: 0, trial_started_at: nowSec() - 15 * 86400 };
    await refused({ billing, user }, 402, 'trial_over');
    assert.equal((await run({ billing, user: { ...user, trial_started_at: null } })).actor.kind, 'trial');
  });
  for (const status of ['active', 'trialing']) {
    for (const autopay of [0, 1]) {
      test(`subscriber boundary, billing=${billing}, status=${status}, autopay=${autopay}`, async () => {
        const opts = { billing, user: { id: 'synthetic-user' }, sub: { plan: 'standard', status, autopay, current_period_start: nowSec() - 86400 } };
        assert.equal((await run({ ...opts, spent: 9999999 })).actor.kind, 'subscriber');
        if (billing && autopay) {
          assert.equal((await run({ ...opts, spent: 10000000 })).actor.kind, 'subscriber');
        } else {
          await refused({ ...opts, spent: 10000000 }, 402, 'allowance_exceeded');
        }
      });
    }
  }
  test(`inactive subscriber uses trial, billing=${billing}`, async () => {
    await refused({ billing, user: { id: 'synthetic-user', trial_messages: 25 }, sub: { status: 'canceled', autopay: 1 } }, 402, 'trial_over');
  });
}

test('pro allowance is 25 EUR', async () => {
  const opts = { user: { id: 'synthetic-user' }, sub: { status: 'active', plan: 'pro', autopay: 0 } };
  assert.equal((await run({ ...opts, spent: 24999999 })).actor.kind, 'subscriber');
  await refused({ ...opts, spent: 25000000 }, 402, 'allowance_exceeded');
});

for (const path of ['/api/chat', '/api/transcribe']) {
  test(`${path} refuses exhausted anonymous use before provider or side effects`, async () => {
    const f = fixture({ used: 5 });
    const request = new Request('https://local.test' + path, {
      method: 'POST', headers: { 'cf-connecting-ip': '192.0.2.1', 'content-type': 'audio/webm' }
    });
    f.env.OPENAI_API_KEY = 'synthetic-key';
    const response = await context.worker.fetch(request, f.env, {
      waitUntil() { throw new Error('Refused requests must not schedule side effects'); }
    });
    assert.equal(response.status, 401);
    assert.equal((await response.json()).error, 'sign_in_required');
    assert.ok(f.queries.every(q => /^SELECT/.test(q)));
  });
}
