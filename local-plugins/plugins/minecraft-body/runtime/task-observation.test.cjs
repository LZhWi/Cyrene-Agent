"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { recipeCatalog } = require("./task-observation.cjs");
const data = { version: { minecraftVersion: "1.21.11" }, items: { 1:{name:"oak_log"},2:{name:"oak_planks"},3:{name:"stick"},4:{name:"wooden_pickaxe"},5:{name:"crafting_table"} }, recipes: { 3:[{inShape:[[2],[2]],result:{id:3,count:4}}],5:[{inShape:[[2,2],[2,2]],result:{id:5,count:1}}],2:[{ingredients:[1],result:{id:2,count:4}}],4:[{inShape:[[2,2,2],[-1,3,-1],[-1,3,-1]],result:{id:4,count:1}}] } };
test("full version-matched recipe normalization does not depend on inventory or recipesFor", () => {
  const result = recipeCatalog({version:"1.21.11", recipesFor:()=>{throw new Error("must not call");}}, () => () => data);
  assert.equal(result.supported,true); assert.equal(result.recipes.length,4);
  assert.deepEqual(result.recipes.find(r=>r.output.name==="wooden_pickaxe").ingredients,[{name:"oak_planks",count:3},{name:"stick",count:2}]);
  assert.equal(result.recipes.find(r=>r.output.name==="wooden_pickaxe").requiresTable,true); assert.equal(result.recipes[0].requiresTable,false);
});
test("missing dependencies, mismatched versions, malformed data fail closed without installation", () => {
  assert.equal(recipeCatalog({version:"1.21.11"}, () => { throw new Error("MODULE_NOT_FOUND"); }).supported,false);
  assert.equal(recipeCatalog({version:"1.21.10"}, () => { throw new Error("must not load"); }).supported,false);
  assert.equal(recipeCatalog({version:"1.21.11"}, () => () => ({...data,version:{minecraftVersion:"1.21.10"}})).supported,false);
});
let realData;
try { realData = require("minecraft-data"); } catch {}
test("installed real 1.21.11 registry retains every scoped variant with empty inventory", { skip: !realData && "Optional runtime dependencies are not installed; no query installs them" }, () => {
  const raw = realData("1.21.11");
  const actual = recipeCatalog({version:"1.21.11",inventory:{items:()=>[]},recipesFor:()=>[]});
  assert.equal(actual.supported,true,actual.reason);
  for (const name of ["oak_planks","stick","crafting_table","wooden_pickaxe"]) {
    const id = raw.itemsByName[name].id;
    assert.equal(actual.recipes.filter(r=>r.output.name===name).length,raw.recipes[id].length);
  }
  assert.ok(JSON.stringify(actual).length < 512000);
  const pick = actual.recipes.find(r=>r.output.name==="wooden_pickaxe" && r.ingredients.some(i=>i.name==="oak_planks"));
  assert.deepEqual(pick.ingredients,[{name:"oak_planks",count:3},{name:"stick",count:2}]);
  assert.equal(pick.requiresTable,true);
});
