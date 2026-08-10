// buildAgentRunOptions —— 把 AG-UI 桥的 buildOptions 闭包抽成纯函数。
//
// 设计原则：
//   - 函数无模块级状态；所有 index.ts 模块级符号（runtimeState, stickerEmbeddingIndex 等）
//     通过 deps 参数注入。
//   - 函数无副作用（不算 console.warn）；副作用（记忆写入/sticker 广播）由 onRunFinished
//     单独做，注入到同一个 deps 里。
//   - index.ts / dispatcher / scheduler 共用同一个 factory。
//   - 默认 style 写死 '01_default.md'，与原行为一致。
//
// 字段依赖梳理（按 index.ts:3175-3281）：
//   loadModelSettings / loadUserProfile / buildEnvironmentContext
//   buildSkillCatalog / skillRegistry / resolveSlashActivation
//   buildToneInjection / sceneEmbeddingIndex / getSceneEmbeddingProvider
//   buildSystemPrompt / logWorldbookInjection / CHAT_REQUEST_TIMEOUT_MS
//   normalizeChatMessages / buildAlwaysOnContext / ToolDefinition
//   scheduleMemoryWrite / inferRuntimeState / runtimeState / feelingToExpression
//   matchSticker / stickerEmbeddingIndex / getEmbeddingProvider / loadStickerSettings
//   broadcastRuntimeStateChanged / observeRuntimeState
//   IPC.AGUI_EVENT / chatWindow（用于推 sticker）
//
// 这些全部塞到 BuildOptionsDeps 里。dispatcher 在 Phase 1 注入同样的 deps 即可。
import type { CyreneRunOptions, CyreneRunResult } from "./cyrene-agent";
import type { ToolDefinition } from "./tool-registry";
import type { ChatMessage, OpenAIContentBlock } from "./vendors/types";
import type { AguiRunInput } from "../agui-bridge";
import { IPC } from "../../shared/ipc-channels";
import type { RelationshipChannel, RelationshipTurnInput } from "../relationship/relationship-log";
import { validateCaptionImagePath } from "../chat/image-caption";
import {
  buildConversationTimeContext,
  formatLocalTime,
  resolveChatContextTimezone,
  type ChatContextMessage,
} from "../chat-time-context";
import type { EmbeddingProvider } from "../rag/embedding";
import { buildSocialContextBlock, type SocialAtom, type SocialTurnContext } from "../social-context";
import {
  buildCallContextBlock,
  buildCallMemoryContext,
  mergeCallEventsIntoHistory,
  selectNewCallEventsForMemory,
  type CallContextEvent,
} from "../call/call-context";

/** index.ts 模块级符号的最小可注入子集。
 *  类型故意用宽签名（unknown / 任意 shape）—— 因为 build-options 是纯消费者，
 *  实际调用时由 index.ts 注入真实的强类型函数。这避免循环类型依赖。 */
export interface BuildOptionsDeps {
  loadModelSettings: () => ModelSettingsLite;
  loadUserProfile: () => UserProfileLite;
  buildEnvironmentContext: (model: { provider: string; model: string }, profile: unknown) => string;
  buildSkillCatalog: (skills: ReadonlyArray<unknown>) => string;
  buildAutoInjectedSkillContext: (skills: ReadonlyArray<unknown>) => string;
  skillRegistry: { getEnabled(): ReadonlyArray<unknown> };
  resolveSlashActivation: (messages: ReadonlyArray<{ role: string; content?: string }>) => string;
  buildToneInjection: (
    userText: string,
    messages: ReadonlyArray<{ role: string; content?: string }>,
    provider: unknown,
    index: unknown,
  ) => Promise<string>;
  sceneEmbeddingIndex: unknown;
  getSceneEmbeddingProvider: () => unknown;
  buildAlwaysOnContext: (
    userText: string,
    messages: ReadonlyArray<{ role: string; content?: string }>,
  ) => Promise<string>;
  buildMemoryInjection: (userText: string) => Promise<string>;
  buildRelationshipContext: () => Promise<string>;
  buildSystemPrompt: (styleFile: string) => string;
  /** 第一期：工具阶段 system prompt。仅含工具调度规则 + 自动生成的工具目录。 */
  buildToolSystemPrompt: (enabledTools: ReadonlyArray<unknown>) => string;
  /** 第一期：Soul 阶段使用的基础 system prompt。工具结果在 FC 循环 Soul 阶段执行前动态追加。 */
  buildSoulSystemBasePrompt: (styleFile: string) => string;
  /** 第一期：注入 toolRegistry（用于 buildToolSystemPrompt 自动生成目录）。 */
  toolRegistry: { getEnabled(): ReadonlyArray<unknown> };
  logWorldbookInjection: (alwaysOnContext: string, systemContent: string) => void;
  normalizeChatMessages: (raw: ReadonlyArray<unknown>) => ChatMessage[];
  chatRequestTimeoutMs: number;
  captionImageForFallback?: (filePath: string) => Promise<{ ok: boolean; caption?: string; error?: string }>;
  buildMusicCompanionContext?: (conversationId: string, userText: string) => string;
  /** 可选：加载尾部锚点（prompts/tone-anchor.md，压缩版硬行为规则）。文件不存在时返回空串=不启用。 */
  loadToneAnchor?: () => string;
  /** 可选：构造 [你的生活] 拟态日程（life-context.ts）。缺省或异常时返回空串=不启用。 */
  buildLifeContext?: () => string;
  isSocialContextEnabled?: () => boolean;
  getSocialEmbeddingProvider?: () => EmbeddingProvider | null | undefined;
  retrieveSocialContext?: (conversationId: string, query: string, provider?: EmbeddingProvider | null) => Promise<SocialAtom[]>;
  getCallContextEvents?: () => CallContextEvent[];
  isProactiveConversation?: (conversationId: string) => boolean;
}

