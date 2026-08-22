import * as fs from "fs"
import * as path from "path"
import { getAdapterForConfig } from "../orchestrator/vendors"
import type { VendorConfig, ChatMessage } from "../orchestrator/vendors"
import { getUserDataDir } from "../runtime/runtime-paths"
import { MemoryCandidate, L0_FIELD_DESCRIPTIONS, MemoryJudgeTurn } from "./memory-types"
import { recordUsage } from "../token-usage-store"
import { normalizeMemoryFacets, tryNormalizeModelFacets, type MemoryFacets } from "./memory-facets"

interface ModelSettings {
  provider: string
  baseUrl: string
  model: string
  apiKey: string
  explicitTransport?: "openai" | "anthropic" | "auto"
}

const DEFAULT_MODEL_SETTINGS: ModelSettings = {
  provider: "DeepSeek（深度求索）",
  baseUrl: "https://api.deepseek.com",
  model: "deepseek-v4-pro",
  apiKey: "",
};

function getSettingsPath(): string {
  return path.join(getUserDataDir(), "model-settings.json")
}

function loadModelSettings(): ModelSettings {
  try {
    const filePath = getSettingsPath()
    if (!fs.existsSync(filePath)) return DEFAULT_MODEL_SETTINGS
    const raw = fs.readFileSync(filePath, "utf8")
    const parsed = JSON.parse(raw) as Partial<ModelSettings>
    // explicitTransport 取自顶层（顶层是 perProvider[currentProvider] 的镜像）
    const explicitTransport: ModelSettings["explicitTransport"] =
      parsed.explicitTransport === "openai" || parsed.explicitTransport === "anthropic" || parsed.explicitTransport === "auto"
        ? parsed.explicitTransport
        : undefined;
    return {
      provider: typeof parsed.provider === "string" && parsed.provider.trim() ? parsed.provider.trim() : DEFAULT_MODEL_SETTINGS.provider,
      baseUrl: typeof parsed.baseUrl === "string" && parsed.baseUrl.trim() ? parsed.baseUrl.trim() : DEFAULT_MODEL_SETTINGS.baseUrl,
      model: typeof parsed.model === "string" && parsed.model.trim() ? parsed.model.trim() : DEFAULT_MODEL_SETTINGS.model,
      apiKey: typeof parsed.apiKey === "string" ? parsed.apiKey.trim() : "",
      explicitTransport,
    };
  } catch {
    return DEFAULT_MODEL_SETTINGS
  }
}



function stripThinkBlocks(text: string): string {
  return text
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    .replace(/<think>[\s\S]*$/gi, "")
    .trim()
}

