"use strict";

function compactMessage(message) {
  return String(message || "").replace(/\s+/g, " ").trim();
}

function splitChatMessage(message, maxLength = 220) {
  const remaining = Array.from(String(message || "").trim());
  const chunks = [];
  const limit = Math.max(40, Math.min(Number(maxLength) || 220, 240));
  while (remaining.length > limit) {
    let end = limit;
    const minimum = Math.floor(limit * 0.6);
    for (let index = limit - 1; index >= minimum; index -= 1) {
      if (/[。！？；，,.!?;\s]/.test(remaining[index])) {
        end = index + 1;
        break;
      }
    }
    const chunk = remaining.splice(0, end).join("").trim();
    if (chunk) chunks.push(chunk);
  }
  const tail = remaining.join("").trim();
  if (tail) chunks.push(tail);
  return chunks;
}

function createChatOutput({ sendChat, log }) {
  return {
    internal(message, label = "动作") {
      const text = compactMessage(message);
      if (text) log(`Minecraft ${label}：${text}`);
      return text;
    },
    model(message) {
      const text = String(message || "").trim();
      if (!text) return false;
      for (const chunk of splitChatMessage(text)) sendChat(chunk);
      return true;
    },
  };
}

module.exports = { compactMessage, createChatOutput, splitChatMessage };
