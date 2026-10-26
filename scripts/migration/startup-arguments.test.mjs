import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {migrationStartupArguments} from './startup-arguments.mjs';
test('SQLite migration is explicit and exclusive',()=>{
 assert.deepEqual(migrationStartupArguments([]),[]);
 assert.deepEqual(migrationStartupArguments(['--enable-sqlite']),['--enable-sqlite']);
 assert.throws(()=>migrationStartupArguments(['--rollback-sqlite']),/SQLITE_JSON_ROLLBACK_RETIRED/);
 assert.throws(()=>migrationStartupArguments(['--enable-sqlite','--rollback-sqlite']));
 for(const args of [['--enable-sqlite','--enable-sqlite'],['--enable-sqlite','--rollback-chat-migration'],['--enable-sqlite','--import-chat-package=x']])assert.throws(()=>migrationStartupArguments(args));
});

test('snapshot commands reach the app with exclusive absolute paths',()=>{
 for(const flag of ['--snapshot-sqlite=','--restore-sqlite=','--retire-legacy-json=']){
  assert.deepEqual(migrationStartupArguments([flag+'./backup']),[flag+path.resolve('./backup')]);
  assert.throws(()=>migrationStartupArguments([flag]));
  for(const other of ['--enable-sqlite','--rollback-sqlite','--import-chat-package=x','--rollback-chat-migration','--snapshot-sqlite=x','--restore-sqlite=x','--retire-legacy-json=x'])assert.throws(()=>migrationStartupArguments([flag+'backup',other]));
 }
});
