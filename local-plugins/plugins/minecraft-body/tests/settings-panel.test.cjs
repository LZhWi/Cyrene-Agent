'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '../static/settings.js'), 'utf8');
const html = fs.readFileSync(path.join(__dirname, '../static/settings.html'), 'utf8');
const status = () => ({ running: true, starting: false, state: { connected: true, health: 20, food: 20, dimension: 'overworld' }, results: [] });
function fixture() {
  let now = 0, seq = 0;
  const timers = new Map(), listeners = new Map(), nodes = new Map(), sent = [];
  const get = id => {
    if (!nodes.has(id)) nodes.set(id, { value: '', checked: false, disabled: false, textContent: '', options: [], handlers: {}, addEventListener(name, fn) { this.handlers[name] = fn; } });
    return nodes.get(id);
  };
  get('action').value = 'look'; get('action').options = [{ value: 'look', textContent: '看向主人' }];
  const parent = { postMessage(message) { sent.push(message); } };
  const window = { parent, addEventListener(name, fn) { if (!listeners.has(name)) listeners.set(name, []); listeners.get(name).push(fn); }, confirm: () => true };
  const context = vm.createContext({ window, document: { getElementById: get }, console, setTimeout(fn, ms) { const id = ++seq; timers.set(id, { fn, at: now + ms }); return id; }, clearTimeout(id) { timers.delete(id); } });
  vm.runInContext(source, context);
  const flush = async () => { for (let i = 0; i < 15; i++) await Promise.resolve(); };
  const emit = (name, event = {}) => { for (const fn of listeners.get(name) || []) fn(event); };
  const message = (data, source = parent, origin = 'file://') => emit('message', { source, origin, data: { protocol: 'cyrene-panel/1', ...data } });
  const reply = (request, data) => message({ kind: 'invoke-result', seq: request.seq, ok: true, data });
  const init = async () => { message({ kind: 'init' }); await flush(); };
  const tick = async ms => { now += ms; for (;;) { const due = [...timers].filter(([, t]) => t.at <= now).sort((a, b) => a[1].at - b[1].at)[0]; if (!due) break; timers.delete(due[0]); due[1].fn(); await flush(); } };
  const settle = async (body = status(), task = null) => { const req = sent.at(-1); assert.equal(req.channel, 'body-status'); reply(req, body); await flush(); assert.equal(sent.at(-1).channel, 'task-status'); reply(sent.at(-1), task); await flush(); };
  return { get, sent, emit, message, reply, init, tick, settle, flush, context, timers };
}
test('HTML starts fail-closed even if JavaScript cannot load', () => {
  for (const id of ['connect', 'disconnect', 'execute', 'cancel', 'task-cancel', 'task-ack', 'refresh']) assert.match(html, new RegExp(`<button id="${id}" disabled>`));
});
test('no invoke before parent init; ignore foreign init; timeout is visible', async () => {
  const f = fixture(); assert.equal(f.sent.length, 0); assert.equal(f.get('execute').disabled, true);
  f.message({ kind: 'init' }, {}); assert.equal(f.sent.length, 0);
  await f.tick(5000); assert.match(f.get('summary').textContent, /未收到主程序/);
  await f.init(); assert.equal(f.sent.length, 1); await f.settle(); assert.equal(f.get('execute').disabled, false);
});
test('dropped first read times out, retries read only, ignores late response', async () => {
  const f = fixture(); await f.init(); const lost = f.sent[0];
  await f.tick(5000); assert.match(f.get('summary').textContent, /请求超时/); assert.equal(f.get('execute').disabled, true);
  assert.equal(vm.runInContext('pending.size', f.context), 0);
  await f.tick(1000); assert.equal(f.sent.length, 2); assert.notEqual(f.sent[1].seq, lost.seq);
  f.reply(lost, status()); await f.flush(); assert.equal(f.sent.length, 2);
  await f.settle(); assert.equal(f.get('execute').disabled, false);
  assert.equal(vm.runInContext('pending.size', f.context), 0);
});
test('duplicate init and manual refresh do not overlap status polling', async () => {
  const f = fixture(); await f.init(); await f.init(); f.get('refresh').handlers.click(); await f.flush();
  assert.equal(f.sent.length, 1); await f.settle();
  f.get('refresh').handlers.click(); f.get('refresh').handlers.click(); await f.flush(); assert.equal(f.sent.length, 3);
  await f.settle(); await f.tick(1000); assert.equal(f.sent.length, 5);
});
test('task read failure and malformed body keep actions and ack disabled', async () => {
  const f = fixture(); await f.init(); f.reply(f.sent.at(-1), status()); await f.flush();
  await f.tick(5000); assert.equal(f.get('execute').disabled, true); assert.equal(f.get('task-ack').disabled, true);
  await f.tick(1000); await f.settle({}, null); assert.match(f.get('summary').textContent, /格式异常/);
});
test('pagehide cancels timers and requests; pageshow rereads, ignores stale result', async () => {
  const f = fixture(); await f.init(); const old = f.sent[0]; f.emit('pagehide'); await f.flush();
  assert.equal(f.timers.size, 0); assert.equal(vm.runInContext('pending.size', f.context), 0);
  assert.equal(f.get('execute').disabled, true); f.emit('pageshow'); await f.flush();
  f.reply(old, status()); await f.flush(); assert.equal(f.sent.length, 2);
  await f.settle(); assert.equal(f.get('execute').disabled, false);
  f.emit('pagehide'); await f.flush(); await f.tick(10000); assert.equal(f.sent.length, 3);
});
test('action timeout never replays; read success does not clear uncertain operation latch', async () => {
  const f = fixture(); await f.init(); await f.settle();
  f.get('execute').handlers.click(); await f.flush(); assert.equal(f.sent.at(-1).channel, 'body-action');
  f.get('execute').handlers.click(); await f.flush(); assert.equal(f.sent.filter(x => x.channel === 'body-action').length, 1);
  await f.tick(5000); assert.match(f.get('notice').textContent, /不会自动重发/);
  await f.settle(); assert.equal(f.get('execute').disabled, true);
  f.get('execute').handlers.click(); await f.flush(); assert.equal(f.sent.filter(x => x.channel === 'body-action').length, 1);
  assert.equal(f.get('disconnect').disabled, false);
});
test('ack requires uncertain non-running task and complete valid status', async () => {
  const f = fixture(); await f.init(); await f.settle(status(), { state: 'running', effectsUncertain: true }); assert.equal(f.get('task-ack').disabled, true);
  await f.tick(1000); await f.settle(status(), { state: 'blocked', effectsUncertain: true }); assert.equal(f.get('task-ack').disabled, false); assert.equal(f.get('execute').disabled, true);
});
test('navigation during a mutation preserves uncertainty on bfcache restore', async () => {
  const f = fixture(); await f.init(); await f.settle();
  f.get('execute').handlers.click(); await f.flush(); const old = f.sent.at(-1);
  f.emit('pagehide'); await f.flush(); f.emit('pageshow'); await f.flush();
  f.reply(old, { id: 'late' }); await f.flush(); await f.settle();
  assert.equal(f.get('execute').disabled, true);
  assert.equal(f.get('disconnect').disabled, false);
  assert.equal(f.sent.filter(x => x.channel === 'body-action').length, 1);
});
test('only matching parent origin and response IDs settle requests', async () => {
  const f = fixture(); await f.init(); const req = f.sent.at(-1);
  f.message({ kind: 'invoke-result', seq: req.seq, ok: true, data: status() }, undefined, 'https://other.example');
  await f.flush(); assert.equal(f.sent.length, 1);
  await f.settle(); assert.equal(f.get('execute').disabled, false);
});
