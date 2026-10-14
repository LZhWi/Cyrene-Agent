"use strict";
const ESCAPE_BLOCKS = Object.freeze(["dirt", "cobblestone", "netherrack", "cobbled_deepslate"]);
const ESCAPE_RESERVE = 3;
const countMatching = (items, names) => items.filter((item) => names.includes(item.name)).reduce((sum, item) => sum + item.count, 0);
const escapeBlockCount = (items) => countMatching(items, ESCAPE_BLOCKS);
function transferableCount({ available, totalEscapeBlocks, reserveLimited }) {
  return reserveLimited ? Math.min(available, Math.max(0, totalEscapeBlocks - ESCAPE_RESERVE)) : available;
}
module.exports = { ESCAPE_BLOCKS, ESCAPE_RESERVE, countMatching, escapeBlockCount, transferableCount };
