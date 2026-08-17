"use strict";

function needsTorch(block, torchCount) {
  return Number(torchCount) > 1
    && block?.boundingBox === "empty"
    && Number(block.skyLight) <= 3
    && Number(block.light) <= 4;
}

module.exports = { needsTorch };
