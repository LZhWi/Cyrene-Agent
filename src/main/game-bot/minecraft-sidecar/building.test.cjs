"use strict";
const test=require("node:test"),assert=require("node:assert/strict"),{shelterTargets}=require("./building.cjs");
test("plans a 4x4 shelter with a two-block doorway and full roof",()=>{const plan=shelterTargets({x:0,y:64,z:0});assert.equal(plan.walls.length,22);assert.equal(plan.roof.length,16);assert.equal(plan.all.length,38);assert.deepEqual(plan.door,[{x:1,y:64,z:0},{x:1,y:65,z:0}]);assert.equal(plan.all.some(p=>p.x===1&&p.y===64&&p.z===0),false);});
