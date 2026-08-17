"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const registryLoader = require("prismarine-registry");
const { createStateIdMapper, remapChunkJson, remapViewerEvent } = require("./viewer-compat.cjs");

test("maps newer block state ids to the viewer's supported registry by block identity", () => {
  const source = registryLoader("1.21.11");
  const target = registryLoader("1.21.4");
  const mapStateId = createStateIdMapper("1.21.11", "1.21.4");
  for (const name of ["grass_block", "oak_log", "oak_leaves", "sand", "water"]) {
    const mapped = mapStateId(source.blocksByName[name].defaultState);
    assert.equal(target.blocksByStateId[mapped].name, name);
  }
});

test("remaps single and indirect chunk palettes before sending them to the older viewer", () => {
  const source = registryLoader("1.21.11");
  const target = registryLoader("1.21.4");
  const mapStateId = createStateIdMapper("1.21.11", "1.21.4");
  const section = (data) => JSON.stringify({ data: JSON.stringify(data), solidBlockCount: 1 });
  const chunkJson = JSON.stringify({ sections: [
    section({ type: "single", value: source.blocksByName.oak_leaves.defaultState }),
    section({ type: "indirect", palette: [source.blocksByName.air.defaultState, source.blocksByName.oak_log.defaultState], data: "{}" }),
  ] });
  const remapped = JSON.parse(remapChunkJson(chunkJson, mapStateId));
  const single = JSON.parse(JSON.parse(remapped.sections[0]).data);
  const indirect = JSON.parse(JSON.parse(remapped.sections[1]).data);
  assert.equal(target.blocksByStateId[single.value].name, "oak_leaves");
  assert.deepEqual(indirect.palette.map((id) => target.blocksByStateId[id].name), ["air", "oak_log"]);
});

test("remaps incremental block updates through the same compatibility table", () => {
  const source = registryLoader("1.21.11");
  const target = registryLoader("1.21.4");
  const payload = remapViewerEvent("blockUpdate", { stateId: source.blocksByName.birch_log.defaultState }, createStateIdMapper("1.21.11", "1.21.4"));
  assert.equal(target.blocksByStateId[payload.stateId].name, "birch_log");
});