/** onRunFinished 副作用所需的 deps（与 BuildOptionsDeps 部分重叠） */
export interface OnRunFinishedDeps {
  loadModelSettings: () => ModelSettingsLite;
  scheduleMemoryWrite: (userText: string, reply: string) => void;
  inferRuntimeState: (userText: string, reply: string, flag: boolean) => { status: string };
  runtimeState: {
    status: string;
    expression: number;
    updatedAt: number;
    feeling?: string;
  };
  feelingToExpression: Record<string, number>;
  setRuntimeState: (next: { status?: string; expression?: number; updatedAt?: number; feeling?: string }) => void;
  stickerEmbeddingIndex: unknown;
  getStickerEmbeddingIndex?: () => unknown;
  getEmbeddingProvider: () => unknown;
  matchSticker: (
    text: string,
    provider: unknown,
    index: unknown,
    threshold: number,
  ) => Promise<{ id: string; score?: number } | null | undefined>;
  loadStickerSettings: () => Record<string, boolean>;
  broadcastRuntimeStateChanged: () => void;
  observeRuntimeState: (
    settings: ModelSettingsLite,
    history: ReadonlyArray<unknown>,
    userText: string,
    reply: string,
  ) => Promise<void>;
  recordRelationshipTurn: (input: RelationshipTurnInput) => Promise<unknown> | unknown;
  getChatWindow: () => { webContents: { isDestroyed(): boolean; send: (channel: string, ...args: unknown[]) => void }; isDestroyed(): boolean } | null;
  scheduleSocialContextWrite?: (context: SocialTurnContext, assistantText: string, settings: ModelSettingsLite) => void;
}

export interface ModelSettingsLite {
  provider: string;
  baseUrl: string;
  model: string;
  apiKey: string;
  explicitTransport?: "openai" | "anthropic" | "auto";
  /** 顶层 reasoning 镜像（来自 perProvider[currentProvider].reasoning）。adapter 直接读。 */
  reasoning?: import("../../shared/reasoning").ReasoningPreference;
  runtimeSync?: string;
  stickerEnabled?: boolean;
  stickerSimilarityThreshold?: number;
}

export interface UserProfileLite {
  nickname?: string;
  callPreference?: string;
  birthday?: string;
  defaultCity?: string;
  timezone?: string;
}

export function buildChannelSystem(channel?: RelationshipChannel): string {
  if (channel === "wechat") {
    return [
      "【渠道回复方式】",
      "你正在通过微信回复用户。",
      "回复要像微信聊天消息：短、自然、有来有回。",
      "不要写长段说明，不要提桌面端、工具调用或系统。",
      "任务复杂时先简短确认，再安静执行。",
    ].join("\n");
  }
  if (channel === "feishu") {
    return [
      "【渠道回复方式】",
      "你正在通过飞书回复用户。",
      "语气仍是昔涟，但要适合工作上下文：清楚、省时间、结论靠前。",
      "必要时可以简短列步骤，不要过度撒娇，不要发太长情绪化回复。",
    ].join("\n");
  }
  return "";
}

