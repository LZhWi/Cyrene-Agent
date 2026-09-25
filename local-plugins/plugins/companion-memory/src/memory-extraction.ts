import { L0_FIELDS } from "./profiles";
import { normalizeModelFacets, type MemoryFacets } from "./facets";

export interface ExtractionTranscriptTurn {
  id: string;
  userAt: string;
  assistantAt: string;
  user: string;
  assistant: string;
  writable: boolean;
}

export type ExtractionPromptMessage = { role: "system" | "user"; content: string };

export interface ExtractedMemoryCandidate {
  layer: "L0" | "L1" | "L2";
  field?: string;
  content: string;
  confidence: number;
  triggerText: string;
  importance: "low" | "medium" | "high";
  stability: "one_off" | "situational" | "stable";
  certainty: "explicit" | "inferred" | "uncertain";
  attribution: "user_explicit" | "assistant_inferred" | "mixed";
  evidenceQuotes: string[];
  contextSummary: string;
  reason: string;
  sourceQuote?: string;
  evidenceTurnRefs: string[];
  facets?: MemoryFacets;
}

const ABSOLUTE_TERMS = ["只", "永远", "从不", "一定", "完全", "绝对", "以后都", "不再"];
const L0_FIELD_DESCRIPTIONS: Record<keyof typeof L0_FIELDS, string> = {
  preferredName: '用户希望被如何称呼、叫什么名字、昵称。例如："叫我P宝""我叫Playa""以后喊我宝宝"',
  occupation: '用户的职业、身份、工作。例如："我是前端工程师""我在做设计"',
  longTermInterests: '用户的长期兴趣爱好（稳定的，不是临时的）。例如："我一直喜欢画画""我从小学钢琴"',
  language: '用户常用的语言或地区习惯。例如："我习惯说中文""我是广东人"',
  permanentNote: '其他不属于以上四类的稳定个人信息。例如："我有一只猫""我住在上海"',
};

function extractJsonArray(raw: string): unknown[] | null {
  let text = raw.replace(/<think>[\s\S]*?<\/think>/gi, "").replace(/<think>[\s\S]*$/gi, "")
    .replace(/```json\s*/gi, "").replace(/```\s*/gi, "").trim();
  const start = text.indexOf("[");
  if (start === -1) return null;
  text = text.slice(start);
  try {
    const parsed = JSON.parse(text);
    if (Array.isArray(parsed)) return parsed;
  } catch {}
  const results: unknown[] = [];
  let index = 0;
  while (index < text.length) {
    if (text[index] !== "{") { index += 1; continue; }
    let depth = 0, inString = false, escaped = false, end = index;
    for (; end < text.length; end += 1) {
      const char = text[end];
      if (escaped) { escaped = false; continue; }
      if (char === "\\") { escaped = true; continue; }
      if (char === '"') { inString = !inString; continue; }
      if (inString) continue;
      if (char === "{") depth += 1;
      else if (char === "}" && --depth === 0) break;
    }
    if (depth !== 0) break;
    try {
      const value = JSON.parse(text.slice(index, end + 1));
      if (value && typeof value === "object") results.push(value);
    } catch {}
    index = end + 1;
  }
  return results.length ? results : null;
}

function normalizeCandidate(input: unknown, maxTurn: number): ExtractedMemoryCandidate | null {
  if (!input || typeof input !== "object") return null;
  const value = input as Record<string, unknown>;
  const layer = value.layer;
  const summary = value.summary;
  const importance = value.importance;
  const stability = value.stability;
  const certainty = value.certainty;
  const attribution = value.attribution;
  const evidenceQuotes = Array.isArray(value.evidenceQuotes)
    ? value.evidenceQuotes.filter((item): item is string => typeof item === "string" && Boolean(item.trim())).map((item) => item.trim())
    : [];
  const contextSummary = value.contextSummary;
  const reason = value.reason;
  const forbidden = Array.isArray(value.forbiddenOverclaims)
    ? value.forbiddenOverclaims.filter((item): item is string => typeof item === "string" && Boolean(item.trim()))
    : [];
  if (!["L0", "L1", "L2"].includes(String(layer)) || typeof summary !== "string" || !summary.trim() || summary.trim().length > 1500
    || !["low", "medium", "high"].includes(String(importance))
    || !["one_off", "situational", "stable"].includes(String(stability))
    || !["explicit", "inferred", "uncertain"].includes(String(certainty))
    || !["user_explicit", "assistant_inferred", "mixed"].includes(String(attribution))
    || value.shouldWrite !== true || !evidenceQuotes.length || evidenceQuotes.some((quote) => quote.length > 1000)
    || typeof contextSummary !== "string" || !contextSummary.trim() || contextSummary.trim().length > 1500
    || typeof reason !== "string" || !reason.trim() || reason.trim().length > 1500 || forbidden.length
    || ABSOLUTE_TERMS.some((term) => summary.includes(term) && !evidenceQuotes.some((quote) => quote.includes(term)))) return null;
  const evidenceTurnRefs = Array.isArray(value.evidenceTurnRefs)
    ? [...new Set(value.evidenceTurnRefs.filter((item): item is string => {
      if (typeof item !== "string") return false;
      const index = Number(/^T(\d+)$/.exec(item.trim())?.[1] ?? 0);
      return index >= 1 && index <= maxTurn;
    }).map((item) => item.trim()))]
    : [];
  const normalizedLayer = layer as ExtractedMemoryCandidate["layer"];
  return {
    layer: normalizedLayer,
    ...(typeof value.field === "string" ? { field: value.field } : {}),
    content: summary.trim(),
    confidence: certainty === "explicit" ? 0.9 : certainty === "inferred" ? 0.65 : 0.4,
    triggerText: evidenceQuotes[0],
    importance: importance as ExtractedMemoryCandidate["importance"],
    stability: stability as ExtractedMemoryCandidate["stability"],
    certainty: certainty as ExtractedMemoryCandidate["certainty"],
    attribution: attribution as ExtractedMemoryCandidate["attribution"],
    evidenceQuotes,
    contextSummary: contextSummary.trim(),
    reason: reason.trim(),
    ...(typeof value.sourceQuote === "string" && value.sourceQuote.trim() ? { sourceQuote: value.sourceQuote.trim().slice(0, 500) } : {}),
    evidenceTurnRefs,
    ...(normalizedLayer === "L2" ? { facets: normalizeModelFacets(value.facets) } : {}),
  };
}

