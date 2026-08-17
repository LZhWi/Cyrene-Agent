"use strict";

const prismarineBlock = require("prismarine-block");
const registryLoader = require("prismarine-registry");
const BitArray = require("prismarine-chunk/src/pc/common/BitArrayNoSpan");

function createStateIdMapper(sourceVersion, targetVersion) {
  if (!sourceVersion || !targetVersion || sourceVersion === targetVersion) return (stateId) => stateId;
  const sourceRegistry = registryLoader(sourceVersion);
  const targetRegistry = registryLoader(targetVersion);
  const SourceBlock = prismarineBlock(sourceRegistry);
  const TargetBlock = prismarineBlock(targetRegistry);
  const cache = new Map();
  const targetAir = targetRegistry.blocksByName.air?.defaultState ?? 0;

  return (stateId) => {
    const numeric = Number(stateId) || 0;
    if (cache.has(numeric)) return cache.get(numeric);
    const source = SourceBlock.fromStateId(numeric);
    const targetDefinition = targetRegistry.blocksByName[source.name];
    let mapped = targetAir;
    if (targetDefinition) {
      try {
        mapped = TargetBlock.fromProperties(targetDefinition.id, source.getProperties()).stateId;
      } catch {
        mapped = targetDefinition.defaultState;
      }
    }
    cache.set(numeric, mapped);
    return mapped;
  };
}

function remapPaletteContainer(containerJson, mapStateId) {
  const container = JSON.parse(containerJson);
  if (container.type === "single") {
    container.value = mapStateId(container.value);
  } else if (container.type === "indirect") {
    container.palette = container.palette.map(mapStateId);
  } else if (container.type === "direct") {
    const values = BitArray.fromJson(container.data);
    for (let index = 0; index < values.capacity; index += 1) values.set(index, mapStateId(values.get(index)));
    container.data = values.toJson();
  }
  return JSON.stringify(container);
}

function remapChunkJson(chunkJson, mapStateId) {
  const chunk = JSON.parse(chunkJson);
  chunk.sections = (chunk.sections || []).map((sectionJson) => {
    const section = JSON.parse(sectionJson);
    section.data = remapPaletteContainer(section.data, mapStateId);
    return JSON.stringify(section);
  });
  return JSON.stringify(chunk);
}

function remapViewerEvent(event, payload, mapStateId) {
  if (event === "loadChunk" && payload?.chunk) return { ...payload, chunk: remapChunkJson(payload.chunk, mapStateId) };
  if (event === "blockUpdate" && payload) return { ...payload, stateId: mapStateId(payload.stateId) };
  return payload;
}

module.exports = { createStateIdMapper, remapChunkJson, remapPaletteContainer, remapViewerEvent };