function contentToText(content: ChatMessage["content"]): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((block): block is { type: "text"; text: string } => block?.type === "text")
      .map((block) => block.text)
      .join("\n");
  }
  return "";
}

export function resolveRequiredMusicTool(
  userText: string,
  availableToolIds: ReadonlySet<string>,
): string | undefined {
  const text = userText.trim();
  if (!text) return undefined;
  if (availableToolIds.has("music_get_daily_recommendations") && /(?:网易云)?(?:今日推荐|每日推荐|日推)/.test(text)) {
    return "music_get_daily_recommendations";
  }
  if (!availableToolIds.has("music_search")) return undefined;
  const explicitSearch = /网易云.{0,12}(?:搜|找)|(?:搜|搜索|找).{0,12}(?:网易云|歌曲?|音乐)/.test(text);
  const explicitTrackPlayback = /^(?:帮我)?(?:播放|放个|放一下)(?!点音乐)/.test(text);
  return explicitSearch || explicitTrackPlayback ? "music_search" : undefined;
}

function stripTurnModelContextForSideEffects(text: string): string {
  const markers = [
    "\n\n【本轮文件】",
    "\n\n【文档内容】",
    "\n\n【图片视觉信息】",
    "\n\n【图片附件】",
    "【本轮文件】",
    "【文档内容】",
    "【图片视觉信息】",
    "【图片附件】",
  ];
  const cut = markers
    .map((marker) => text.indexOf(marker))
    .filter((index) => index >= 0)
    .sort((a, b) => a - b)[0];
  return (cut === undefined ? text : text.slice(0, cut)).trim();
}

function withDirectImageAttachments(messages: ChatMessage[], input: AguiRunInput): ChatMessage[] {
  const images = input.imageAttachments?.filter((image) =>
    typeof image?.filePath === "string" && typeof image?.name === "string",
  ) ?? [];
  if (images.length === 0) return messages;

  const latestUserIndex = messages.map((message) => message.role).lastIndexOf("user");
  if (latestUserIndex < 0) return messages;

  const current = messages[latestUserIndex];
  const blocks: OpenAIContentBlock[] = [];
  const text = contentToText(current.content);
  blocks.push({ type: "text", text });

  for (const image of images) {
    const validated = validateCaptionImagePath(image.filePath);
    if (!validated.ok) {
      blocks.push({
        type: "text",
        text: `图片 ${image.name} 无法读取：${validated.error}。请诚实说明暂时无法看清这张图，不要编造图片内容。`,
      });
      continue;
    }
    blocks.push({
      type: "image_url",
      image_url: { url: `data:${validated.mime};base64,${validated.buffer.toString("base64")}` },
    });
  }

  const next = messages.slice();
  next[latestUserIndex] = { ...current, content: blocks };
  return next;
}

function buildImageCaptionFallbackMessages(
  systemContent: string,
  messages: ChatMessage[],
  input: AguiRunInput,
  deps: BuildOptionsDeps,
): (() => Promise<ChatMessage[]>) | undefined {
  const images = input.imageAttachments?.filter((image) =>
    typeof image?.filePath === "string" && typeof image?.name === "string",
  ) ?? [];
  if (images.length === 0 || !deps.captionImageForFallback) return undefined;

  return async () => {
    const fallbackMessages = messages.map((message) => ({ ...message }));
    const latestUserIndex = fallbackMessages.map((message) => message.role).lastIndexOf("user");
    if (latestUserIndex < 0) return [{ role: "system", content: systemContent }, ...fallbackMessages];

    const current = fallbackMessages[latestUserIndex];
    const text = contentToText(current.content);
    const imageLines: string[] = [];
    for (const image of images) {
      const result = await deps.captionImageForFallback!(image.filePath);
      if (result.ok && result.caption) {
        imageLines.push(`- ${image.name}：${result.caption}`);
      } else {
        imageLines.push(`- ${image.name}：图片分析失败：${result.error || "图片分析失败"}。请诚实说明暂时无法看清这张图。`);
      }
    }

    const imageContext = "【图片视觉信息】\n以下内容是视觉模型对用户本轮图片的观察结果，请将其视为你已经看到的图片内容；如果某张图分析失败，请不要编造。\n" + imageLines.join("\n");
    fallbackMessages[latestUserIndex] = {
      ...current,
      content: text ? `${text}\n\n${imageContext}` : imageContext,
    };
    return [{ role: "system", content: systemContent }, ...fallbackMessages];
  };
}

