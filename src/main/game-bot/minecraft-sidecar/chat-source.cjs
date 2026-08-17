"use strict";

function translationKey(translate, jsonMessage) {
  const candidates = [
    translate,
    jsonMessage?.translate,
    jsonMessage?.json?.translate,
    typeof jsonMessage?.toJSON === "function" ? jsonMessage.toJSON()?.translate : null,
  ];
  return candidates.find((value) => typeof value === "string" && value.trim()) || "";
}

function isPlayerCommandFeedback(message, translate, jsonMessage) {
  const key = translationKey(translate, jsonMessage);
  if (/^(?:commands\.|argument\.|command\.)/i.test(key)) return true;
  const text = String(message || "").trim();
  return /^(?:Set the time to \d+|将时间设为\s*\d+|The time was set to \d+|Set own game mode to |Set the weather to |The difficulty has been set to |Teleported |Gave \d+ |Filled \d+ blocks?|Changed the block at )/i.test(text);
}

function commandFeedbackContext(message) {
  return `用户执行了一条 Minecraft 游戏指令；系统反馈：${String(message || "").trim()}。这是用户操作游戏产生的反馈，不是对 GameBot 的命令。`;
}

module.exports = { commandFeedbackContext, isPlayerCommandFeedback, translationKey };
