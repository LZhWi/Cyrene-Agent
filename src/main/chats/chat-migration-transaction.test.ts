import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { prepareChatMigration, commitChatMigration, resolveChatMigrationData, rollbackChatMigration, chatMigrationInventory } from './chat-migration-transaction';
const roots: string[] = [];
function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'host-migration-')); roots.push(root);
  const base = path.join(root, 'base'), candidate = path.join(root, 'package');
  const write = (relative: string, value: unknown) => { const file = path.join(candidate, relative); fs.mkdirSync(path.dirname(file), {recursive:true}); fs.writeFileSync(file, JSON.stringify(value)); };
  fs.mkdirSync(base); fs.writeFileSync(path.join(base, 'app-settings.json'), '{"marker":"preserved"}');
  write('cyrene-chats/index.json', {sessions:[]});
  write('cyrene-chats/sessions/test.json', {messages:[{attachments:[{filePath:path.join(candidate,'cyrene-chats/attachments/a.png')}]}]});
  write('cyrene-chats/attachments/a.png', 'image');
  write('plugin-data/companion-memory/memory-state.json', {entries:[]});
  const records = fs.readdirSync(candidate,{recursive:true,withFileTypes:true}).filter(e=>e.isFile()).map(e=>{const file=path.join(e.parentPath,e.name);return {name:path.relative(candidate,file),sha256:createHash('sha256').update(fs.readFileSync(file)).digest('hex')};});
  write('manifest.json',records);
  return {root,base,candidate};
}
afterEach(()=>{ for(const root of roots.splice(0)) fs.rmSync(root,{recursive:true,force:true}); });
describe('host chat migration transaction',()=>{
  it('rejects target writes after packaging and after preparation',()=>{
    const {base,candidate}=setup();
    fs.writeFileSync(path.join(candidate,'migration-baseline.json'),JSON.stringify(chatMigrationInventory(base)));
    const manifest = fs.readdirSync(candidate,{recursive:true,withFileTypes:true}).filter(e=>e.isFile()&&e.name!=='manifest.json').map(e=>{const file=path.join(e.parentPath,e.name);return {name:path.relative(candidate,file),sha256:createHash('sha256').update(fs.readFileSync(file)).digest('hex')};});
    fs.writeFileSync(path.join(candidate,'manifest.json'),JSON.stringify(manifest));
    const prepared=prepareChatMigration(base,candidate);
    fs.mkdirSync(path.join(base,'cyrene-chats')); fs.writeFileSync(path.join(base,'cyrene-chats/index.json'),'[]');
    expect(()=>prepareChatMigration(base,candidate)).toThrow('打包后');
    expect(()=>commitChatMigration(base,prepared.id!)).toThrow('提交前');
    expect(resolveChatMigrationData(base)).toBe(base);
  });
  it('prepares without activation, commits atomically, keeps mutable data across restart and rolls back',()=>{
    const {base,candidate}=setup(); const prepared=prepareChatMigration(base,candidate);
    expect(resolveChatMigrationData(base)).toBe(base);
    commitChatMigration(base,prepared.id!); const selected=resolveChatMigrationData(base);
    expect(JSON.parse(fs.readFileSync(path.join(selected,'app-settings.json'),'utf8')).marker).toBe('preserved');
    const session=JSON.parse(fs.readFileSync(path.join(selected,'cyrene-chats/sessions/test.json'),'utf8'));
    expect(session.messages[0].attachments[0].filePath).toBe(path.join(selected,'cyrene-chats/attachments/a.png'));
    fs.writeFileSync(path.join(selected,'runtime-write.json'),'{}');
    expect(resolveChatMigrationData(base)).toBe(selected);
    expect(prepareChatMigration(base,candidate)).toEqual({id:prepared.id,unchanged:true});
    commitChatMigration(base,prepared.id!);
    rollbackChatMigration(base); expect(resolveChatMigrationData(base)).toBe(base);
    expect(fs.existsSync(path.join(selected,'runtime-write.json'))).toBe(true);
  });
  it('rejects tampering without changing the active generation',()=>{
    const {base,candidate}=setup(); const prepared=prepareChatMigration(base,candidate);
    fs.writeFileSync(path.join(base,'.chat-migrations/generations',prepared.id!,'app-settings.json'),'{}');
    expect(()=>commitChatMigration(base,prepared.id!)).toThrow('提交前'); expect(resolveChatMigrationData(base)).toBe(base);
  });
  it('rejects stale prepared state after another transaction commits',()=>{
    const {base,candidate}=setup(); const first=prepareChatMigration(base,candidate),second=prepareChatMigration(base,candidate);
    commitChatMigration(base,first.id!); expect(()=>commitChatMigration(base,second.id!)).toThrow('基线');
  });
  it('rejects incomplete or changed packages and nested sources',()=>{
    const {base,candidate}=setup(); fs.writeFileSync(path.join(candidate,'cyrene-chats/index.json'),'{}');
    expect(()=>prepareChatMigration(base,candidate)).toThrow('清单');
    expect(()=>prepareChatMigration(base,path.join(base,'package'))).toThrow('目录内');
    expect(resolveChatMigrationData(base)).toBe(base);
  });
  it('replaces managed trees without reviving removed legacy files',()=>{
    const {base,candidate}=setup(); fs.mkdirSync(path.join(base,'cyrene-chats/sessions'),{recursive:true});
    fs.writeFileSync(path.join(base,'cyrene-chats/sessions/deleted.json'),'{}');
    const prepared=prepareChatMigration(base,candidate); commitChatMigration(base,prepared.id!);
    expect(fs.existsSync(path.join(resolveChatMigrationData(base),'cyrene-chats/sessions/deleted.json'))).toBe(false);
    expect(fs.existsSync(path.join(base,'cyrene-chats/sessions/deleted.json'))).toBe(true);
  });
});