/**
 * 构造 CyreneAgent.runWithEvents 所需的 options + 提取 latestUserText。
 * 与 index.ts 原 AG-UI bridge 的 buildOptions 行为完全一致。
 */
export async function buildAgentRunOptions(
  input: AguiRunInput,
  deps: BuildOptionsDeps,
): Promise<{ options: CyreneRunOptions; latestUserText: string; memoryContextText?: string }> {
  const settings = deps.loadModelSettings();
  if (!settings.apiKey) {
    throw new Error("还没有填写 API Key，请先在设置里保存 API 配置。");
  }
  const messages = deps.normalizeChatMessages(input.messages);
  if (messages.length === 0) {
    throw new Error("没有可发送的聊天内容。");
  }
  // slim view for downstream helpers that only need { role, content }
  const slimMessages = messages as unknown as Array<{ role: string; content?: string }>;
  const latestUserText = contentToText(messages.filter((m) => m.role === "user").at(-1)?.content) ?? "";
  const skillActivation = deps.resolveSlashActivation(slimMessages);
  const profile = deps.loadUserProfile();
  const contextTimezone = resolveChatContextTimezone(profile.timezone);
  const chatContextMessages = messages as unknown as ChatContextMessage[];
  const includeCallContext = !input.channel
    || Boolean(input.sessionId && deps.isProactiveConversation?.(input.sessionId));
  const callEvents = includeCallContext ? deps.getCallContextEvents?.() ?? [] : [];
  const mergedHistory = mergeCallEventsIntoHistory(chatContextMessages, callEvents, 16);
  const newCallEventsForMemory = selectNewCallEventsForMemory(chatContextMessages, mergedHistory.visibleEvents);
  const memoryContextText = buildCallMemoryContext(newCallEventsForMemory);
  const { messages: llmMessages, timeContext: conversationTimeContext } = buildConversationTimeContext(
    mergedHistory.messages,
    contextTimezone,
  );
  const slimLlmMessages = llmMessages as Array<{ role: string; content?: string }>;

  let alwaysOnContext = "";
  try {
    alwaysOnContext = await deps.buildAlwaysOnContext(latestUserText, slimMessages);
  } catch (err) {
    console.warn("[Cyrene] always-on context build failed:", err);
  }

  let memoryInjection = "";
  try {
    memoryInjection = await deps.buildMemoryInjection(latestUserText);
  } catch (err) {
    console.warn("[Cyrene] memory injection failed:", err);
  }

  let relationshipContext = "";
  try {
    relationshipContext = await deps.buildRelationshipContext();
  } catch (err) {
    console.warn("[Cyrene] relationship context build failed:", err);
  }

  let environmentContext = "";
  try {
    environmentContext = deps.buildEnvironmentContext(
      { provider: settings.provider, model: settings.model },
      {
        nickname: profile.nickname,
        callPreference: profile.callPreference,
        birthday: profile.birthday,
        defaultCity: profile.defaultCity,
        timezone: profile.timezone,
      },
    );
  } catch (err) {
    console.warn("[Cyrene] environment context build failed:", err);
  }

  const enabledSkills = deps.skillRegistry.getEnabled();
  const skillCatalog = deps.buildSkillCatalog(enabledSkills);
  const autoInjectedSkillContext = deps.buildAutoInjectedSkillContext(enabledSkills);
  const conversationId = input.sessionId || "default";
  const musicCompanionContext = deps.buildMusicCompanionContext?.(conversationId, latestUserText) ?? "";
  const channelSystem = buildChannelSystem(input.channel);

  let toneInjection = "";
  if (deps.sceneEmbeddingIndex) {
    try {
      toneInjection = await deps.buildToneInjection(
        latestUserText,
        slimLlmMessages,
        deps.getSceneEmbeddingProvider(),
        deps.sceneEmbeddingIndex,
      );
    } catch (err) {
      console.warn("[Cyrene] tone injection failed:", err);
    }
  }

  let attachmentContext = "";
  const atts = input.attachments;
  if (atts && atts.length > 0) {
    const parts = atts.map((a) => `--- ${a.name} ---\n${a.text}`);
    attachmentContext = `\n\n【本轮附件内容】\n${parts.join("\n\n")}`;
  }

  const isTalkMode = (input.style || "").startsWith("talk");
  let socialContextBlock = "";
  let socialContext: SocialTurnContext | undefined;
  if (!input.channel && deps.isSocialContextEnabled?.() && input.userTurnId && input.assistantTurnId && deps.retrieveSocialContext) {
    try {
      const retrievedAtoms = await deps.retrieveSocialContext(
        conversationId,
        latestUserText,
        deps.getSocialEmbeddingProvider?.(),
      );
      socialContextBlock = buildSocialContextBlock(retrievedAtoms, contextTimezone);
      socialContext = {
        conversationId,
        userTurnId: input.userTurnId,
        assistantTurnId: input.assistantTurnId,
        userText: latestUserText,
        retrievedAtoms,
      };
      // 重叠抑制：short_term 类型 social atom 与 user_memory 可能命中同一事实。
      // 同时注入会让模型看到重复信息、消耗双份 token，且 social 过期后 user_memory 仍在会造成时间不一致。
      // 命中时优先保留 social（更新、更带时间语义），从 memoryInjection 的【相关记忆】块移除重叠条目。
      // open_loop 是话题延续，与长期事实不同维度，不参与抑制。
      memoryInjection = suppressOverlappingMemoryEntries(memoryInjection, retrievedAtoms, (match) => {
        console.debug("[SocialContext] suppressed overlapping L2 injection:", {
          conversationId,
          score: Number(match.score.toFixed(3)),
          shortTerm: match.socialText,
          memory: match.memoryText,
        });
      });
    } catch (err) {
      console.warn("[SocialContext] retrieval failed:", err);
    }
  }
  // 通话事件改为 system prompt 里的只读数据块（不再作为 role 消息插历史，避免 Anthropic 合并）。
  const callContextBlock = buildCallContextBlock(mergedHistory.visibleEvents, contextTimezone);
  const styleFile = input.style || "01_default.md";
  const enabledTools = deps.toolRegistry.getEnabled();
  // talk 模式白名单：只允许轻量、日常聊天场景常用的工具。
  // - music_* 前缀：音乐陪伴功能在 talk 模式下必须可用
  // - weather：用户日常聊天常问天气，天气卡片是核心体验
  const TALK_MODE_ALLOWED_TOOL_IDS = new Set(["weather"]);
  const TALK_MODE_ALLOWED_TOOL_PREFIXES = ["music_"];
  const runTools = isTalkMode
    ? enabledTools.filter((tool) => {
      const id = String((tool as { id?: unknown }).id ?? "");
      return TALK_MODE_ALLOWED_TOOL_IDS.has(id) || TALK_MODE_ALLOWED_TOOL_PREFIXES.some((prefix) => id.startsWith(prefix));
    })
    : enabledTools;
  const requiredToolName = resolveRequiredMusicTool(
    latestUserText,
    new Set(runTools.map((tool) => String((tool as { id?: unknown }).id ?? ""))),
  );

  // [你的生活] 拟态日程：生活背景属于环境类信息，紧跟 environmentContext 注入。
  // 工具阶段（toolSystemContent）不注入——工具决策不需要拟态生活。
  let lifeContext = "";
  try {
    lifeContext = deps.buildLifeContext?.()?.trim() ?? "";
  } catch (err) {
    console.warn("[Cyrene] life context build failed:", err);
  }

  // 第一期：保留旧 systemContent 兼容（已不再使用，保留字段是为了 logger 诊断）。
  // 同时新增 toolSystemContent / soulSystemBaseContent 两套。
  const systemContent =
    (environmentContext ? environmentContext + "\n\n" : "") +
    (lifeContext ? lifeContext + "\n\n" : "") +
    (conversationTimeContext ? conversationTimeContext + "\n\n---\n\n" : "") +
    (channelSystem ? channelSystem + "\n\n" : "") +
    deps.buildSystemPrompt(styleFile) +
    (skillCatalog ? "\n\n---\n\n" + skillCatalog : "") +
    (autoInjectedSkillContext ? "\n\n---\n\n" + autoInjectedSkillContext : "") +
    skillActivation +
    toneInjection +
    (alwaysOnContext ? "\n\n" + alwaysOnContext + "\n\n" : "") +
    (relationshipContext ? "\n\n" + relationshipContext + "\n\n" : "") +
    attachmentContext;

  // 工具阶段：工具规则 + 运行时工具目录 + 可用 Skill 路由清单 + 环境上下文。
  // environmentContext 必须注入工具阶段：LLM 在决定工具参数时需要知道用户默认城市、桌面路径等信息，
  // 否则会自作主张猜城市/路径（如把苏州猜成武汉）。
  const toolSystemContent = deps.buildToolSystemPrompt(runTools)
    + (environmentContext ? "\n\n---\n\n" + environmentContext : "")
    + (skillCatalog ? "\n\n---\n\n" + skillCatalog : "")
    + (autoInjectedSkillContext ? "\n\n---\n\n" + autoInjectedSkillContext : "")
    + (musicCompanionContext ? "\n\n" + musicCompanionContext : "");

  // Soul 阶段基础 system：人设 + 环境/记忆/关系/附件/渠道（这些是“表达”所需）。
  // 工具结果（role: tool 消息）已在 conversation 中携带，本字段不重复注入；
  // FC 循环 Soul 阶段执行前会按需动态追加 soulToolResultsSummary。
  // 注入顺序与旧路径（requestModelReply）保持一致：记忆 → 世界书（世界书放最后，最靠近 user message）
  // soul 阶段的请求不带 tools，environmentContext 里“可直接调用的工具”在本阶段不成立；
  // 紧跟其后补一句纠正，避免模型在正文阶段徒手写工具调用文本泄给用户。
  const soulPhaseToolCorrection =
    "注意：当前回复阶段工具调用环节已经结束，上面列出的工具现在不能也不需要调用——" +
    "直接用对话里已有的工具结果（如有）自然回复即可，绝不要输出 <tool_call>、<invoke> 之类的调用指令文本。";
  const soulSystemBaseContent =
    (environmentContext ? environmentContext + "\n\n" + soulPhaseToolCorrection + "\n\n" : "") +
    (conversationTimeContext ? conversationTimeContext + "\n\n---\n\n" : "") +
    (channelSystem ? channelSystem + "\n\n" : "") +
    deps.buildSoulSystemBasePrompt(styleFile) +
    (skillCatalog ? "\n\n---\n\n" + skillCatalog : "") +
    (autoInjectedSkillContext ? "\n\n---\n\n" + autoInjectedSkillContext : "") +
    skillActivation +
    toneInjection +
    // lifeContext 一天内随活动切换几次，放头部会在每次切换时从前缀起点切断 prompt 缓存；
    // 挂到尾部动态区（每轮必变的 memoryInjection 之前），切换轮只损尾部零头。
    (lifeContext ? lifeContext + "\n\n" : "") +
    (memoryInjection ? memoryInjection + "\n\n" : "") +
    (socialContextBlock ? socialContextBlock + "\n\n" : "") +
    (callContextBlock ? callContextBlock + "\n\n" : "") +
    (alwaysOnContext ? alwaysOnContext + "\n\n" : "") +
    (relationshipContext ? "\n\n" + relationshipContext + "\n\n" : "") +
    (musicCompanionContext ? "\n\n" + musicCompanionContext : "") +
    attachmentContext;

  deps.logWorldbookInjection(alwaysOnContext, systemContent);

  // 尾部锚点：SOUL 阶段追加在 conversation 之后的压缩版硬规则，
  // 解决 tone-rules 在 system 内部被 16 条历史消息压住的近因劣势（热加载，每轮现读）。
  // 当前时钟一并放在这里：分钟级时间若留在 system 前缀头部会每分钟切断 prompt 缓存；
  // 挪到生成点附近后时间感知反而更强，格式与消息时间戳前缀一致，模型无需适应第二套时间格式。
  const clockLine = `[当前时间] ${formatLocalTime(Date.now(), resolveChatContextTimezone(profile.timezone))}（仅供你感知当下时刻，不要复述）`;
  const toneAnchor = deps.loadToneAnchor?.()?.trim() ?? "";
  const soulTailAnchorContent = toneAnchor ? clockLine + "\n\n" + toneAnchor : clockLine;

  // 第一期：原始 messages 不再携带 system。FC 循环按阶段动态注入。
  const fcMessages: ChatMessage[] = withDirectImageAttachments(llmMessages as unknown as ChatMessage[], input);
  const imageCaptionFallback = buildImageCaptionFallbackMessages(toolSystemContent + "\n\n---\n\n" + soulSystemBaseContent, llmMessages as unknown as ChatMessage[], input, deps);

  return {
    options: {
      settings: {
        provider: settings.provider,
        baseUrl: settings.baseUrl,
        model: settings.model,
        apiKey: settings.apiKey,
        explicitTransport: settings.explicitTransport,
        // reasoning 必须透传：丢掉它会让设置里的思考模式开关对主聊天管线失效
        ...(settings.reasoning ? { reasoning: settings.reasoning } : {}),
      },
      messages: fcMessages,
      conversationId,
      requiredToolName,
      timeoutMs: deps.chatRequestTimeoutMs,
      toolSystemContent,
      soulSystemBaseContent,
      ...(soulTailAnchorContent ? { soulTailAnchorContent } : {}),
      ...(imageCaptionFallback ? { imageCaptionFallback } : {}),
      ...(isTalkMode ? { tools: runTools as ToolDefinition[] } : {}),
      ...(socialContext ? { socialContext } : {}),
    },
    latestUserText,
    ...(memoryContextText ? { memoryContextText } : {}),
  };
}

