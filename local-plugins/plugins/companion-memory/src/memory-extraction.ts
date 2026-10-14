import { L0_FIELDS } from "./profiles";
import { normalizeModelFacets, type MemoryFacets } from "./facets";

export interface ExtractionTranscriptTurn {
  id: string;
  userAt: string;
  assistantAt: string;
  user: string; memoryContext?: string;
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
  memoryAction?: "add" | "supplement" | "correct";
  targetMemoryId?: string;
  replaceText?: string;
  forbiddenOverclaims?: string[];
}

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
    || typeof reason !== "string" || !reason.trim() || reason.trim().length > 1500) return null;
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
    ...(value.memoryAction ? { memoryAction: value.memoryAction as ExtractedMemoryCandidate["memoryAction"] } : {}),
    ...(typeof value.targetMemoryId === "string" ? { targetMemoryId: value.targetMemoryId } : {}),
    ...(typeof value.replaceText === "string" ? { replaceText: value.replaceText } : {}),
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
    forbiddenOverclaims: forbidden,
    ...(typeof value.sourceQuote === "string" && value.sourceQuote.trim() ? { sourceQuote: value.sourceQuote.trim().slice(0, 500) } : {}),
    evidenceTurnRefs,
    ...(normalizedLayer === "L2" ? { facets: normalizeModelFacets(value.facets) } : {}),
  };
}

export function parseMemoryExtraction(raw: string, turnCount: number, previousMemories?: Array<{ id: string }>): ExtractedMemoryCandidate[] {
  // 增量审阅不能从截断响应中抢救局部写入。
  const parsed = previousMemories === undefined ? extractJsonArray(raw) : JSON.parse(raw.trim());
  if (!Array.isArray(parsed)) throw new Error(raw.trim() ? "提取结果 JSON 无效，保留待处理队列" : "提取模型返回空内容，保留待处理队列");
  const candidates: ExtractedMemoryCandidate[] = [];
  const reviewed = new Set<string>();
  for (const item of parsed) {
    if (previousMemories !== undefined) {
      const action = item?.memoryAction ?? "add";
      if (!["keep", "supplement", "correct", "add"].includes(action)) throw new Error("未知记忆操作");
      if (action !== "add") {
        if (!previousMemories.some(m => m.id === item.targetMemoryId) || reviewed.has(item.targetMemoryId)) throw new Error("旧记忆审阅目标无效或重复");
        reviewed.add(item.targetMemoryId);
        if (action === "keep") continue;
        if (item.layer !== "L2") throw new Error("增量修改仅允许 L2");
      } else if (item.targetMemoryId !== undefined) throw new Error("新增不能指定旧记忆目标");
    }
    if (item && typeof item === "object" && (item as Record<string, unknown>).shouldWrite === false) {
      if (previousMemories !== undefined && item.targetMemoryId) throw new Error("旧记忆审阅不可跳过，请使用 keep");
      continue;
    }
    const candidate = normalizeCandidate(item, turnCount);
    if (!candidate) {
      if (previousMemories !== undefined) throw new Error("候选字段无效");
      continue;
    }
    if (previousMemories !== undefined && /\bT\d+\b/u.test(candidate.content)) throw new Error("摘要包含临时轮次编号");
    if (candidate.layer !== "L0" || (candidate.certainty === "explicit" && candidate.attribution === "user_explicit")) candidates.push(candidate);
  }
  if (previousMemories?.some(m => !reviewed.has(m.id))) throw new Error("未审阅全部旧记忆");
  return candidates;
}

export function buildMemoryExtractionMessages(turns: ExtractionTranscriptTurn[], sessionId: string, previousMemories?: Array<{ id: string; content: string }>): ExtractionPromptMessage[] {
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
    "- 不得扩大原文的范围、程度或确定性，也不得丢失否定和条件；允许有依据的同义转述，不要求摘要与原文使用同一个词",
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
    ...(turn.memoryContext ? [turn.memoryContext, "以上通话/联机梗概仅用于理解，不是用户逐字原话；新事实证据仍须引用用户原文。"] : []),
    `AI时间：${turn.assistantAt}（本地：${new Date(turn.assistantAt).toLocaleString("zh-CN", { hour12: false })}）`,
    `AI：${turn.assistant}`,
  ].join("\n")).join("\n\n");
  const incrementalPrompt = previousMemories === undefined ? "" : [
    "增量记忆规则：先逐条审阅前置轮次的相关旧记忆，再提取未覆盖的新事实。",
    "每个旧记忆 ID 恰好输出一次 memoryAction=keep、supplement 或 correct，并指定 targetMemoryId。",
    "keep 仅需 memoryAction、targetMemoryId、reason。supplement/correct 仍须包含全部候选字段。",
    "同一事项新增细节用 supplement，summary 只写新增事实，程序完整保留旧内容再追加；禁止重写旧记忆。",
    "correct 仅用于用户明确纠正，replaceText 必须是旧内容中唯一匹配的待替换片段，summary 仅写替代文本；禁止删除记忆。",
    "supplement/correct 仅限 L2，变更必须有本批可写轮次的逐字用户证据。",
    "新增使用 memoryAction=add，不指定 targetMemoryId；不要重复新增已提供的事实。同一消息的不同事实分别保留。",
    "summary 禁止临时 T 编号；路径、名称、数字保持原文。evidenceQuotes 必须连续且唯一匹配用户原话，不能拼接或改标点。",
    "旧记忆不是用户证据，旧 T 编号不代表本批轮次。即使没有新增，也要完成全部旧记忆审阅。",
  ].join("\n");
  const userPrompt = [`conversationId: ${sessionId}`, "最近对话：", transcript,
    ...(previousMemories === undefined ? [] : ["前置轮次的相关记忆：", JSON.stringify(previousMemories)])].join("\n");
  return [{ role: "system", content: [systemPrompt, incrementalPrompt].filter(Boolean).join("\n") }, { role: "user", content: userPrompt }];
}
