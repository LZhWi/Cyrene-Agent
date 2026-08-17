"use strict";
const test = require("node:test"); const assert = require("node:assert/strict"); const { bestArmor, bestWeapon, isHostile, threatResponse } = require("./combat.cjs");
test("selects stronger armor and weapons",()=>{assert.equal(bestArmor([{name:"leather_helmet"},{name:"iron_helmet"}],"_helmet").name,"iron_helmet");assert.equal(bestWeapon([{name:"stone_axe"},{name:"iron_sword"}]).name,"iron_sword");});
test("distinguishes hostile mobs from passive mobs",()=>{assert.equal(isHostile({name:"zombie"}),true);assert.equal(isHostile({name:"cow",kind:"Passive mobs"}),false);});
test("prioritizes creeper distance and ranged defense",()=>{
  assert.equal(threatResponse({name:"creeper",distance:5,hasShield:true,hasBow:true,hasArrow:true}),"flee");
  assert.equal(threatResponse({name:"skeleton",distance:9,hasShield:true,hasBow:true,hasArrow:true}),"shield");
  assert.equal(threatResponse({name:"skeleton",distance:3,hasShield:true,hasBow:true,hasArrow:true}),"melee");
  assert.equal(threatResponse({name:"zombie",distance:3,hasShield:false,hasBow:false,hasArrow:false}),"melee");
  assert.equal(threatResponse({name:"zombie",distance:10,hasShield:false,hasBow:true,hasArrow:true}),"bow");
  assert.equal(threatResponse({name:"zombie",distance:10,hasShield:false,hasBow:false,hasArrow:false}),"none");
});
