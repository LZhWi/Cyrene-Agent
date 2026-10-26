import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocked = vi.hoisted(() => ({ profile: '' }));
vi.mock('electron', () => ({ app: { getPath: () => mocked.profile }, shell: { openPath: vi.fn() } }));
const support = process.env.SQLITE_TEST_RUNTIME;
describe.skipIf(!support)('JSON and SQLite same-input compatibility', () => {
  let root: string, json: typeof import('./chats-store-json'), owner: any, ids: string[];
  const user = { id: 'u', role: 'user' as const, content: 'original question', at: 1 };
  const answer = { id: 'a', role: 'model' as const, content: 'answer', at: 2 };
  beforeEach(async () => {
    vi.resetModules();
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'sqlite-json-parity-'));
    mocked.profile = path.join(root, 'json');
    json = await import('./chats-store-json'); json.initialize();
    ids = ['chat', 'work', 'code', 'learn'].map((mode: any) => json.createSession({ mode, initialMessages: [user, answer] }).id);
    const older = json.createSession({ mode: 'chat', purpose: 'proactive-chat', initialMessages: [user] });
    json.setSessionPinned(older.id, true);
    await new Promise(r => setTimeout(r, 5));
    const newer = json.createSession({ mode: 'chat', purpose: 'proactive-chat', initialMessages: [user] });
    ids.push(older.id, newer.id);
    const sqlProfile = path.join(root, 'sqlite'); fs.cpSync(mocked.profile, sqlProfile, { recursive: true });
    for (const [id, value] of Object.entries({ 'companion-memory': { turns: [], processed: [], entries: [] }, 'companion-chat': { sessions: [] } })) {
      const dir = path.join(sqlProfile, 'plugin-data', id); fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, id === 'companion-memory' ? 'memory-state.json' : 'chat-state.json'), JSON.stringify(value));
    }
    const formal = require(path.join(support!, 'formal-storage.cjs'));
    await formal.migrate(sqlProfile, support);
    owner = require(path.join(support!, 'bridge.cjs'))(formal.options(sqlProfile, support)); owner.start();
  });
  afterEach(async () => { try { await owner?.stop(); } finally { if (root) fs.rmSync(root, { recursive: true, force: true }); } });
  function compare(id: string) {
    const a = json.getSession(id)!, b = owner.store.getSession(id);
    expect(b.messages).toEqual(a.messages); expect(b.title).toBe(a.title);
    expect(b.titleIsCustom).toBe(a.titleIsCustom);
  }
  it('derives titles after append, edit, replacement and deletion; preserves custom titles', () => {
    for (const id of ids.slice(0, 4)) {
      for (const store of [json, owner.store]) store.upsertMessage(id, { ...user, content: 'changed\n' + 'long '.repeat(12) });
      compare(id);
      for (const store of [json, owner.store]) store.replaceMessagesTail(id, 0, [{ ...user, content: 'tail title' }], ['u', 'a']);
      compare(id);
      for (const store of [json, owner.store]) store.deleteMessageRound(id, 'u');
      compare(id); expect(owner.store.getSession(id).title).toBe('新对话');
      for (const store of [json, owner.store]) store.appendMessage(id, user);
      compare(id);
      for (const store of [json, owner.store]) { store.renameSession(id, 'custom'); store.replaceMessages(id, []); }
      compare(id); expect(owner.store.getSession(id).title).toBe('custom');
    }
  });
  it('selects latest and same-purpose sessions without pinned priority', () => {
    expect(json.listSessions()[0].id).toBe(ids[4]);
    expect(owner.store.getLatestSessionId()).toBe(json.getLatestSessionId());
    expect(owner.store.getLatestSessionId()).toBe(ids[5]);
    expect(owner.store.getSessionByPurpose('proactive-chat').id).toBe(json.getSessionByPurpose('proactive-chat')!.id);
    expect(owner.store.getSessionByPurpose('missing')).toBeNull();
  });
  it('selects updated old sessions, survives restart and falls back after deletion', async () => {
    const selected = () => owner.store.getSessionByPurpose('proactive-chat')?.id ?? null;
    const check = (id: string | null) => {
      expect(json.getSessionByPurpose('proactive-chat')?.id ?? null).toBe(id);
      expect(selected()).toBe(id);
    };
    const restart = async () => {
      await owner.stop();
      vi.resetModules(); json = await import('./chats-store-json'); json.initialize();
      const formal = require(path.join(support!, 'formal-storage.cjs'));
      owner = require(path.join(support!, 'bridge.cjs'))(formal.options(path.join(root, 'sqlite'), support)); owner.start();
    };
    check(ids[5]);
    await new Promise(r => setTimeout(r, 5));
    for (const store of [json, owner.store]) store.renameSession(ids[4], 'updated older session');
    check(ids[4]); await restart(); check(ids[4]);
    for (const store of [json, owner.store]) expect(store.deleteSession(ids[4])).toBe(true);
    check(ids[5]); await restart(); check(ids[5]);
    for (const store of [json, owner.store]) expect(store.deleteSession(ids[5])).toBe(true);
    check(null); await restart(); check(null);
  });
  it('refreshes time on unchanged content but leaves TTS cache writes quiet', async () => {
    const id = ids[0];
    for (const op of [(s: any) => s.upsertMessage(id, user), (s: any) => s.replaceMessages(id, [user, answer]), (s: any) => s.replaceMessagesTail(id, 0, [user, answer], ['u', 'a'])]) {
      const a = json.getSession(id)!.updatedAt, b = owner.store.getSession(id).updatedAt;
      await new Promise(r => setTimeout(r, 5)); const start = Date.now(); op(json); op(owner.store); const end = Date.now();
      expect(json.getSession(id)!.updatedAt).toBeGreaterThan(a); expect(owner.store.getSession(id).updatedAt).toBeGreaterThan(b);
      expect(owner.store.getSession(id).updatedAt).toBeGreaterThanOrEqual(start); expect(owner.store.getSession(id).updatedAt).toBeLessThanOrEqual(end); compare(id);
    }
    for (const store of [json, owner.store]) { const at = store.getSession(id).updatedAt; store.setMessageTtsCacheKey(id, 'a', `minimax-${'a'.repeat(64)}`, 'v1'); expect(store.getSession(id).updatedAt).toBe(at); }
  });
  it('retains SQLite duplicate ID and empty summary protections', () => {
    const id = ids[0]; owner.store.appendMessage(id, user);
    expect(owner.store.getSession(id).messages).toHaveLength(2);
    expect(() => owner.store.appendMessage(id, { ...user, content: 'conflict' })).toThrow('LIFE_MESSAGE_ID_CONFLICT');
    owner.store.upsertMessage(id, { ...user, attachments: [{ kind: 'image', name: 'test.png', filePath: 'test.png' }] });
    expect(() => owner.store.setImageVisualIndexResult(id, 'u', 'test.png', { summary: '' })).toThrow('LIFE_INVALID_VISUAL_RESULT');
  });
});
