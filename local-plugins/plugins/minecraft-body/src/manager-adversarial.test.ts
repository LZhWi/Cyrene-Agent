import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { BodyManager } from "./manager";
class Child extends EventEmitter {
  connected=true; rejectRelease=true; observation:any={connected:true,activeAction:null};
  send(m:any,cb?:(e:null)=>void){ cb?.(null); if(m.type==="task-control")queueMicrotask(()=>this.emit("message",{type:"task-reply",id:m.id,data:m.op==="release"&&this.rejectRelease?{error:"release failed"}:{value:m.op==="observe"?this.observation:undefined}})); if(m.type==="stop")queueMicrotask(()=>this.kill()); return true; }
  kill(){this.connected=false;this.emit("exit",0);return true;}
}
it("confirmed process exit clears stale lease after failed release, allowing explicit reconnect",async()=>{
  const root=await mkdtemp(path.join(os.tmpdir(),"mc-manager-review-"));const children:Child[]=[];
  const manager=new BodyManager(path.join(__dirname,"../runtime"),root,(()=>{const child=new Child();children.push(child);return child;}) as any);
  const region={dimension:"overworld",min:{x:0,y:60,z:0},max:{x:4,y:70,z:4}};
  const config={host:"localhost",port:25565,username:"Cyrene",owner:"Owner",auth:"offline",version:""};
  try {
    await manager.start(config);children[0].emit("message",{type:"state",data:{connected:true}});
    await manager.acquireTask("old",region);await expect(manager.releaseTask("old")).rejects.toThrow("release failed");
    await manager.stop();await manager.start(config);children[1].emit("message",{type:"state",data:{connected:true}});
    await expect(manager.acquireTask("new",region)).resolves.toBeUndefined();
  }finally{await manager.close();await rm(root,{recursive:true,force:true});}
});

it("acknowledgement checks fresh runtime draining state, not stale heartbeat",async()=>{
  const root=await mkdtemp(path.join(os.tmpdir(),"mc-manager-ack-"));const child=new Child();
  const manager=new BodyManager(path.join(__dirname,"../runtime"),root,(()=>child) as any);
  const region={dimension:"overworld",min:{x:0,y:60,z:0},max:{x:4,y:70,z:4}};
  try {
    await manager.start({host:"localhost",port:25565,username:"Cyrene",owner:"Owner",auth:"offline",version:""});
    child.emit("message",{type:"state",data:{connected:true,activeAction:null}});
    child.observation={connected:true,activeAction:{id:"late",draining:true}};
    await expect(manager.assertQuiescent(region)).rejects.toThrow(/draining/);
    child.observation={connected:true,activeAction:null};
    await expect(manager.assertQuiescent(region)).resolves.toBeUndefined();
  }finally{await manager.close();await rm(root,{recursive:true,force:true});}
});
