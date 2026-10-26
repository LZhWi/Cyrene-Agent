const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const support=process.env.SQLITE_TEST_RUNTIME;
if(!support)throw Error('Set SQLITE_TEST_RUNTIME to a built test runtime');
const {migrate,selection,options,inventory}=require(path.join(support,'formal-storage.cjs'));
function fixture(t){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'sqlite-formal-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const put=(name,value)=>{const file=path.join(dir,name);fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,JSON.stringify(value));};
 put('cyrene-chats/index.json',[]);fs.mkdirSync(path.join(dir,'cyrene-chats/sessions'));
 put('plugin-data/companion-memory/memory-state.json',{turns:[],processed:[],l2:[],retainedField:{value:42}});
 put('plugin-data/companion-chat/chat-state.json',{sessions:[],retainedField:'unchanged'});return dir;
}
test('default stays JSON; migration and repeated invocation preserve all original fields',async t=>{const dir=fixture(t),before=inventory(dir);assert.equal(selection(dir),undefined);
 const first=await migrate(dir,support),second=await migrate(dir,support);assert.equal(second.unchanged,true);assert.equal(first.generation,second.generation);assert.deepEqual(inventory(dir),before);
 const bridge=require(path.join(support,'bridge.cjs'))(options(dir,support));try{bridge.start();assert.equal(bridge.pluginStorage('companion-memory').get('memory-state').retainedField.value,42);}finally{await bridge.stop();}
});
test('missing both activation pointers fails closed and never starts a new migration',async t=>{
 const dir=fixture(t);await migrate(dir,support);const control=path.join(dir,'.sqlite-storage');
 fs.unlinkSync(path.join(control,'active.json'));fs.unlinkSync(path.join(control,'activation.json'));
 const before=fs.readdirSync(path.join(control,'generations'));
 assert.throws(()=>selection(dir),/SQLITE_SELECTION_MISSING/);assert.throws(()=>options(dir,support),/SQLITE_SELECTION_MISSING/);
 await assert.rejects(migrate(dir,support),/SQLITE_SELECTION_MISSING/);assert.deepEqual(fs.readdirSync(path.join(control,'generations')),before);
});
test('legacy completed generation without pointers cannot be mistaken for unused JSON',async t=>{
 const dir=fixture(t);await migrate(dir,support);const selected=selection(dir),control=path.join(dir,'.sqlite-storage');
 const receipt=path.join(selected.generation,'receipt.json'),saved=JSON.parse(fs.readFileSync(receipt));delete saved.activationProtocol;fs.writeFileSync(receipt,JSON.stringify(saved));
 for(const name of ['active.json','activation.json','sqlite-required.json'])fs.unlinkSync(path.join(control,name));
 assert.throws(()=>selection(dir),/SQLITE_SELECTION_MISSING/);
});
for(const phase of ['snapshot','import','closed','verified'])test('interruption at '+phase+' leaves JSON active and permits fresh retry',async t=>{const dir=fixture(t),before=inventory(dir);
 await assert.rejects(migrate(dir,support,{point:name=>{if(name===phase)throw Error('INTERRUPTED');}}),/INTERRUPTED/);
 assert.equal(selection(dir),undefined);assert.deepEqual(inventory(dir),before);await migrate(dir,support);assert(selection(dir));
});
test('interruption after atomic activation is idempotently recoverable',async t=>{const dir=fixture(t);await assert.rejects(migrate(dir,support,{point:name=>{if(name==='activated')throw Error('INTERRUPTED');}}));assert(selection(dir));assert.equal((await migrate(dir,support)).unchanged,true);});
test('corrupt receipt or missing database must not fall back to JSON',async t=>{const dir=fixture(t);await migrate(dir,support);const s=selection(dir),receipt=path.join(s.generation,'receipt.json'),saved=fs.readFileSync(receipt);fs.writeFileSync(receipt,'{}');assert.throws(()=>selection(dir),/RECEIPT/);fs.writeFileSync(receipt,saved);fs.renameSync(path.join(s.data,'cyrene.sqlite'),path.join(s.data,'saved.sqlite'));assert.throws(()=>selection(dir),/DATABASE_MISSING/);});
test('source mutation prevents activation',async t=>{const dir=fixture(t);await assert.rejects(migrate(dir,support,{point:name=>{if(name==='closed')fs.writeFileSync(path.join(dir,'changed.json'),'{}');}}),/SQLITE_SOURCE_CHANGED/);assert.equal(selection(dir),undefined);});
for(const phase of ['snapshot','import','verified','activated'])test('process exit at '+phase+' recovers without selecting partial data',async t=>{
 const dir=fixture(t),before=inventory(dir),{spawnSync}=require('node:child_process');
 const script="require(process.argv[1]).migrate(process.argv[2],process.argv[3],{point:name=>{if(name===process.argv[4])process.exit(72)}}).catch(e=>{console.error(e);process.exit(1)})";
 const child=spawnSync(process.execPath,['-e',script,path.join(support,'formal-storage.cjs'),dir,support,phase],{encoding:'utf8',windowsHide:true,timeout:30000});
 assert.equal(child.status,72,child.stderr);assert.equal(Boolean(selection(dir)),phase==='activated');assert.deepEqual(inventory(dir),before);
 const result=await migrate(dir,support);assert.equal(result.unchanged,phase==='activated');assert(selection(dir));
});
test('second writer is rejected while the first owner remains healthy',async t=>{
 const dir=fixture(t);await migrate(dir,support);const make=require(path.join(support,'bridge.cjs')),first=make(options(dir,support)),second=make(options(dir,support));
 try{first.start();assert.throws(()=>second.start(),/locked/);assert.deepEqual(first.store.listSessions(),[]);}finally{await Promise.allSettled([first.stop(),second.stop()]);}
});
test('interrupted activation never falls back to JSON and resumes the same verified generation',async t=>{
 const dir=fixture(t);await assert.rejects(migrate(dir,support,{point:name=>{if(name==='activation-intent')throw Error('INTERRUPTED');}}));
 assert.throws(()=>selection(dir),/ACTIVATION_INCOMPLETE/);const intent=JSON.parse(fs.readFileSync(path.join(dir,'.sqlite-storage/activation.json')));
 const resumed=await migrate(dir,support);assert.equal(resumed.resumed,true);assert.equal(resumed.generation,intent.generation);
 fs.unlinkSync(path.join(dir,'.sqlite-storage/active.json'));fs.writeFileSync(path.join(dir,'changed.json'),'{}');
 assert.throws(()=>selection(dir),/ACTIVATION_INCOMPLETE/);await assert.rejects(migrate(dir,support),/SOURCE_CHANGED/);
});
