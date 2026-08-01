import { MemoryCandidate, L0_FIELD_DESCRIPTIONS, MemoryJudgeTurn } from "./memory-types"
import { invokeMemoryStructuredOutput, getDefaultMaxOutputTokens } from "./memory-llm-client"
import { loadMemoryModelConfig } from "./memory-llm-shared"
import { parseMemoryJudgeResult, validateMemoryJudgeBusiness } from "./memory-schemas"

const ABSOLUTE_TERMS = ["只", "永远", "从不", "一定", "完全", "绝对", "以后都", "不再"]

function hasUnsupportedAbsolute(summary: string, evidenceQuotes: string[]): boolean {
  return ABSOLUTE_TERMS.some((term) => summary.includes(term) && !evidenceQuotes.some((quote) => quote.includes(term)))
}

/**
 * 业务级后处理：过滤不符合条件的候选。
 * 这些规则是 Memory Judge 的业务语义，不是 schema 校验。
 */
function postFilterCandidates(candidates: MemoryCandidate[]): MemoryCandidate[] {
  return candidates
    .filter((item) => item.shouldWrite === true)
    .filter((item) => item.layer !== "L0" || (item.certainty === "explicit" && item.attribution === "user_explicit"))
    .filter((item) => !item.forbiddenOverclaims || item.forbiddenOverclaims.length === 0)
    .filter((item) => !hasUnsupportedAbsolute(item.summary ?? item.content, item.evidenceQuotes ?? []))
}

export class MemoryJudge {
  private buildL0FieldPrompt(): string {
    return Object.entries(L0_FIELD_DESCRIPTIONS)
      .map(([field, description]) => `  · ${field}：${description}`)
      .join('\n')
  }
  async judgeRecentTurns(
    turns: MemoryJudgeTurn[],
    conversationId: string,
  ): Promise<MemoryCandidate[]> {
    console.log(`[MemoryJudge] 分析最近 ${turns.length} 轮对话...`)

    try {
      const config = loadMemoryModelConfig()
      if (!config.apiKey) {
        console.error("[MemoryJudge] LLM 调用失败: missing api key")
        console.log("[MemoryJudge] 本轮无值得记录的信息")
        return []
      }

      const systemPrompt = [
        "你是一个保守的记忆候选提取器，不是事实裁判，也不是用户画像改写器。",
        "你的目标是少记错，不是多记住。",
        "",
        "你只能提取用户明确表达、且未来确实有帮助的信息候选。",
        "禁止把推断写成确定事实；禁止把一次性状态写成长期偏好；禁止为了输出而输出。",
        "如果最近这些对话没有值得记的内容，必须返回 {\"candidates\":[]}。",
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
        "- 纯日常问候、闲聊、情绪发泄（无信息量）→ 返回 {\"candidates\":[]}",
        "- 必须是用户主动表达的信息，不是 AI 说的",
        "- summary 必须忠于用户原话和上下文，不要自行推广范围",
        "- 如果只是 AI 的建议、安慰、总结、推断，不要写成用户事实",
        "- 不要把「这次」「刚刚」「这个话题里」变成长期偏好",
        "- 不要自动使用绝对化表达：只、永远、从不、一定、完全、绝对、以后都、不再，除非用户原话明确说过这些词",
        "- 如果 summary 中存在可能过度概括的词，必须写入 forbiddenOverclaims；有 forbiddenOverclaims 时 shouldWrite 必须是 false",
        "",
        "重要格式规则：",
        "- summary 和 evidenceQuotes 字段的值里，禁止出现英文双引号 \"",
        "- 如果内容里有引号，统一用中文引号「」替代，例如：用户希望被称为「宝宝」",
        "- 输出必须是顶层 JSON 对象，唯一的顶层字段为 candidates",
        "- candidates 的值必须是 JSON 数组",
        "",
        "输出结构：",
        "{",
        "  \"candidates\": [",
        "    {",
        "      \"layer\": \"L0\",",
        "      \"field\": \"preferredName\",",
        "      \"summary\": \"保守、可追溯的候选摘要\",",
        "      \"content\": \"与 summary 相同\",",
        "      \"confidence\": 0.9,",
        "      \"triggerText\": \"用户原话短引文\",",
        "      \"importance\": \"low|medium|high\",",
        "      \"stability\": \"one_off|situational|stable\",",
        "      \"certainty\": \"explicit|inferred|uncertain\",",
        "      \"attribution\": \"user_explicit|assistant_inferred|mixed\",",
        "      \"evidenceQuotes\": [\"用户原话短引文，必须来自用户\"],",
        "      \"contextSummary\": \"最近多轮上下文概括，不超过80字\",",
        "      \"shouldWrite\": true,",
        "      \"reason\": \"为什么值得记，或为什么不写\",",
        "      \"forbiddenOverclaims\": []",
        "    }",
        "  ]",
        "}",
        "",
        "L1/L2 不需要 field。",
        "inferred / uncertain 不允许进入 L0；如果还值得保留，只能放 L2，或者 shouldWrite=false。",
        "没有值得记录的信息时，输出：{\"candidates\":[]}",
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

      const candidates = await invokeMemoryStructuredOutput<MemoryCandidate[]>({
        operation: "judge",
        systemPrompt,
        userPrompt,
        maxOutputTokens: getDefaultMaxOutputTokens("judge"),
        parseSchema: parseMemoryJudgeResult,
        validateBusiness: validateMemoryJudgeBusiness,
        config,
      })

      const filtered = postFilterCandidates(candidates)

      if (filtered.length === 0) {
        console.log("[MemoryJudge] 本轮无值得记录的信息")
        return []
      }

      console.log(`[MemoryJudge] 提取候选: ${filtered.length} 条（过滤后）`)
      console.log(
        `[MemoryJudge] 候选详情: ${filtered.map((item) => item.layer === "L0" && item.field ? `${item.layer}.${item.field}(\"${(item.summary ?? item.content).slice(0, 20)}\", ${item.confidence.toFixed(2)})` : `${item.layer}(\"${(item.summary ?? item.content).slice(0, 20)}\", ${item.confidence.toFixed(2)})`).join(" ")}`,
      )
      return filtered
    } catch (error) {
      console.error("[MemoryJudge] LLM 调用失败:", error)
      console.log("[MemoryJudge] 本轮无值得记录的信息")
      return []
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
