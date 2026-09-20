import type { Turn } from "../../companion-chat/src/chat";

const MAX_ENTRIES = 500;

function localDate(timestamp: number): string {
  const date = new Date(timestamp);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function compact(text: string, max = 120): string {
  const value = text.replace(/\s+/g, " ").trim();
  return value.length > max ? `${value.slice(0, max)}...` : value;
}

export function detectUserMood(text: string): string {
  if (/累|疲惫|困|没精神|撑不住|倦/.test(text)) return "疲惫";
  if (/不要|别|不想|不喜欢|太影响|影响观感|先不|别.*问|不要.*确认/.test(text)) return "明确边界";
  if (/(紧张|害羞)/.test(text) && /(喜欢|表白|告白)/.test(text)) return "害羞";
  if (/焦虑|压力|烦|崩|紧张|担心|慌/.test(text)) return "焦虑";
  if (/难过|伤心|委屈|失落|想哭/.test(text)) return "低落";
  if (/开心|高兴|舒服|喜欢|好耶|太好了/.test(text)) return "开心";
  return "未知";
}

function deriveSignal(userText: string, userMood: string): { signal: string; important?: string; cue: string } {
  if (userMood === "明确边界") return {
    signal: "用户表达了低打扰偏好或体验边界，需要优先尊重，不要把关心做成打断。",
    important: "用户明确表示不喜欢影响观感的确认卡片或过度询问。",
    cue: "不要弹确认或反复追问；先按用户偏好安静执行，必要时用一句话确认。",
  };
  if (userMood === "疲惫") return {
    signal: "用户显露疲惫状态，更需要低压力陪伴和短回应。",
    cue: "少安排、少追问，语气放慢，先接住状态。",
  };
  if (userMood === "害羞") return {
    signal: "用户在亲密表达中有些害羞或紧张，更适合轻松接住，不要问题解决化。",
    cue: "轻松回应这份害羞或紧张，不要把亲密表达当作需要解决的问题。",
  };
  if (userMood === "焦虑") return {
    signal: "用户可能处在压力或焦虑里，需要稳定感和清晰的小步建议。",
    cue: "先安抚，再给一两个可执行小步，不要铺太大。",
  };
  if (userMood === "低落") return {
    signal: "用户情绪偏低，需要被理解和陪着，而不是立刻被纠正。",
    cue: "先承认感受，再轻轻陪伴，不要急着总结道理。",
  };
  if (userMood === "开心") return {
    signal: "用户反馈偏积极，可以保持轻快互动并记住触发愉快的点。",
    cue: "可以更轻松一点，延续用户的好状态。",
  };
  return {
    signal: "本轮互动没有明显情绪峰值，保持自然陪伴即可。",
    cue: `延续最近话题「${compact(userText, 40)}」，不要过度解读。`,
  };
}

/**
 * 直接从插件已经持久化的成功伴聊轮次派生上下文，不另存一份关系日志。
 * 规则与本地版 RelationshipLogStore 一致；调用本身纯只读、无模型请求。
 */
export function buildRelationshipContext(turns: Turn[]): string {
  const entries = turns.slice(-MAX_ENTRIES).map((turn) => {
    const mood = detectUserMood(turn.user);
    return { date: localDate(turn.assistantAt), mood, ...deriveSignal(turn.user, mood) };
  });
  const recent = entries.slice(-8);
  if (recent.length === 0) return "";

  const lastMood = [...recent].reverse().find((entry) => entry.mood !== "未知")?.mood ?? "平稳";
  const latest = entries.at(-1)!;
  const sameDate = entries.filter((entry) => entry.date === latest.date);
  const dominantMood = [...sameDate].reverse().find((entry) => entry.mood !== "未知")?.mood ?? "平稳";
  const importantForDate = [...sameDate].reverse().find((entry) => entry.important)?.important;
  const latestSummary = `${latest.date}：用户最近状态偏「${dominantMood}」。 ${importantForDate ? `重要偏好：${importantForDate}` : latest.signal}`;
  const preference = [...recent].reverse().find((entry) => entry.important)?.important;

  const lines = [
    "【近期关系线索】",
    `- 用户最近状态：${lastMood}`,
    `- 最近日记摘要：${latestSummary}`,
  ];
  if (preference) lines.push(`- 重要互动偏好：${preference}`);
  lines.push(`- 当前回应参考：${latest.cue}`);
  return lines.join("\n");
}
