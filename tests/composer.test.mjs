import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

const html = readFileSync(new URL('../site/index.html', import.meta.url), 'utf8');
function section(start, end) {
  const a = html.indexOf(start);
  const b = html.indexOf(end, a);
  assert.ok(a >= 0 && b > a);
  return html.slice(a, b);
}
const voice = section('(function setupVoiceInput()', '\n  function addMessage');
const send = section('  async function send()', '\n  // Opening state');
const update = section('  function updateSendState()', '\n  inputEl.placeholder');

function harness() {
  function element() {
    return { value: '', disabled: false, style: {}, attrs: {}, handlers: {},
      classList: { toggle() {}, remove() {} },
      setAttribute(k, v) { this.attrs[k] = v; },
      addEventListener(k, fn) { this.handlers[k] = fn; },
      focus() {}, parentElement: { remove() {} } };
  }
  const micBtn = element(), sendBtn = element(), inputEl = element();
  let recorder, clock = 100000, stoppedTracks = 0, transcriptions = 0;
  let transcriptResolve;
  let files = [], sent = [];
  const messages = [];
  class Recorder {
    static isTypeSupported() { return true; }
    constructor() { recorder = this; }
    start() {}
    stop() {
      this.ondataavailable({ data: new Blob(['x'.repeat(2048)], { type: 'audio/webm' }) });
      return this.onstop();
    }
  }
  const ctx = vm.createContext({
    micBtn, sendBtn, inputEl, busy: false, voiceBusy: false, attachmentReading: false,
    Blob, MediaRecorder: Recorder, Date: { now: () => clock }, console,
    navigator: { mediaDevices: { async getUserMedia() { return { getTracks: () => [{ stop() { stoppedTracks++; } }] }; } } },
    document: { addEventListener() {}, hidden: false },
    window: { MediaRecorder: Recorder,
      __allaHasAttachments: () => files.length > 0,
      __allaTakeAttachments() { const result = files; files = []; return result; } },
    T: { micLabel: 'Record', micListening: 'Stop recording', micTranscribing: 'Transcribing', micErrorNoSpeech: 'No speech' },
    setTimeout() { return 1; }, clearTimeout() {},
    setInterval() { throw new Error('Dictation must not schedule automatic sending'); },
    async fetch(url) {
      assert.equal(url, '/api/transcribe'); transcriptions++;
      await new Promise(resolve => { transcriptResolve = resolve; });
      return { ok: true, json: async () => ({ text: 'Recognized draft' }) };
    },
    autoGrow() { ctx.updateSendState(); },
    addMessage(role, text) { messages.push({ role, text }); return element(); },
    history: [], MAX_TURNS: 20, scrollEl: { scrollTop: 0, scrollHeight: 0 },
    errorCopy() { return 'error'; },
    async streamChat(history, delta, attachments) { sent.push({ text: history.at(-1).content, attachments }); return 'OK'; }
  });
  vm.runInContext(update + voice + send, ctx);
  return { ctx, micBtn, sendBtn, inputEl, messages, sent,
    setFiles(value) { files = value; ctx.updateSendState(); }, getFiles: () => files,
    async start() { await micBtn.handlers.click(); await Promise.resolve(); await Promise.resolve(); },
    async stop() { clock += 1000; micBtn.handlers.click(); await Promise.resolve(); },
    async finish() { transcriptResolve(); for (let i = 0; i < 12; i++) await Promise.resolve(); },
    tracksStopped: () => stoppedTracks, transcriptions: () => transcriptions };
}

test('record → stop → editable draft → explicit send, with attachment and edits', async () => {
  const h = harness();
  assert.equal(h.sendBtn.disabled, true);
  await h.start();
  assert.equal(h.micBtn.attrs['aria-pressed'], 'true');
  assert.equal(h.sendBtn.disabled, true);
  await h.stop();
  assert.equal(h.tracksStopped(), 1);
  assert.equal(h.transcriptions(), 1);
  assert.equal(h.sendBtn.disabled, true);
  await h.finish();
  assert.equal(h.inputEl.value, 'Recognized draft');
  assert.equal(h.sent.length, 0);
  assert.equal(h.sendBtn.disabled, false);
  h.inputEl.value = 'Edited draft';
  h.setFiles([{ name: 'synthetic.pdf', type: 'application/pdf', data: 'synthetic' }]);
  await h.sendBtn.handlers.click();
  assert.equal(h.sent.length, 1);
  assert.equal(h.sent[0].text, 'Edited draft');
  assert.equal(h.sent[0].attachments[0].name, 'synthetic.pdf');
  assert.equal(h.inputEl.value, '');
  assert.equal(h.sendBtn.disabled, true);
});

test('draft dictated during an answer never auto-sends when answer finishes', async () => {
  const h = harness(); h.ctx.busy = true;
  await h.start(); await h.stop(); await h.finish();
  assert.equal(h.inputEl.value, 'Recognized draft');
  assert.equal(h.sendBtn.disabled, true);
  h.ctx.busy = false; h.ctx.updateSendState();
  assert.equal(h.sent.length, 0);
  assert.equal(h.sendBtn.disabled, false);
});

for (const flag of ['busy', 'voiceBusy', 'attachmentReading']) {
  test(`blocked send preserves text and attachments while ${flag}`, async () => {
    const h = harness(); h.inputEl.value = 'Keep draft';
    h.setFiles([{ name: 'keep.pdf' }]); h.ctx[flag] = true;
    await h.ctx.send();
    assert.equal(h.getFiles().length, 1);
    assert.equal(h.inputEl.value, 'Keep draft');
    assert.equal(h.sent.length, 0);
  });
}

test('existing text is preserved before transcription', async () => {
  const h = harness(); h.inputEl.value = 'Typed';
  await h.start(); await h.stop(); await h.finish();
  assert.equal(h.inputEl.value, 'Typed Recognized draft');
  assert.equal(h.sent.length, 0);
});

test('file-only message enables arrow and sends exactly once', async () => {
  const h = harness(); h.setFiles([{ name: 'only.pdf' }]);
  assert.equal(h.sendBtn.disabled, false);
  await h.ctx.send(); await h.ctx.send();
  assert.equal(h.sent.length, 1);
  assert.equal(h.sent[0].attachments.length, 1);
});

test('IME Enter does not send; ordinary Enter sends; Shift+Enter stays a draft', async () => {
  const h = harness(); h.inputEl.value = 'Draft';
  const enter = { key: 'Enter', shiftKey: false, preventDefault() {} };
  h.inputEl.handlers.keydown({ ...enter, isComposing: true });
  h.inputEl.handlers.keydown({ ...enter, shiftKey: true });
  assert.equal(h.sent.length, 0);
  h.inputEl.handlers.keydown(enter);
  await Promise.resolve();
  assert.equal(h.sent.length, 1);
});