function extractJsonArray(raw: string): unknown[] | null {
  // 第一步：去掉 markdown 代码块包裹 + think 块
  let text = raw
    .replace(/```json\s*/gi, '')
    .replace(/```\s*/gi, '')
    .trim()

  // 第二步：截取从第一个 [ 开始的内容（不要求结尾有 ]，防 max_tokens 截断）
  const start = text.indexOf('[')
  if (start === -1) return null
  text = text.slice(start)

  // 第三步：直接尝试解析（完整数组的情况）
  try {
    const parsed = JSON.parse(text) as unknown[]
    if (Array.isArray(parsed)) return parsed
  } catch (_) {}

  // 第四步：截断救场 —— 即使末尾 ] 缺失，把已完整的 {...} 对象逐个捞出来。
  // 关键：用栈匹配大括号深度，避免把对象内部的 } 当成对象结束。
  const results: unknown[] = []
  let i = 0
  while (i < text.length) {
    if (text[i] !== '{') { i++; continue }
    // 找匹配的 } —— 跟踪引号和嵌套深度
    let depth = 0
    let inStr = false
    let esc = false
    let j = i
    for (; j < text.length; j++) {
      const c = text[j]
      if (esc) { esc = false; continue }
      if (c === '\\') { esc = true; continue }
      if (c === '"') { inStr = !inStr; continue }
      if (inStr) continue
      if (c === '{') depth++
      else if (c === '}') {
        depth--
        if (depth === 0) break  // 找到匹配的闭合
      }
    }
    if (depth !== 0) break  // 这个对象被截断了，后面也不可能有完整的了
    const objStr = text.slice(i, j + 1)
    try {
      const obj = JSON.parse(objStr)
      if (obj && typeof obj === "object") results.push(obj)
    } catch (_) {
      // 单个对象解析失败，跳过继续找下一个
    }
    i = j + 1
  }

  if (results.length > 0) {
    console.log('[MemoryJudge] 截断救场提取成功，条数:', results.length)
    return results
  }

  // 第五步：修复嵌套英文引号问题（针对完整数组的情况再试一次）
  try {
    // 给 text 补上缺失的 ] 让 JSON.parse 有机会成功
    const fixedText = text.replace(/("content"|"triggerText"):\s*"([\s\S]*?)(?<!\\)"/g,
      (match: string, key: string, value: string) => {
        let k = 0
        const cleaned = value.replace(/"/g, () => k++ % 2 === 0 ? '「' : '」')
        return key + ': "' + cleaned + '"'
      }
    )
    // 尝试找最后一个完整对象后补 ]
    const lastBrace = fixedText.lastIndexOf('}')
    if (lastBrace > 0) {
      const candidate = fixedText.slice(0, lastBrace + 1) + ']'
      const parsed = JSON.parse(candidate) as unknown[]
      if (Array.isArray(parsed)) return parsed
    }
  } catch (_) {}

  return null
}

const ABSOLUTE_TERMS = ["只", "永远", "从不", "一定", "完全", "绝对", "以后都", "不再"]

function hasUnsupportedAbsolute(summary: string, evidenceQuotes: string[]): boolean {
  return ABSOLUTE_TERMS.some((term) => summary.includes(term) && !evidenceQuotes.some((quote) => quote.includes(term)))
}

function normalizeCandidate(input: unknown): MemoryCandidate | null {
  if (!input || typeof input !== "object") return null
  const record = input as Record<string, unknown>
  const layer = record.layer
  const summary = record.summary
  const importance = record.importance
  const stability = record.stability
  const certainty = record.certainty
  const attribution = record.attribution
  const evidenceQuotes = Array.isArray(record.evidenceQuotes) ? record.evidenceQuotes.filter((item): item is string => typeof item === "string" && item.trim().length > 0).map((item) => item.trim()) : []
  const contextSummary = record.contextSummary
  const shouldWrite = record.shouldWrite
  const reason = record.reason
  const forbiddenOverclaims = Array.isArray(record.forbiddenOverclaims) ? record.forbiddenOverclaims.filter((item): item is string => typeof item === "string" && item.trim().length > 0).map((item) => item.trim()) : []
  if (layer !== "L0" && layer !== "L1" && layer !== "L2") return null
  if (typeof summary !== "string" || !summary.trim()) return null
  if (importance !== "low" && importance !== "medium" && importance !== "high") return null
  if (stability !== "one_off" && stability !== "situational" && stability !== "stable") return null
  if (certainty !== "explicit" && certainty !== "inferred" && certainty !== "uncertain") return null
  if (attribution !== "user_explicit" && attribution !== "assistant_inferred" && attribution !== "mixed") return null
  if (shouldWrite !== true) return null
  if (typeof contextSummary !== "string" || !contextSummary.trim()) return null
  if (typeof reason !== "string" || !reason.trim()) return null
  if (evidenceQuotes.length === 0) return null
  if (forbiddenOverclaims.length > 0) return null
  if (hasUnsupportedAbsolute(summary, evidenceQuotes)) return null

  const confidence =
    certainty === "explicit" ? 0.9 :
    certainty === "inferred" ? 0.65 :
    0.4
  // sourceQuote 原文片段：可选、去空白、截 500 字（与 prompt 软上限一致，防模型超发）
  const sourceQuote = typeof record.sourceQuote === "string" && record.sourceQuote.trim()
    ? record.sourceQuote.trim().slice(0, 500)
    : undefined
  return {
    layer,
    field: typeof record.field === 'string' ? record.field : undefined,
    summary: summary.trim(),
    content: summary.trim(),
    confidence,
    triggerText: evidenceQuotes[0],
    importance,
    stability,
    certainty,
    attribution,
    evidenceQuotes,
    contextSummary: contextSummary.trim(),
    shouldWrite,
    reason: reason.trim(),
    forbiddenOverclaims,
    sourceQuote,
    ...(layer === "L2" ? {
      facets: normalizeMemoryFacets(record.facets, `${summary.trim()} ${evidenceQuotes.join(" ")}`),
    } : {}),
  }
}

async function callChatCompletions(
  settings: ModelSettings,
  messages: Array<{ role: "system" | "user"; content: string }>,
  timeoutMs: number,
  label: string,
): Promise<string> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)

  // 拼 VendorConfig（settings 顶层三件套 + 镜像字段都参与）
  const cfg: VendorConfig = {
    provider: settings.provider,
    baseUrl: settings.baseUrl,
    model: settings.model,
    apiKey: settings.apiKey,
    explicitTransport: settings.explicitTransport,
    // 提取质量依赖思考链：A/B 实测 kimi-k2.6 关闭思考时对含明确可提取信息的
    // 8 轮窗口全部 1 秒内直出 []（零思考、零分析）；开启思考（40~72s）才能逐轮
    // 分析并产出候选。历史 L2 也正是开思考期间形成的。
    // 不能设 auto：该厂商默认思考虽开，但语义上 auto=不发字段，依赖服务端默认，
    // 显式 on 更稳。代价是单次调用 40~72s，见下方超时注释。
    reasoning: { mode: "on" },
  }

  try {
    // adapter 三层 transport 解析（explicitTransport → baseUrl 启发式 → capabilities fallback）
    // —— 之前直接写 OpenAI body / Bearer header / choices[0].message.content 解析，
    // 切到 anthropic transport 厂商（如 MiniMax / Claude）时会拿到空字符串，误判 "JSON 解析失败"。
    // 现在交给 adapter，OpenAI / Anthropic 端点都正确。
    const adapter = getAdapterForConfig(cfg)
    const http = adapter.buildRequest({
      model: cfg.model,
      messages: messages as ChatMessage[],
      // thinking 模型的思考计入同一预算：800 实测被挤没正文，2048 在 8 轮长转录批上
      // 仍复现空 content；8192 给思考链充足余量。配合下方“空内容=失败”抛错，
      // 即便再被挤没也会走调用方重试，而非静默当“无值得记录”。
      maxTokens: 8192,
      stream: false,
    }, cfg)

    const response = await fetch(http.url, {
      method: "POST",
      signal: controller.signal,
      headers: http.headers,
      body: http.body,
    })

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({})) as Record<string, unknown>
      const errMsg = (errorData as { error?: { message?: string } }).error?.message
      throw new Error(errMsg || `模型请求失败：HTTP ${response.status}`)
    }

    const data = await response.json()
    const parsed = adapter.parseResponse(data)

    // 记录 token 用量（统一字段，OpenAI / Anthropic adapter 都映射成 {input, output}）
    if (parsed.usage) {
      recordUsage(parsed.usage.input, parsed.usage.output, 1)
    }
    return stripThinkBlocks(parsed.text ?? "")
  } finally {
    clearTimeout(timer)
  }
}

