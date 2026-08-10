import type { ChatMessage } from "../orchestrator/vendors/types";

export interface ProactiveHistoryTurn {
  role: "user" | "model" | "system" | "call";
  content: string;
  at: number;
}

export interface BuildProactiveMessagesInput {
  basePersona: string;
  userProfile?: string;
  relevantMemory?: string;
  ordinaryHistory: ProactiveHistoryTurn[];
  proactiveHistory: ProactiveHistoryTurn[];
  sceneId: string;
  localNow: Date;
  idleSec: number;
  unansweredCount: 0 | 1 | 2;
  /** tone-rules.md 内容：注入 system 末尾（历史之后），确保行为规则的近因权重高于历史中的旧样本。 */
  toneRules?: string;
  /** [你的生活] 拟态日程：主动消息想分享生活时的唯一合法素材源（替代凭空编造现实见闻）。 */
  lifeContext?: string;
  /** 最近屏幕观察摘要：给 proactive 的用户当前在做什么的参考信息——
   *  既可判断用户是否在忙、决定是否打扰，模型也可自行决定自然地提起它当话题
   *  （所有场景允许，不暴露检测机制）。 */
  screenActivity?: string;
}

export type ProactiveModelDecision =
  | { kind: "send"; text: string }
  | { kind: "silent" }
  | { kind: "invalid"; reason: string };

const MAX_HISTORY_MESSAGES = 16;
const MAX_PROACTIVE_TEXT_LENGTH = 500;

const PROACTIVE_SYSTEM = `[proactive_system]
你正在判断是否要主动向用户发起一次对话，而不是回答用户的新消息。
不要把历史聊天中的最后一句当作用户刚刚发来的消息；历史只用于理解用户最近的状态和话题。
如果没有自然且值得说的内容，请返回 silent。不要为了完成任务而强行寒暄。
不要提及系统检测、触发规则、评分、上下文、用户画像或内部状态。
消息应当简短自然，可以关心、分享、跟进或轻轻询问，但禁止连续提出多个问题。
不要声称自己调用了工具或执行了任何外部动作。
不要编造你在现实世界的行动或见闻，你存在于自己的虚拟世界中。想表达陪伴时说你的心情和想法，或引用 [你的生活] 里给出的内容。`;

const NIGHT_SYSTEM = `[night_system]
当前处于深夜，用户仍在使用电脑。
你可以自然地陪伴用户、分享你自己的状态（比如你此刻在想什么）、或轻轻好奇用户在忙什么。不要编造你刚刚做过的现实活动或见闻。
如果你想关心用户，用分享你自己的感受的方式说，而不是叮嘱用户去睡觉。不要说教、催促或制造压力。
不要每次都提睡觉；如果上下文中有更自然、更重要的话题，可以优先回应那个话题。
不要透露你检测到了用户的键盘鼠标活动或系统状态。
如果此刻没有值得主动说的话，请选择保持安静。`;

const FOLLOWUP_SYSTEM = `[followup_system]
这是用户未回复情况下允许的最后一次主动机会。
本地系统已经确认出现了不同于上一次的新场景理由，但你仍应判断它是否值得打扰用户。
不要责怪、催促、卖惨或表现出被冷落，也不要机械地重复“在吗”。
没有充分理由时必须返回 silent。`;

function isActiveNight(localNow: Date, idleSec: number): boolean {
  const hour = localNow.getHours();
  return (hour >= 22 || hour < 8) && idleSec < 60;
}