/**
 * agent 跑完后的副作用：记忆 + 表情/sticker 推断 + 广播。
 * 与 index.ts 原 AG-UI bridge 的 onRunFinished 行为完全一致。
 *
 * 注意：feeling 字段由 inferRuntimeState 内部副作用更新；本函数只同步 status/expression/updatedAt。
 *
 * 渠道（wechat/feishu/...）的 sticker 走 OutgoingMessage.parts（统一消息模型）；
 * 桌面聊天窗保留 IPC 广播（向后兼容 + 桌面渲染端 sticker 选择器依赖此事件）。
 * 两者从同一份 sticker 决定出发，不会重复。
 */
export async function onAgentRunFinished(
  result: CyreneRunResult,
  latestUserText: string,
  deps: OnRunFinishedDeps,
  channel?: "wechat" | "feishu" | "mobile",
  memoryContextText?: string,
): Promise<{ sticker: string | null }> {
  const chatContent = result.reply;
  const sideEffectUserText = stripTurnModelContextForSideEffects(latestUserText);
  const memoryUserText = memoryContextText
    ? `${sideEffectUserText}\n\n${memoryContextText}`
    : sideEffectUserText;
  deps.scheduleMemoryWrite(memoryUserText, chatContent);
  if (result.socialContext && deps.scheduleSocialContextWrite) {
    deps.scheduleSocialContextWrite(result.socialContext, chatContent, deps.loadModelSettings());
  }

  const settings = deps.loadModelSettings();
  const inferredStatus = deps.inferRuntimeState(sideEffectUserText, chatContent, false);
  deps.setRuntimeState({
    status: inferredStatus.status,
    expression: deps.feelingToExpression[deps.runtimeState.feeling ?? ""] ?? 0,
    updatedAt: Date.now(),
  });

  await deps.recordRelationshipTurn({
    userText: sideEffectUserText,
    assistantText: chatContent,
    cyreneFeeling: deps.runtimeState.feeling ?? "平静",
    channel: channel ?? "desktop",
  });

  const stickerIndex = deps.getStickerEmbeddingIndex?.() ?? deps.stickerEmbeddingIndex;
  const stickerQuery = (chatContent + "\n" + sideEffectUserText).slice(0, 1000);
  const stickerMatch =
    settings.stickerEnabled && stickerIndex
      ? await deps.matchSticker(
          stickerQuery,
          deps.getEmbeddingProvider(),
          stickerIndex,
          settings.stickerSimilarityThreshold ?? 0.55,
        )
      : null;
  // 取证日志：观察匹配分布（排查"每条都命中同一张"时看分数离阈值多远）
  if (stickerMatch) {
    console.log(`[sticker] 匹配 ${stickerMatch.id} score=${stickerMatch.score?.toFixed(3) ?? "?"} 阈值=${settings.stickerSimilarityThreshold ?? 0.55}`);
  }
  const stickerCandidate = stickerMatch?.id ?? null;
  const stickerSettings = deps.loadStickerSettings();
  const sticker = stickerCandidate && stickerSettings[stickerCandidate] !== false ? stickerCandidate : null;

  const chatWin = deps.getChatWindow();
  if (chatWin && !chatWin.isDestroyed()) {
    chatWin.webContents.send(IPC.AGUI_EVENT, {
      type: "CUSTOM",
      name: "cyrene.sticker",
      value: sticker,
    });
  }
  if (settings.runtimeSync === "local") {
    deps.broadcastRuntimeStateChanged();
  } else if (settings.runtimeSync === "llm") {
    deps.broadcastRuntimeStateChanged();
    // 心情观察器在渠道 bot (wechat/feishu) 与手机 App (mobile) 上跳过：
    // 节省一次 LLM 调用、加快首条回复，且避免远程消息扰动桌面 Live2D 表情/心情。
    // 桌面聊天（channel === undefined）照常跑，保持 Live2D 表情/心情跟随对话变化。
    if (channel !== "wechat" && channel !== "feishu" && channel !== "mobile") {
      void deps.observeRuntimeState(settings, [], sideEffectUserText, chatContent);
    }
  }

  // 返回 sticker 决定：
  // - 桌面聊天窗的 sticker 由 IPC 广播（上面 chatWin.webContents.send）继续承担
  // - 渠道（wechat/feishu/...）的 sticker 由 dispatcher 收下，纳入 OutgoingMessage.parts
  // - 桌面路径也返回 sticker 以保持签名一致；dispatcher 路径下 channel !== undefined 才会消费它
  return { sticker };
}

