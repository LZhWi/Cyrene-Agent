const fs=require('node:fs'),path=require('node:path');
function plain(target){
 target=path.resolve(target);let p=target;
 while(!fs.existsSync(p)){const parent=path.dirname(p);if(parent===p)throw Error('SQLITE_PATH_MISSING');p=parent;}
 if(path.resolve(fs.realpathSync(p)).toLowerCase()!==p.toLowerCase())throw Error('SQLITE_PATH_REDIRECTION');
 return target;
}
function formalControl(control){
 control=plain(control);const marker=path.join(control,'identity.json');plain(marker);
 const identity=JSON.parse(fs.readFileSync(marker,'utf8'));
 if(path.basename(control)!=='.sqlite-storage'||identity.version!==1||identity.profile!==path.dirname(control))throw Error('SQLITE_STORAGE_IDENTITY_INVALID');
 return control;
}
function dataRoot(root,isolationRoot){
 root=plain(root);
 if(isolationRoot&&root.startsWith(plain(isolationRoot)+path.sep))return;
 const generation=path.dirname(root),generations=path.dirname(generation),control=path.dirname(generations);
 if(path.basename(root)!=='data'||path.basename(generations)!=='generations'||! /^[a-f0-9-]{36}$/.test(path.basename(generation)))throw Error('SQLITE_DATA_ROOT_INVALID');
 formalControl(control);
}
module.exports={plain,formalControl,dataRoot};