export function parseMemoryExtraction(raw: string, turnCount: number): ExtractedMemoryCandidate[] {
  const parsed = extractJsonArray(raw);
  if (!parsed) throw new Error(raw.trim() ? "提取结果 JSON 无效，保留待处理队列" : "提取模型返回空内容，保留待处理队列");
  const candidates: ExtractedMemoryCandidate[] = [];
  for (const item of parsed) {
    if (item && typeof item === "object" && (item as Record<string, unknown>).shouldWrite === false) continue;
    const candidate = normalizeCandidate(item, turnCount);
    if (!candidate) continue;
    if (candidate.layer !== "L0" || (candidate.certainty === "explicit" && candidate.attribution === "user_explicit")) candidates.push(candidate);
  }
  return candidates;
}

export function buildMemoryExtractionMessages(turns: ExtractionTranscriptTurn[], sessionId: string): ExtractionPromptMessage[] {
  const maxRef = `T1～T${turns.length}`;
  const writableRefs = turns.flatMap((turn, index) => turn.writable ? [`T${index + 1}`] : []);
  const systemPrompt = [
    "你是一个保守的记忆候选提取器，不是事实裁判，也不是用户画像改写器。",
    "你的目标是少记错，不是多记住。",
    "",
    "你只能提取用户明确表达、且未来确实有帮助的信息候选。",
    `本批只能从可写轮次提取新记忆（${writableRefs.join("/")}）；只读上下文只能帮助理解，不能单独成为新记忆来源。`,
    "禁止把推断写成确定事实；禁止把一次性状态写成长期偏好；禁止为了输出而输出。",
    "如果最近这些对话没有值得记的内容，必须返回空数组 []。",
    "",
    "记忆层级定义：",
    "- L0：用户稳定身份信息或核心画像。只有 certainty=explicit 且 attribution=user_explicit 才允许进入 L0。",
    "  识别到 L0 信息时，必须同时在 field 字段里指定要写入哪个格子。",
    "  可用的 field 值如下（只能用这些，不能自己发明）：",
    Object.entries(L0_FIELD_DESCRIPTIONS).map(([field, description]) => `  · ${field}：${description}`).join("\n"),
    "",
    "  重要：field 的值必须严格是上方列出的英文字段名，",
    "  例如 preferredName、occupation，",
    "  不能用 nickname、name、job 等其他词。",
    "- L1：用户近期目标或阶段性偏好，只能写近期状态，不要写成长期偏好。",
    "- L2：具体事件、经历、局部偏好、情绪背景、待观察信息。",
    "",
    "判断原则：",
    "- 宁可漏记，不要误记",
    "- 纯日常问候、闲聊、情绪发泄（无信息量）→ 返回空数组",
    "- summary 必须忠于用户原话和上下文，不要自行推广范围",
    "- 如果只是 AI 的建议、安慰、总结、推断，不要写成用户事实",
    "- 不要把「这次」「刚刚」「这个话题里」变成长期偏好",
    "- 用户明确表达的未来计划、承诺或约定，即使依赖某个前置条件，只要对未来对话有帮助，也应按原条件保守记录；不要仅因含有「等……以后」「如果……」就返回空数组",
    "- 不要自动使用绝对化表达：只、永远、从不、一定、完全、绝对、以后都、不再，除非用户原话明确说过这些词",
    "- 如果 summary 中存在可能过度概括的词，必须写入 forbiddenOverclaims；有 forbiddenOverclaims 时 shouldWrite 必须是 false",
    "",
    "重要格式规则：",
    '- summary 和 evidenceQuotes 字段的值里，禁止出现英文双引号 "',
    "- 如果内容里有引号，统一用中文引号「」替代，例如：用户希望被称为「宝宝」",
    "- 不要用 markdown 代码块包裹 JSON，直接输出裸 JSON",
    "- 数组第一个字符必须是 [，最后一个字符必须是 ]",
    "",
    "输出格式为 JSON 数组，禁止用 markdown 代码块包裹，直接输出裸 JSON。",
    "",
    "每个候选必须包含这些字段：",
    "{",
    '  "layer": "L0",',
    '  "field": "preferredName",',
    '  "summary": "保守、可追溯的候选摘要",',
    '  "importance": "low|medium|high",',
    '  "stability": "one_off|situational|stable",',
    '  "certainty": "explicit|inferred|uncertain",',
    '  "attribution": "user_explicit|assistant_inferred|mixed",',
    '  "evidenceQuotes": ["用户原话短引文，必须来自用户"],',
    '  "evidenceTurnRefs": ["T1"],',
    '  "sourceQuote": "L2 原文对话片段，仅 L2 输出",',
    '  "facets": { "primaryKind": "commitment|preference|goal|wish|experience|fact|emotion|other", "retrievalKinds": ["最多 3 个固定类型，且包含 primaryKind"] },',
    '  "contextSummary": "最近多轮上下文概括，不超过80字",',
    '  "shouldWrite": true,',
    '  "reason": "为什么值得记，或为什么不写",',
    '  "forbiddenOverclaims": []',
    "}",
    "",
    "L1/L2 不需要 field。",
    `每个候选必须用 evidenceTurnRefs 指出其事实依据来自哪些临时轮次（${maxRef}）；只列真正支持该候选的轮次，不要把整个上下文窗口都列入。`,
    `每个候选至少引用一个可写轮次（本批可写引用：${writableRefs.join("/")}）；只读轮次不能单独成为新记忆来源。`,
    "解释候选中的相对时间（今天、明天、昨天、刚才、最近等）时，必须以 evidenceTurnRefs 所指轮次中事实所在消息的用户时间或 AI 时间为基准；MemoryJudge 当前运行或返回结果的时间不是事实时间锚点。",
    "候选由多个 evidenceTurnRefs 支持时，必须按各轮消息时间分别解释相对时间，不得把不同轮次的相对表达合并成同一个日期；无法唯一确定时保留不确定性，不要编造具体日期，也不要把已经发生的内容改写成未来计划。",
    "L2 候选必须额外输出 sourceQuote 字段（L0/L1 不输出）：",
    "- sourceQuote = 从最近对话里挑出的最有信息量的一段原文（用户或对话原话），软上限 500 字",
    "- 目的：summary 是浓缩结论，会丢失专有名词/数字/代码等字面信息；sourceQuote 保留「用户当时说的原话」，召回时提供字面证据",
    "- 不要整段照抄对话，优先挑含专有名词、数字、代码、关键名词的句子；不要把 summary 复制进 sourceQuote",
    "- sourceQuote 里如有引号，同样用「」替代英文双引号",
    "L2 候选必须额外输出 facets.primaryKind 与 facets.retrievalKinds；两者只能使用 commitment|preference|goal|wish|experience|fact|emotion|other。",
    "primaryKind 是最核心且唯一的主类，用于生命周期判断；retrievalKinds 只用于检索召回，必须包含 primaryKind，去重后最多 3 个。",
    "只添加正文直接支持的检索类型，不要为了凑数添加；有具体类型时不得同时包含 other。",
    "明确约定、承诺、答应或双方说好的未来事项用 commitment；不要把期待、愿望、假设或 AI 单方面畅想误标为约定。",
    "有行动意图、准备实现的计划用 goal；单方面或双方共同期待、希望发生但没有行动承诺的未来状态用 wish。",
    "已经完成的目标不再标 goal：完成事件用 experience，完成后的当前状态可用 fact。",
    "只有用户明确表达具体情绪时才用 emotion；不要从语气、事件或 AI 回应推断用户情绪。",
    "inferred / uncertain 不允许进入 L0；如果还值得保留，只能放 L2，或者 shouldWrite=false。",
    "没有值得记录的信息时，输出：[]",
    "summary 和 evidenceQuotes 里禁止出现英文双引号，用「」替代。",
  ].join("\n");
  const transcript = turns.map((turn, index) => [
    `T${index + 1}（第 ${index + 1} 轮，${turn.writable ? "可写" : "只读上下文"}）：`,
    `用户时间：${turn.userAt}（本地：${new Date(turn.userAt).toLocaleString("zh-CN", { hour12: false })}）`,
    `用户：${turn.user}`,
    `AI时间：${turn.assistantAt}（本地：${new Date(turn.assistantAt).toLocaleString("zh-CN", { hour12: false })}）`,
    `AI：${turn.assistant}`,
  ].join("\n")).join("\n\n");
  const userPrompt = [`conversationId: ${sessionId}`, "最近对话：", transcript].join("\n");
  return [{ role: "system", content: systemPrompt }, { role: "user", content: userPrompt }];
}
