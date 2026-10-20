"use strict";
const {test}=require("node:test");const assert=require("node:assert/strict");
const {parseProperties}=require("./minecraft-task-test-guards.cjs");
test("canonical generated settings retain protected exact values",()=>{
 const parsed=parseProperties('# comment\nserver-ip=127.0.0.1\nlevel-type=minecraft\\:flat\n');assert.equal(parsed['server-ip'],'127.0.0.1');
});
test("reject Java Properties whitespace, colon, escaped-key and continuation bypasses",()=>{
 for(const bad of [' server-ip =0.0.0.0','server-ip:0.0.0.0','server\\u002dip=0.0.0.0','other=value\\\nserver-ip=0.0.0.0']) assert.throws(()=>parseProperties('server-ip=127.0.0.1\n'+bad),/canonical|Duplicate/);
});
test("reject duplicate keys rather than choosing different override semantics",()=>{
 assert.throws(()=>parseProperties('level-name=isolated-test-world\nlevel-name=important-world'),/Duplicate/);
});
