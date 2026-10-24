const fs=require('node:fs'),path=require('node:path');
module.exports=(stage,data,user)=>{
 const config=JSON.parse(fs.readFileSync(path.join(stage,'isolation.json'),'utf8'));
 const inside=(base,p)=>{const r=path.relative(base,p);return r!==''&&!r.startsWith('..')&&!path.isAbsolute(r);};
 const real=p=>{let q=p;while(!fs.existsSync(q)){const parent=path.dirname(q);if(parent===q)throw Error('SQLITE_ISOLATION_REQUIRED');q=parent;}return fs.realpathSync(q)===q;};
 if(config.version!==1||config.purpose!=='sqlite-candidate-isolation'||config.root!==stage
  ||path.basename(path.dirname(stage))!=='.runtime'||!real(stage)||!real(data)||!real(user)
  ||!inside(path.join(stage,'runtime'),data)||!inside(stage,user))throw Error('SQLITE_ISOLATION_REQUIRED');
};
