"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { parentPort, workerData } = require("node:worker_threads");

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; }
}

function compact(value, max = 600) {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, max) : "";
}

function tokens(text) {
  const normalized = String(text || "").toLowerCase()
    .replace(/湖边|河边|海边|临水/g, "水边 临水 湖边 河边 海边")
    .replace(/住处|住所|基地/g, "家 建家 住处 基地");
  const latin = normalized.match(/[a-z0-9_]{2,}/g) || [];
  const cjk = (normalized.match(/[\u3400-\u9fff]+/g) || []).flatMap((run) => {
    const chars = [...run];
    return [...chars, ...chars.slice(0, -1).map((char, index) => char + chars[index + 1])];
  });
  return [...new Set([...latin, ...cjk])];
}

function score(text, queryTokens, query) {
  const source = String(text || "").toLowerCase();
  if (!source) return 0;
  let hits = 0;
  let bigrams = 0;
  let latinHits = 0;
  for (const token of queryTokens) {
    if (!source.includes(token)) continue;
    hits += token.length > 1 ? 2 : 0.35;
    if (token.length === 2) bigrams += 1;
    if (/^[a-z0-9_]{2,}$/.test(token)) latinHits += 1;
  }
  const coverage = hits / Math.max(1, queryTokens.length);
  const phrase = query.length >= 3 && source.includes(query.toLowerCase()) ? 8 : 0;
  if (!phrase && bigrams === 0 && latinHits === 0) return 0;
  return phrase + hits + coverage * 5 + bigrams * 0.5;
}

function topUnique(items, limit) {
  const seen = new Set();
  return items.sort((a, b) => b.score - a.score || b.at - a.at).flatMap((item) => {
    const key = item.text.toLowerCase();
    if (!item.text || seen.has(key)) return [];
    seen.add(key);
    return [item];
  }).slice(0, limit);
}

function retrieveMemories(userData, queryTokens, query) {
  const store = readJson(path.join(userData, "memory.json"));
  if (!store || typeof store !== "object") return [];
  const candidates = [];
  for (const layer of [store.l0, store.l1]) {
    if (!layer || typeof layer !== "object") continue;
    for (const value of Object.values(layer)) {
      const text = compact(value, 360);
      if (text) candidates.push({ text, score: score(text, queryTokens, query) + 0.4, at: 0 });
    }
  }
  for (const item of Array.isArray(store.l2) ? store.l2 : []) {
    if (!item || typeof item !== "object") continue;
    if (!item.isPinned && item.status !== "active" && item.status !== "aging") continue;
    const text = compact(item.content, 420);
    const searchText = `${text}\n${compact(item.triggerText, 420)}`;
    const ranked = score(searchText, queryTokens, query) + (item.isPinned ? 1.5 : 0);
    if (text && ranked > 0) candidates.push({ text, score: ranked, at: Number(item.createdAt || item.lastAccessedAt) || 0 });
  }
  return topUnique(candidates, 5).map((item) => item.text);
}

function latestOccurrence(metadata, fallback) {
  const occurrences = Array.isArray(metadata?.occurrences) ? metadata.occurrences : [];
  return occurrences.reduce((best, item) => item && Number(item.ts) > Number(best?.ts || 0) ? item : best, null)
    || { role: metadata?.role, ts: fallback };
}

function retrieveConversation(userData, queryTokens, query) {
  const vectorStore = readJson(path.join(userData, "rag-data", "memory-store.json"));
  if (!Array.isArray(vectorStore)) return [];
  const candidates = [];
  for (const entry of vectorStore) {
    if (!entry || entry.source !== "chat_history") continue;
    const text = compact(entry.text, 600);
    const ranked = score(text, queryTokens, query);
    if (!text || ranked <= 0) continue;
    const occurrence = latestOccurrence(entry.metadata, entry.createdAt);
    candidates.push({ text, score: ranked, at: Number(occurrence.ts) || Number(entry.createdAt) || 0, role: occurrence.role });
  }
  return topUnique(candidates, 5).map((item) => ({
    role: item.role === "assistant" || item.role === "model" ? "assistant" : "user",
    content: item.text,
    ...(item.at ? { at: item.at } : {}),
  }));
}

const userData = String(workerData?.userData || "");
const query = compact(workerData?.query, 300);
const queryTokens = tokens(query);
parentPort.postMessage({
  conversation: retrieveConversation(userData, queryTokens, query),
  memories: retrieveMemories(userData, queryTokens, query),
});
