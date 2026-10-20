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

it("fresh observation frees the completed slot immediately without waiting for heartbeat",async()=>{
  const root=await mkdtemp(path.join(os.tmpdir(),"mc-manager-next-"));const child=new Child();
  const send=child.send.bind(child);let actions=0;
  child.send=(m:any,cb?:any)=>{
    if(m.type!=="action")return send(m,cb);
    cb?.(null);actions++;
    queueMicrotask(()=>{
      child.emit("message",{type:"state",data:{connected:true,activeAction:{id:m.request.id,action:m.request.action,draining:true}}});
      child.emit("message",{type:"result",data:{id:m.request.id,action:m.request.action,status:"completed"}});
      // No idle heartbeat: the query reply is the only fresh idle evidence.
    });return true;
  };
  const manager=new BodyManager(path.join(__dirname,"../runtime"),root,(()=>child) as any);
  const region={dimension:"overworld",min:{x:0,y:60,z:0},max:{x:4,y:70,z:4}};
  try {
    await manager.start({host:"localhost",port:25565,username:"Cyrene",owner:"Owner",auth:"offline",version:""});
    child.emit("message",{type:"state",data:{connected:true,activeAction:null}});
    await manager.acquireTask("task",region);
    await expect(manager.taskAction("task",{action:"equip",material:"wooden_pickaxe"},region)).resolves.toMatchObject({status:"completed"});
    expect(manager.status().state.activeAction).toBeNull();
    await expect(manager.taskAction("task",{action:"equip",material:"wooden_pickaxe"},region)).resolves.toMatchObject({status:"completed"});
    expect(actions).toBe(2);
  }finally{await manager.close();await rm(root,{recursive:true,force:true});}
});

it("an old idle observation cannot clear a newly submitted action or pending fence",async()=>{
  const root=await mkdtemp(path.join(os.tmpdir(),"mc-manager-stale-"));const child=new Child();
  const send=child.send.bind(child);let heldQuery:any;let submitted:any;let hold=true;
  child.send=(m:any,cb?:any)=>{
    if(m.type==="task-control"&&m.op==="observe"&&hold){heldQuery=m;cb?.(null);return true;}
    if(m.type==="action"){submitted=m.request;cb?.(null);return true;}
    return send(m,cb);
  };
  const manager=new BodyManager(path.join(__dirname,"../runtime"),root,(()=>child) as any);
  const region={dimension:"overworld",min:{x:0,y:60,z:0},max:{x:4,y:70,z:4}};
  try {
    await manager.start({host:"localhost",port:25565,username:"Cyrene",owner:"Owner",auth:"offline",version:""});
    child.emit("message",{type:"state",data:{connected:true,activeAction:null}});
    await manager.acquireTask("task",region);
    const old=manager.observeTask("task",region);const stale=expect(old).rejects.toThrow(/过期/);
    const running=manager.taskAction("task",{action:"equip",material:"wooden_pickaxe"},region);
    child.emit("message",{type:"state",data:{connected:true,activeAction:{id:submitted.id,draining:true}}});
    child.emit("message",{type:"task-reply",id:heldQuery.id,data:{value:{connected:true,activeAction:null}}});
    await stale;
    expect(manager.status().state.activeAction.id).toBe(submitted.id);
    await expect(manager.taskAction("task",{action:"equip",material:"wooden_pickaxe"},region)).rejects.toThrow(/已有动作/);
    hold=false;child.emit("message",{type:"result",data:{id:submitted.id,action:"equip",status:"completed"}});
    await expect(running).resolves.toMatchObject({status:"completed"});
  }finally{await manager.close();await rm(root,{recursive:true,force:true});}
});

it("a first heartbeat for the same submitted action does not invalidate its later idle observation",async()=>{
  const root=await mkdtemp(path.join(os.tmpdir(),"mc-manager-same-action-"));const child=new Child();
  const send=child.send.bind(child);let submitted:any;
  child.send=(m:any,cb?:any)=>{
    if(m.type==="action"){
      submitted=m.request;cb?.(null);
      queueMicrotask(()=>child.emit("message",{type:"result",data:{id:submitted.id,action:"equip",status:"completed"}}));return true;
    }
    if(m.type==="task-control"&&m.op==="observe"){
      cb?.(null);queueMicrotask(()=>{
        // The terminal result arrived first; the query is already in flight.
        child.emit("message",{type:"state",data:{connected:true,activeAction:{id:submitted.id,draining:true}}});
        child.emit("message",{type:"task-reply",id:m.id,data:{value:{connected:true,activeAction:null}}});
      });return true;
    }
    return send(m,cb);
  };
  const manager=new BodyManager(path.join(__dirname,"../runtime"),root,(()=>child) as any);
  const region={dimension:"overworld",min:{x:0,y:60,z:0},max:{x:4,y:70,z:4}};
  try {
    await manager.start({host:"localhost",port:25565,username:"Cyrene",owner:"Owner",auth:"offline",version:""});
    child.emit("message",{type:"state",data:{connected:true,activeAction:null}});
    await manager.acquireTask("task",region);
    await expect(manager.taskAction("task",{action:"equip",material:"wooden_pickaxe"},region)).resolves.toMatchObject({status:"completed"});
    expect(manager.status().state.activeAction).toBeNull();
  }finally{await manager.close();await rm(root,{recursive:true,force:true});}
});

it("out-of-order observations and disconnect cannot restore stale idle/connected state",async()=>{
  const root=await mkdtemp(path.join(os.tmpdir(),"mc-manager-query-order-"));const child=new Child();
  const send=child.send.bind(child);const queries:any[]=[];
  child.send=(m:any,cb?:any)=>{if(m.type==="task-control"&&m.op==="observe"){queries.push(m);cb?.(null);return true;}return send(m,cb);};
  const manager=new BodyManager(path.join(__dirname,"../runtime"),root,(()=>child) as any);
  const region={dimension:"overworld",min:{x:0,y:60,z:0},max:{x:4,y:70,z:4}};
  const reply=(i:number,value:any)=>child.emit("message",{type:"task-reply",id:queries[i].id,data:{value}});
  try {
    await manager.start({host:"localhost",port:25565,username:"Cyrene",owner:"Owner",auth:"offline",version:""});
    child.emit("message",{type:"state",data:{connected:true,activeAction:null}});
    await manager.acquireTask("task",region);
    const older=manager.observeTask("task",region), newer=manager.observeTask("task",region);
    const rejected=expect(older).rejects.toThrow(/过期/);
    reply(1,{connected:true,activeAction:null,inventory:{oak_log:2}});await newer;
    reply(0,{connected:true,activeAction:null,inventory:{oak_log:1}});await rejected;
    expect(manager.status().state.inventory.oak_log).toBe(2);
    const beforeEnd=manager.observeTask("task",region);const disconnected=expect(beforeEnd).rejects.toThrow(/过期/);
    child.emit("message",{type:"ended",data:"connection lost"});
    reply(2,{connected:true,activeAction:null});await disconnected;
    expect(manager.status().state.connected).toBe(false);
  }finally{await manager.close();await rm(root,{recursive:true,force:true});}
});
