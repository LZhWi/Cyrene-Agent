import test from 'node:test';
import assert from 'node:assert/strict';
import {mergeRows,mergeProfiles,mergeSessions} from './merge-chat-data.mjs';
import {migrationStartupArguments} from './startup-arguments.mjs';

test('refuses conflicting source edits without mutating the target',()=>{
 const target=[{id:'a',content:'user edit'}];assert.throws(()=>mergeRows(target,[{id:'a',content:'old'}],[{id:'a',content:'new'}]),/conflict/);assert.equal(target[0].content,'user edit');
});
test('applies baseline changes, preserves target additions and is repeatable',()=>{
 const old=[{id:'a',content:'old'}],fresh=[{id:'a',content:'new'}],target=[...old,{id:'b',content:'target only'}];const result=mergeRows(target,old,fresh);assert.equal(result.length,2);assert.deepEqual(mergeRows(result,old,fresh),result);
});
test('locked and user-edited profiles survive source changes',()=>{
 const before={l0:{name:{content:'old'}},l1:{goal:{content:'old'}}};const incoming={l0:{name:{content:'new'}},l1:{goal:{content:'new'}}};const target={l0Locked:true,l0:before.l0,l1:{goal:{content:'mine',origin:'user-edit'}}};assert.deepEqual(mergeProfiles(target,before,incoming),target);
});
test('rejects history ID collisions but retains target-only messages and new event metadata',()=>{
 const current=[{id:'s',messages:[{id:'a',role:'user',content:'one',at:1},{id:'b',role:'model',content:'two',at:2}]}];
 assert.throws(()=>mergeSessions(current,[{id:'s',messages:[{id:'a',role:'user',content:'different',at:1}]}]),/conflict/);
 const result=mergeSessions(current,[{id:'s',messages:[{...current[0].messages[0],callEvent:{summary:'call'}}]}]);assert.equal(result[0].messages.length,2);assert.equal(result[0].messages[0].callEvent.summary,'call');
});
test('rejects duplicate row IDs',()=>assert.throws(()=>mergeRows([{id:'x'},{id:'x'}],[],[]),/Duplicate/));
test('preserves a verified expanded quote when the source quote has not changed',()=>{
 const source=[{id:'a',quote:'short',sourceEndAt:1}],verified=[{id:'a',quote:'full verified source',sourceEndAt:10}];
 assert.deepEqual(mergeRows(verified,source,source,['sourceEndAt']),verified);
 assert.throws(()=>mergeRows(verified,source,[{id:'a',quote:'changed source'}]),/conflict/);
});

test('repairs explicitly selected missing fields even when the source has not changed',()=>{
 const source=[{id:'a',conflictWith:['b'],quote:'short',optional:'original'}];
 const target=[{id:'a',quote:'verified full quote'}];
 assert.deepEqual(mergeRows(target,source,source),target);
 const result=mergeRows(target,source,source,[],['conflictWith']);
 assert.deepEqual(result,[{id:'a',quote:'verified full quote',conflictWith:['b']}]);
 assert.deepEqual(mergeRows(result,source,source,[],['conflictWith']),result);
 assert.deepEqual(target,[{id:'a',quote:'verified full quote'}]);
});

test('missing-field repair preserves existing target links and rejects divergent source edits',()=>{
 const source=[{id:'a',conflictWith:['b']}],target=[{id:'a',conflictWith:['c']}];
 assert.deepEqual(mergeRows(target,source,source,[],['conflictWith']),target);
 assert.throws(()=>mergeRows(target,source,[{id:'a',conflictWith:['d']}],[],['conflictWith']),/conflict/);
});

test('restores missing legacy descriptors without replacing verified binding metadata',()=>{
 const source=[{id:'a',legacySource:{conversationId:'s',messageIds:[],evidence:[]},turnId:''}];
 const target=[{id:'a',turnId:'host-message:verified'}];
 assert.deepEqual(mergeRows(target,source,source,['legacySource','turnId'],['legacySource']),
   [{id:'a',turnId:'host-message:verified',legacySource:source[0].legacySource}]);
});
test('forwards one migration operation and rejects ambiguous or empty input',()=>{
 assert.deepEqual(migrationStartupArguments(['--rollback-chat-migration']),['--rollback-chat-migration']);assert.equal(migrationStartupArguments(['--temporary','--import-chat-package=./package']).length,1);
 assert.throws(()=>migrationStartupArguments(['--import-chat-package=']));assert.throws(()=>migrationStartupArguments(['--import-chat-package=x','--rollback-chat-migration']));assert.throws(()=>migrationStartupArguments(['--rollback-chat-migration','--rollback-chat-migration']));
});