// ─── social ↔ user_memory 注入重叠抑制 ───────────────────────────────────
// 同一事实可能同时被 social-context 抓成 short_term atom，又被 MemoryJudge 写进 L2 再由
// RAG 注入【相关记忆】。同时注入会重复消耗 token，且 social 过期后 user_memory 仍在会造成
// 时间不一致。命中时优先保留 social（更新、更带时间语义），从【相关记忆】块移除重叠条目。
// 只抑制 short_term（临时状态）；open_loop 是话题延续，与长期事实不同维度，不参与。

function lexicalOverlap(a: string, b: string): number {
  const setA = new Set(a.toLowerCase().replace(/\s+/g, ""));
  const setB = new Set(b.toLowerCase().replace(/\s+/g, ""));
  if (!setA.size || !setB.size) return 0;
  let intersection = 0;
  for (const ch of setA) if (setB.has(ch)) intersection += 1;
  // min 归一化：短句对长句的重叠率更宽容，适合"明天考试" vs "用户明天有考试"这类同义短句。
  return intersection / Math.min(setA.size, setB.size);
}

const MEMORY_OVERLAP_THRESHOLD = 0.6;

export interface MemoryOverlapDiagnostic {
  memoryText: string;
  socialText: string;
  score: number;
}

/** 从 memoryInjection 的【相关记忆】块移除与 short_term social atoms 高度重叠的条目。
 *  只动【相关记忆】块；【相关文档】/【人物关系】不参与抑制。整块空了则移除整块。 */