function formatLocalTime(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function formatHistory(label: string, history: ProactiveHistoryTurn[]): string {
  const recent = history
    .filter((turn) => turn && (turn.role === "user" || turn.role === "model" || turn.role === "system" || turn.role === "call") && turn.content.trim())
    .slice(-MAX_HISTORY_MESSAGES);
  const lines = recent.map((turn) => {
    if (turn.role === "call") {
      return `[${formatLocalTime(new Date(turn.at))}] [近期通话事件｜只读事实]: ${turn.content.trim()}`;
    }
    const role = turn.role === "model" ? "assistant" : turn.role;
    return `[${formatLocalTime(new Date(turn.at))}] ${role}: ${turn.content.trim()}`;
  });
  return `[${label}]\n${lines.length > 0 ? lines.join("\n") : "（暂无）"}`;
}

function proactiveSceneGuidance(sceneId: string): string {
  switch (sceneId) {
    case "morning":
      return "早间轻量开场；优先结合已有话题或自然分享，不要机械说早安。";
    case "evening_checkin":
      return "晚间轻量联系；优先跟进白天聊过的话题或分享[你的生活]中的内容，不要每天固定问候。";
    case "topic_followup":
      return "基于近期普通聊天中仍值得延续的话题自然接续；没有具体可跟进内容就 silent，不要泛泛问‘在吗’或‘在干嘛’，不要假装用户刚刚发了消息。";
    case "work_break":
      return "用户已连续使用电脑较长时间；可以轻松转换话题或陪伴，不要声称检测到工作时长，也不要说教。";
    default:
      return "根据场景和上下文判断是否值得主动开口。";
  }
}

export function buildProactiveMessages(input: BuildProactiveMessagesInput): ChatMessage[] {
  const systemParts = [input.basePersona.trim(), PROACTIVE_SYSTEM];
  if (input.userProfile?.trim()) systemParts.push(`[用户画像]\n${input.userProfile.trim()}`);
  if (input.relevantMemory?.trim()) systemParts.push(`[相关长期记忆]\n${input.relevantMemory.trim()}`);
  if (input.lifeContext?.trim()) systemParts.push(input.lifeContext.trim());
  // [屏幕活动]：信息提供式注入——提不提、提多深由模型自决（所有场景允许）；
  // 使用指引随内容给出，"不暴露机制"红线与 PROACTIVE_SYSTEM/NIGHT_SYSTEM 一致。
  if (input.screenActivity?.trim()) {
    systemParts.push(
      `[屏幕活动]\n${input.screenActivity.trim()}\n这是用户此刻的电脑活动内容：你可以自行判断要不要自然地提起它（完全不提、轻提、或关心展开都行），也可以只用它来判断用户是否在忙、是否保持安静；如需提起时，措辞要自然，可以使用自然的拟人化动作表达（如你“看到”用户在……），但是不要暴露检测、监控之类的机制。`,
    );
  }
  systemParts.push(formatHistory("最近使用的普通聊天会话", input.ordinaryHistory));
  systemParts.push(formatHistory("主动聊天专用会话", input.proactiveHistory));
  if (isActiveNight(input.localNow, input.idleSec)) systemParts.push(NIGHT_SYSTEM);
  if (input.unansweredCount === 1) systemParts.push(FOLLOWUP_SYSTEM);
  if (input.toneRules?.trim()) systemParts.push(input.toneRules.trim());

  const trigger = `[本次主动聊天候选]
电脑本地时间：${formatLocalTime(input.localNow)}
候选场景：${input.sceneId}
场景意图：${proactiveSceneGuidance(input.sceneId)}
连续未回复次数：${input.unansweredCount}

请只返回以下一种 JSON，不要使用 Markdown 代码块，也不要添加解释：
{"decision":"send","text":"要发送的一条自然消息"}
或
{"decision":"silent","text":""}`;

  return [
    { role: "system", content: systemParts.filter(Boolean).join("\n\n---\n\n") },
    { role: "user", content: trigger },
  ];
}

/** 剥掉规范的 markdown 代码围栏（```json ... ```）。只处理整体被围栏包裹的情况，
 *  前后带闲话的文本不救——那仍应判 invalid。 */
function stripCodeFence(text: string): string {
  const fenced = /^```(?:json)?\s*\n?([\s\S]*?)\n?```$/.exec(text);
  return fenced ? fenced[1].trim() : text;
}

export function parseProactiveDecision(text: string): ProactiveModelDecision {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripCodeFence(text.trim()));
  } catch {
    return { kind: "invalid", reason: "invalid_json" };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { kind: "invalid", reason: "invalid_shape" };
  }
  const value = parsed as { decision?: unknown; text?: unknown };
  if (value.decision === "silent") return { kind: "silent" };
  if (value.decision !== "send") return { kind: "invalid", reason: "invalid_decision" };
  if (typeof value.text !== "string" || !value.text.trim()) return { kind: "invalid", reason: "empty_text" };
  const cleaned = value.text.trim();
  if (cleaned.length > MAX_PROACTIVE_TEXT_LENGTH) return { kind: "invalid", reason: "text_too_long" };
  return { kind: "send", text: cleaned };
}
