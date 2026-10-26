import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {buildSync} from 'esbuild';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
export function buildSqliteRuntime(destination=path.join(root,'dist/sqlite-runtime')){
 const source=path.join(root,'scripts/sqlite-isolation');fs.mkdirSync(destination,{recursive:true});
 for(const name of fs.readdirSync(source))if(name.endsWith('.cjs')&&!name.endsWith('.test.cjs'))fs.copyFileSync(path.join(source,name),path.join(destination,name));
 for(const name of ['conversation-database-client','conversation-database-worker'])buildSync({entryPoints:[path.join(source,'runtime/upstream/src/main/storage',name+'.ts')],outfile:path.join(destination,'runtime/upstream/src/main/storage',name+'.js'),bundle:true,platform:'node',format:'cjs',external:['electron','esbuild']});
}
if(process.argv[1]===fileURLToPath(import.meta.url))buildSqliteRuntime(process.argv[2]);