export function suppressOverlappingMemoryEntries(
  memoryInjection: string,
  socialAtoms: ReadonlyArray<SocialAtom>,
  onSuppressed?: (match: MemoryOverlapDiagnostic) => void,
): string {
  if (!memoryInjection || socialAtoms.length === 0) return memoryInjection;
  const shortTermContents = socialAtoms
    .filter((atom) => atom.type === "short_term")
    .map((atom) => atom.content.trim())
    .filter(Boolean);
  if (shortTermContents.length === 0) return memoryInjection;

  // 块以 \n\n + 【 分隔。【相关记忆】块内部条目以 \n 分行，notes 行以（开头。
  const blocks = memoryInjection.split(/\n\n(?=【)/);
  const result = blocks.map((block) => {
    if (!block.startsWith("【相关记忆】")) return block;
    const lines = block.split("\n");
    const entries: string[] = [];
    const tail: string[] = [];
    for (const line of lines.slice(1)) {
      if (line.startsWith("· ")) entries.push(line);
      else if (line.trim()) tail.push(line);
    }
    const kept = entries.filter((entry) => {
      // 提取核心文本：去掉 · 前缀，去掉尾部标注（较久远的印象）/⚠️（...）
      const text = entry.replace(/^·\s*/, "").replace(/\s*[（(].*$/, "").trim();
      let strongestMatch: MemoryOverlapDiagnostic | undefined;
      for (const socialText of shortTermContents) {
        const score = lexicalOverlap(text, socialText);
        if (score >= MEMORY_OVERLAP_THRESHOLD && (!strongestMatch || score > strongestMatch.score)) {
          strongestMatch = { memoryText: text, socialText, score };
        }
      }
      if (!strongestMatch) return true;
      onSuppressed?.(strongestMatch);
      return false;
    });
    if (kept.length === 0) return ""; // 整块移除
    return [lines[0], ...kept, ...tail].filter((line) => line.trim()).join("\n");
  }).filter(Boolean);
  return result.join("\n\n");
}