export class MemoryJudge {
  private buildL0FieldPrompt(): string {
    return Object.entries(L0_FIELD_DESCRIPTIONS)
      .map(([field, description]) => `  · ${field}：${description}`)
      .join('\n')
  }

  async classifyMemoryFacetsBatch(
    items: Array<{ id: string; text: string; context?: string }>,
  ): Promise<Array<{ id: string; facets: MemoryFacets }>> {
    if (items.length === 0) return []
    const settings = loadModelSettings()
    if (!settings.apiKey) throw new Error("MemoryFacetBackfill missing api key")
    const systemPrompt = [
      "你是记忆分类器。只分类，不改写、删除或判断记忆正文是否正确。",
      "对输入数组的每一项输出且只输出一个对应结果；id 必须原样保留。",
      "primaryKind 和 retrievalKinds 只能使用 commitment|preference|goal|wish|experience|fact|emotion|other。",
      "primaryKind 必须是正文最核心、最能决定这条记忆生命周期的唯一主类。",
      "retrievalKinds 是用于召回的标签数组，必须包含 primaryKind，去重后最多 3 个；只标正文直接支持的类型，不要为了凑数添加标签。",
      "若存在任何具体类型，不得同时输出 other；无法可靠分类时才使用 primaryKind=other 且 retrievalKinds=[other]。",
      "明确约定、承诺、答应或双方说好的未来事项是 commitment；不要把期待、愿望或假设标成 commitment。",
      "有行动意图、准备实现的计划是 goal；单方面或双方共同期待、希望发生但没有行动承诺的是 wish。",
      "已经完成的目标不再是 goal：完成事件归 experience，完成后的当前状态可归 fact。",
      "只有正文明确表达难过、开心、害怕、焦虑、生气、孤独、紧张、羞愧、愤怒、悲伤或兴奋等情绪时才用 emotion；不要推断隐含情绪。",
      "输出裸 JSON 数组：[{\"id\":\"原id\",\"primaryKind\":\"other\",\"retrievalKinds\":[\"other\"]}]",
    ].join("\n")
    const raw = await callChatCompletions(settings, [
      { role: "system", content: systemPrompt },
      { role: "user", content: JSON.stringify(items) },
    ], 300000, "MemoryFacetBackfill")
    const parsed = extractJsonArray(raw)
    if (!parsed) throw new Error("MemoryFacetBackfill JSON 解析失败")
    const requested = new Set(items.map((item) => item.id))
    const seen = new Set<string>()
    const results: Array<{ id: string; facets: MemoryFacets }> = []
    for (const item of parsed) {
      if (!item || typeof item !== "object") continue
      const record = item as Record<string, unknown>
      const id = typeof record.id === "string" ? record.id : ""
      const facets = tryNormalizeModelFacets(record)
      if (!requested.has(id) || seen.has(id) || !facets) continue
      seen.add(id)
      results.push({ id, facets })
    }
    return results
  }
  async judgeRecentTurns(
    turns: MemoryJudgeTurn[],
    conversationId: string,
  ): Promise<MemoryCandidate[]> {
    console.log(`[MemoryJudge] 分析最近 ${turns.length} 轮对话...`)

    try {
      const settings = loadModelSettings()
      if (!settings.apiKey) {
        console.error("[MemoryJudge] LLM 调用失败: missing api key")
        // 配置缺失不是“模型判断无记忆”。必须把失败传给调度器，保留残余轮次，
        // 等用户补全配置后重试，不能推进提取水位线。
        throw new Error("MemoryJudge missing api key")
      }

      const systemPrompt = [
        "你是一个保守的记忆候选提取器，不是事实裁判，也不是用户画像改写器。",
        "你的目标是少记错，不是多记住。",
        "",
        "你只能提取用户明确表达、且未来确实有帮助的信息候选。",
        "禁止把推断写成确定事实；禁止把一次性状态写成长期偏好；禁止为了输出而输出。",
        "如果最近这些对话没有值得记的内容，必须返回空数组 []。",
        "",
        "记忆层级定义：",
        "- L0：用户稳定身份信息或核心画像。只有 certainty=explicit 且 attribution=user_explicit 才允许进入 L0。",
        "  识别到 L0 信息时，必须同时在 field 字段里指定要写入哪个格子。",
        "  可用的 field 值如下（只能用这些，不能自己发明）：",
        this.buildL0FieldPrompt(),
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
        "- 必须是用户主动表达的信息，不是 AI 说的",
        "- summary 必须忠于用户原话和上下文，不要自行推广范围",
        "- 如果只是 AI 的建议、安慰、总结、推断，不要写成用户事实",
        "- 不要把「这次」「刚刚」「这个话题里」变成长期偏好",
        "- 用户明确表达的未来计划、承诺或约定，即使依赖某个前置条件，只要对未来对话有帮助，也应按原条件保守记录；不要仅因含有「等……以后」「如果……」就返回空数组",
        "- 不要自动使用绝对化表达：只、永远、从不、一定、完全、绝对、以后都、不再，除非用户原话明确说过这些词",
        "- 如果 summary 中存在可能过度概括的词，必须写入 forbiddenOverclaims；有 forbiddenOverclaims 时 shouldWrite 必须是 false",
        "",
        "重要格式规则：",
        "- summary 和 evidenceQuotes 字段的值里，禁止出现英文双引号 \"",
        "- 如果内容里有引号，统一用中文引号「」替代，例如：用户希望被称为「宝宝」",
        "- 不要用 markdown 代码块包裹 JSON，直接输出裸 JSON",
        "- 数组第一个字符必须是 [，最后一个字符必须是 ]",
        "",
        "输出格式为 JSON 数组，禁止用 markdown 代码块包裹，直接输出裸 JSON。",
        "",
        "每个候选必须包含这些字段：",
        "{",
        "  \"layer\": \"L0\",",
        "  \"field\": \"preferredName\",",
        "  \"summary\": \"保守、可追溯的候选摘要\",",
        "  \"importance\": \"low|medium|high\",",
        "  \"stability\": \"one_off|situational|stable\",",
        "  \"certainty\": \"explicit|inferred|uncertain\",",
        "  \"attribution\": \"user_explicit|assistant_inferred|mixed\",",
        "  \"evidenceQuotes\": [\"用户原话短引文，必须来自用户\"],",
        "  \"sourceQuote\": \"L2 原文对话片段，仅 L2 输出\",",
        "  \"facets\": { \"primaryKind\": \"commitment|preference|goal|wish|experience|fact|emotion|other\", \"retrievalKinds\": [\"最多 3 个固定类型，且包含 primaryKind\"] },",
        "  \"contextSummary\": \"最近多轮上下文概括，不超过80字\",",
        "  \"shouldWrite\": true,",
        "  \"reason\": \"为什么值得记，或为什么不写\",",
        "  \"forbiddenOverclaims\": []",
        "}",
        "",
        "L1/L2 不需要 field。",
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
      ].join("\n")

      const transcript = turns.map((turn, index) => [
        `第 ${index + 1} 轮：`,
        `用户：${turn.userInput}`,
        `AI：${turn.assistantReply}`,
      ].join("\n")).join("\n\n")

      const userPrompt = [
        `conversationId: ${conversationId}`,
        "最近对话：",
        transcript,
      ].join("\n")

      const raw = await callChatCompletions(
        settings,
        [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
        300000, // 开思考实测 40~72s（8 轮窗口），服务端忙时可更久；后台任务不在关键路径，
        // 给足余量避免历史停摆根因（120s 被思考链拖破后静默失败数天）重演。
        "MemoryJudge",
      )

      const parsed = extractJsonArray(raw)
      if (!parsed) {
        console.error("[MemoryJudge] JSON 解析失败，原始内容：\n", raw.slice(0, 200))
        // 只有合法的 [] 才表示“模型明确判断无记忆”。空内容或非 JSON 文本都没有
        // 给出可验证的判断，必须保留轮次重试，不能静默推进水位线。
        throw new Error(raw.trim()
          ? "MemoryJudge JSON 解析失败"
          : "MemoryJudge 拿到空 content（token 预算耗尽）")
      }

      const candidates = parsed
        .map(normalizeCandidate)
        .filter((item): item is MemoryCandidate => item !== null)
        .filter((item) => item.shouldWrite === true)
        .filter((item) => item.layer !== "L0" || (item.certainty === "explicit" && item.attribution === "user_explicit"))

      if (candidates.length === 0) {
        console.log("[MemoryJudge] 本轮无值得记录的信息")
        return []
      }

      console.log(`[MemoryJudge] 提取候选: ${candidates.length} 条（过滤后）`)
      console.log(
        `[MemoryJudge] 候选详情: ${candidates.map((item) => item.layer === "L0" && item.field ? `${item.layer}.${item.field}(\"${item.content.slice(0, 20)}\", ${item.confidence.toFixed(2)})` : `${item.layer}(\"${item.content.slice(0, 20)}\", ${item.confidence.toFixed(2)})`).join(" ")}`,
      )
      return candidates
    } catch (error) {
      // 区分“模型回了但内容无效”（上方返回 []）与“调用失败”：
      // 失败必须抛出，让调用方感知（scheduler 保留轮次待重试 / 回填标记未完成），
      // 不能静默当成“无值得记录”——历史上这正是失败轮次被水位线消费掉的根因。
      console.error("[MemoryJudge] LLM 调用失败:", error)
      throw error
    }
  }

  async judge(
    userMessage: string,
    assistantMessage: string,
    conversationId: string,
  ): Promise<MemoryCandidate[]> {
    return this.judgeRecentTurns([{ userInput: userMessage, assistantReply: assistantMessage }], conversationId)
  }
}

export const memoryJudge = new MemoryJudge()
