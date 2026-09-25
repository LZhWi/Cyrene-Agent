import { Bubble, CodeHighlighter, Think, ThoughtChain, type BubbleItemType } from "@ant-design/x";
import { XMarkdown, type ComponentProps } from "@ant-design/x-markdown";
import Latex from "@ant-design/x-markdown/plugins/Latex";
import { Component, createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type ErrorInfo, type KeyboardEvent, type ReactNode } from "react";
import { t, useTranslation } from "../../../i18n";
import { normalizeModelMarkdown } from "./markdown-normalize";
import { resolveAsset } from "../../../../../shared/renderer-base";
import type { AgentRoundRecord, ChatColdRecallRecord, ChatMessageChannelSource, ConversationMode, ProcessMessageRecord, ReasoningBlock, RunActivityRecord, TaskDelegationDisplayRecord, ToolExecutionRecord, ToolFileChange } from "../../../../../shared/chat-types";
import type { ContextUsageSnapshot } from "../../../../../shared/context-usage";
import thinkingMoodUrl from "../../../assets/status-moods/思考中.png?url";
import completedThinkingMoodUrl from "../../../assets/status-moods/提醒.png?url";
import workingMoodUrl from "../../../assets/status-moods/工作中.png?url";
import interruptedMoodUrl from "../../../assets/status-moods/已中断.png?url";
import processedMoodUrl from "../../../assets/status-moods/已处理.png?url";
import connectingMoodUrl from "../../../assets/status-moods/连接中.png?url";
import { useUserAvatar } from "../../../hooks/useUserAvatar";
import {
  assistantRenderStages,
  resolveReasoningExpanded,
  updateReasoningExpanded,
} from "./message-visibility";
import { formatElapsed, resolveRunActivityExpanded, resolveRunActivitySnapshot, shouldAutoCollapseRunActivity } from "./run-activity";
import { RunStageIndicator } from "./RunStageIndicator";
import { TaskPlanCard } from "./TaskPlanCard";
import type { AgentRunStage, TaskPlanPresentation } from "./run-presentation";
import { CopyButton } from "./CopyButton";
import { TtsButton } from "./TtsButton";
import { stopTtsPlayback } from "./tts-playback";
import { LastTurnActionButton } from "./LastTurnActionButton";
import { resolveRevisableLastTurn, type RevisableLastTurn } from "./last-turn-actions";
import { extractMessageStickerId, stripMessageStickerMarkers } from "./message-sticker";
import type { WeatherData } from "./weather/weather-types";
import { WeatherCard } from "./weather/WeatherCard";
import { countRoundChangedFiles, describeToolExecution, resolveAgentRoundTitle } from "./agent-rounds";
import type { SegmentedOutputMode } from "../../../../../shared/preferences";
import { getAssistantReplyBubbleTexts } from "./message-segmentation";
import { TaskDelegationRow } from "./TaskDelegationRow";
import { extractFileChanges, FileChangeCard } from "./FileChangeCard";
import { ReviewPanel } from "./ReviewPanel";
import { MermaidBlock } from "./MermaidBlock";
import { SvgCardBlock } from "./SvgCardBlock";

export interface ChatMessageItem {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  at?: number;
  reasoning?: string;
  reasoningBlocks?: ReasoningBlock[];
  processMessages?: ProcessMessageRecord[];
  agentRounds?: AgentRoundRecord[];
  taskDelegations?: TaskDelegationDisplayRecord[];
  reasoningStreaming?: boolean;
  responseStarted?: boolean;
  streaming?: boolean;
  loading?: boolean;
  /** 请求已发出但尚未收到 Think、工具或正文等首个可视事件。 */
  waitingForFirstEvent?: boolean;
  ttsCacheKey?: string;
  ttsCacheVersion?: string;
  sticker?: string | null;
  toolExecutions?: ToolExecutionRecord[];
  runActivity?: RunActivityRecord;
  runStage?: AgentRunStage;
  /** 关联的 Run ID，用于获取 Review 快照 */
  runId?: string;
  taskPlan?: TaskPlanPresentation;
  attachments?: ChatMessageAttachment[];
  weather?: WeatherData;
  /** 上下文容量快照：运行中为每轮 preRequest 实时值，run 结束后为终态快照。 */
  contextUsage?: ContextUsageSnapshot;
  /** 渠道群聊的发送者/引用等隐藏模型上下文；不直接渲染。 */
  modelContext?: string;
  channelSource?: ChatMessageChannelSource;
  pluginDelivery?: {
    pluginId: string;
    ignoreFeedback?: "pending" | "ignored";
  };
}

export interface ChatMessageAttachment {
  name: string;
  kind: string;
  filePath?: string;
  mime?: string;
  previewUrl?: string;
  caption?: string;
  status?: string;
  reason?: string;
  imageSendMode?: "direct" | "caption";
}

interface ChatMessageListProps {
  messages: ChatMessageItem[];
  conversationId?: string;
  mode: ConversationMode;
  preferredAddress: string;
  stickerSize?: "small" | "standard" | "large";
  segmentedOutputMode?: SegmentedOutputMode;
  onTtsCacheKey?: (messageId: string, cacheKey: string, converterVersion: string) => void;
  revisionBusy?: boolean;
  onEditLastUserMessage?: (messageId: string, content: string) => Promise<boolean>;
  onRegenerateLastResponse?: (userMessageId: string, assistantMessageId: string) => Promise<boolean>;
  onDeleteMessage?: (messageId: string) => Promise<boolean>;
  onIgnorePluginMessage?: (messageId: string) => Promise<boolean>;
  onScrollToBottomVisibilityChange?: (visible: boolean) => void;
  onRegisterScrollToBottom?: (scroll: () => void) => void;
  /** 点击 Review 文件项时打开右侧检查面板 */
  onOpenReviewInspector?: (runId: string, fileIndex: number) => void;
}

const markdownConfig = { extensions: Latex() };
const cyreneAvatarUrl = resolveAsset("avatars/cyrene-avatar.png");
const CHAT_INITIAL_MESSAGE_COUNT = 40;
const CHAT_OLDER_MESSAGE_BATCH = 40;

// 消息是否正在流式输出。code 渲染器收不到 MarkdownContent 的 props，用 context 传下去，
// mermaid 块靠它在流式期间显示占位而不是渲染半截语法
const MessageStreamingContext = createContext(false);

function PluginIgnoreButton({ messageId, onIgnore }: {
  messageId: string;
  onIgnore: (messageId: string) => Promise<boolean>;
}) {
  const [busy, setBusy] = useState(false);
  return (
    <button
      type="button"
      className="cy-message-ignore-button"
      disabled={busy}
      title={t("messageList.ignoreProactiveTitle")}
      aria-label={t("messageList.ignoreProactive")}
      onClick={() => {
        setBusy(true);
        void onIgnore(messageId).then((ok) => {
          if (!ok) setBusy(false);
        }).catch(() => setBusy(false));
      }}
    >
      {t("messageList.ignoreProactive")}
    </button>
  );
}

function ColdRecallButton({ record, onResolve }: {
  record: ChatColdRecallRecord;
  onResolve: (messageId: string, entryId: string, action: "related" | "unrelated" | "undo") => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState("");
  const resolve = async (entryId: string, action: "related" | "unrelated" | "undo") => {
    setBusyId(entryId);
    setError("");
    try { await onResolve(record.messageId, entryId, action); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "归档记忆操作失败"); }
    finally { setBusyId(null); }
  };
  return (
    <span className="cy-cold-recall">
      <button type="button" className="cy-cold-recall__trigger" title="查看本轮参考的归档记忆"
        aria-label="查看本轮参考的归档记忆" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
        <svg width="16" height="16" viewBox="0 0 20 20" fill="none" aria-hidden="true">
          <path d="M5 3.5h9.5a2 2 0 0 1 2 2v9.5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5.5a2 2 0 0 1 2-2Z" stroke="currentColor" strokeWidth="1.5" />
          <path d="M7 7h6M7 10h6M7 13h3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
        </svg>
      </button>
      {open && <div className="cy-cold-recall__panel">
        <strong>本轮参考的归档记忆</strong>
        <p>这些记忆仅临时参与了这次回答，尚未自动激活。</p>
        {record.candidates.map((candidate) => <div className="cy-cold-recall__item" key={candidate.id}>
          <div>{candidate.content}</div>
          <small>{candidate.quote}</small>
          {candidate.evidence && <details><summary>查看来源证据</summary><small>{candidate.evidence}</small></details>}
          <div className="cy-cold-recall__choices">
            {candidate.status === "pending" ? <>
              <button type="button" disabled={busyId !== null} onClick={() => void resolve(candidate.id, "related")}>相关，恢复激活</button>
              <button type="button" disabled={busyId !== null} onClick={() => void resolve(candidate.id, "unrelated")}>无关</button>
            </> : candidate.status === "related" ? <>
              <span>已激活</span>
              <button type="button" disabled={busyId !== null} onClick={() => void resolve(candidate.id, "undo")}>撤销激活</button>
            </> : <span>{candidate.status === "undone" ? "已撤销激活" : "已标记无关"}</span>}
          </div>
        </div>)}
        {error && <p role="alert">{error}</p>}
      </div>}
    </span>
  );
}

function MarkdownCode({ children, lang, block }: ComponentProps<{ children?: ReactNode }>) {
  const streaming = useContext(MessageStreamingContext);
  if (!block) return <code>{children}</code>;
  const source = String(children ?? "").replace(/\n$/, "");
  if ((lang ?? "").split(/\s+/)[0] === "mermaid") {
    return <MermaidBlock code={source} streaming={streaming} />;
  }
  if ((lang ?? "").split(/\s+/)[0] === "svg") {
    return <SvgCardBlock code={source} streaming={streaming} />;
  }
  return (
    <CodeHighlighter lang={(lang ?? "text").split(/\s+/)[0]} prismLightMode={false}>
      {source}
    </CodeHighlighter>
  );
}

const markdownComponents = { code: MarkdownCode };
const completedMarkdownOptions = {
  hasNextChunk: false,
  enableAnimation: false,
  tail: false,
};

class MarkdownRenderBoundary extends Component<{
  content: string;
  children: ReactNode;
}, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error("[ReactChat] Markdown/KaTeX 渲染失败，已降级为原始文本", error, info);
  }

  render(): ReactNode {
    if (this.state.failed) {
      return <pre className="cy-message-markdown-fallback">{this.props.content}</pre>;
    }
    return this.props.children;
  }
}

export function MarkdownContent({ content, streaming }: { content: string; streaming?: boolean }) {
  // 模型偶尔输出畸形 Markdown（# 后缺空格、标题粘正文、围栏粘句子），
  // 渲染前先做机械归一化；归一化与 XMarkdown 解析都在同一 memo 周期内完成
  const normalized = useMemo(() => normalizeModelMarkdown(content), [content]);
  return (
    <MarkdownRenderBoundary content={normalized}>
      <MessageStreamingContext.Provider value={Boolean(streaming)}>
        <XMarkdown
          content={normalized}
          config={markdownConfig}
          components={markdownComponents}
          openLinksInNewTab
          escapeRawHtml
          rootClassName="cy-message-markdown"
          streaming={completedMarkdownOptions}
        />
      </MessageStreamingContext.Provider>
    </MarkdownRenderBoundary>
  );
}

interface EnabledSticker {
  id: string;
  src: string;
}

function resolveStickerUrl(id: string, stickers: EnabledSticker[]): string | undefined {
  const raw = stickers.find((sticker) => sticker.id === id)?.src;
  if (!raw) return undefined;
  return raw.startsWith("/stickers/") ? resolveAsset(raw) : raw;
}

function AssistantContent({
  content,
  streaming,
  stickerUrl,
  segments,
  chatLayout,
  channelSource,
}: {
  content: string;
  streaming: boolean;
  stickerUrl?: string;
  segments?: string[];
  chatLayout: boolean;
  channelSource?: ChatMessageChannelSource;
}) {
  const { t } = useTranslation();
  return (
    <div className="cy-message__assistant-body">
      {channelSource && <ChannelSourceLabel source={channelSource} direction="outgoing" />}
      {segments && (segments.length > 1 || chatLayout)
        ? <div className="cy-message__assistant-segments">
            {segments.map((segment, index) => (
              <div className="cy-message__assistant-segment" key={`${index}-${segment.slice(0, 24)}`}>
                <MarkdownContent content={segment} streaming={streaming && index === segments.length - 1} />
              </div>
            ))}
          </div>
        : content && <MarkdownContent content={content} streaming={streaming} />}
      {stickerUrl && <img className="cy-message__sticker" src={stickerUrl} alt={t("messageList.assistantStickerAlt")} draggable={false} />}
    </div>
  );
}

export function formatMessageTime(timestamp: number | undefined): string {
  if (!Number.isFinite(timestamp)) return "";
  const date = new Date(timestamp as number);
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

function MessageTime({ at }: { at?: number }) {
  const value = formatMessageTime(at);
  return value ? <time className="cy-message-time" dateTime={new Date(at as number).toISOString()}>{value}</time> : null;
}

function DeleteMessageButton({ messageId, disabled, onDelete }: {
  messageId: string;
  disabled: boolean;
  onDelete: (messageId: string) => Promise<boolean>;
}) {
  const { t } = useTranslation();
  const [busy, setBusy] = useState(false);
  return (
    <button
      type="button"
      className="cy-message-delete"
      disabled={disabled || busy}
      title={t("messageList.delete")}
      aria-label={t("messageList.deleteAria")}
      onClick={() => {
        if (!window.confirm(t("messageList.deleteConfirm"))) return;
        setBusy(true);
        void onDelete(messageId).finally(() => setBusy(false));
      }}
    >
      <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true">
        <path d="M4 7h16M9 7V4h6v3M6 7l1 12h10l1-12" stroke="currentColor" strokeWidth="1.6" fill="none" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </button>
  );
}

const channelNameKeys: Record<ChatMessageChannelSource["channel"], string> = {
  wechat: "messageList.channelSource.wechat",
  feishu: "messageList.channelSource.feishu",
  qq: "messageList.channelSource.qq",
  qqbot: "messageList.channelSource.qqbot",
};

function ChannelSourceLabel({
  source,
  direction,
}: {
  source: ChatMessageChannelSource;
  direction: "incoming" | "outgoing";
}) {
  const label = formatChannelSourceLabel(source, direction);
  return label ? <span className="cy-message__channel-source">{label}</span> : null;
}

export function formatChannelSourceLabel(
  source: ChatMessageChannelSource,
  direction: "incoming" | "outgoing",
): string {
  if (direction === "outgoing" || source.chatType !== "group") return "";
  return source.senderName?.trim() ?? "";
}

function channelName(channel: ChatMessageChannelSource["channel"]): string {
  const key = channelNameKeys[channel];
  return key ? t(key) : t("messageList.channelSource.unknown");
}

/** 把逐条来源提示收拢为会话级提示，避免每个气泡都像日志。 */
export function resolveChannelConversationLabel(
  messages: readonly Pick<ChatMessageItem, "channelSource">[],
): string | null {
  const channels = Array.from(new Set(
    messages
      .map((message) => message.channelSource?.channel)
      .filter((channel): channel is ChatMessageChannelSource["channel"] => Boolean(channel)),
  ));
  if (channels.length === 0) return null;
  return t("messageList.channelSource.sameConversation", {
    channels: channels.map(channelName).join("、"),
  });
}

function DotSpinner() {
  const { t } = useTranslation();
  return (
    <span className="cy-dot-spinner" aria-label={t("messageList.loadingAria")} role="status">
      {Array.from({ length: 8 }, (_, index) => <span className="cy-dot-spinner__dot" key={index} />)}
    </span>
  );
}

function ModelWaitContent() {
  const { t } = useTranslation();
  return (
    <section className="cy-model-wait" aria-label={t("messageList.modelWaitAria")}>
      <span className="cy-model-wait__art" aria-hidden="true">
        <img src={connectingMoodUrl} alt="" draggable={false} />
        <DotSpinner />
      </span>
      <span>{t("messageList.modelWaitText")}</span>
    </section>
  );
}

function ReasoningContent({
  content,
  loading,
  expanded,
  onExpand,
}: {
  content: string;
  loading: boolean;
  expanded: boolean;
  onExpand: (expanded: boolean) => void;
}) {
  const { t } = useTranslation();
  return (
    <Think
      rootClassName="cy-message-reasoning"
      title={loading ? t("messageList.thinkingTitle") : t("messageList.thinkingDoneTitle")}
      icon={
        <span className={`cy-reasoning-status-art${loading ? " is-thinking" : " is-complete"}`} aria-hidden="true">
          <img src={thinkingMoodUrl} alt="" draggable={false} />
          {loading && <DotSpinner />}
        </span>
      }
      blink={loading}
      expanded={expanded}
      onExpand={onExpand}
      destroyOnHidden
    >
      {content && <MarkdownContent content={content} streaming={loading} />}
    </Think>
  );
}

function useRunActivityNow(processing: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!processing) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [processing]);
  return now;
}

function RunActivityReasoningBlock({ block }: { block: ReasoningBlock }) {
  const streaming = Boolean(block.streaming);
  // 与纯聊天模式保持一致：思考块默认折叠（含流式生成期间），仅用户点击后展开
  const [expanded, setExpanded] = useState(false);
  return (
    <ReasoningContent
      content={block.content}
      loading={streaming}
      expanded={expanded}
      onExpand={setExpanded}
    />
  );
}

function AgentRoundGroup({
  round,
  reasoningBlocks,
  processMessages,
  taskDelegations,
  tools,
  interrupted,
}: {
  round: AgentRoundRecord;
  reasoningBlocks: ReasoningBlock[];
  processMessages: ProcessMessageRecord[];
  taskDelegations: TaskDelegationDisplayRecord[];
  tools: ToolExecutionRecord[];
  interrupted: boolean;
}) {
  const { t } = useTranslation();
  const running = round.status === "running" && !interrupted;
  const [expanded, setExpanded] = useState(running);
  const wasRunningRef = useRef(running);
  useEffect(() => {
    if (!wasRunningRef.current && running) setExpanded(true);
    if (wasRunningRef.current && !running) setExpanded(false);
    wasRunningRef.current = running;
  }, [running]);

  const roundArt = interrupted
    ? interruptedMoodUrl
    : running
      ? workingMoodUrl
      : completedThinkingMoodUrl;

  return (
    <section className={`cy-agent-round${running ? " is-running" : " is-complete"}`}>
      {processMessages.filter((message) => message.content.trim()).map((message) => (
        <div className="cy-run-activity__process" key={message.id}>
          <MarkdownContent content={message.content} />
        </div>
      ))}
      {taskDelegations.map((delegation) => (
        <TaskDelegationRow delegation={delegation} key={delegation.invocationId} />
      ))}
      <button
        type="button"
        className="cy-agent-round__header"
        aria-expanded={expanded}
        onClick={() => setExpanded((current) => !current)}
      >
        <span className="cy-agent-round__art" aria-hidden="true">
          <img
            className="cy-agent-round__art-image"
            src={roundArt}
            alt=""
            draggable={false}
          />
        </span>
        <span className="cy-agent-round__title">
          {resolveAgentRoundTitle(round, tools, interrupted)}
          {!interrupted && round.status !== "running" && countRoundChangedFiles(tools) > 0 && (
            <span className="cy-agent-round__files"> · {t("messageList.roundChangedFiles", { count: countRoundChangedFiles(tools) })}</span>
          )}
        </span>
        <svg className={`cy-agent-round__chevron${expanded ? " is-expanded" : ""}`} viewBox="0 0 16 16" aria-hidden="true">
          <path d="m4 6 4 4 4-4" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.75" />
        </svg>
      </button>
      {expanded && (
        <div className="cy-agent-round__body">
          {reasoningBlocks.filter((block) => block.content.trim()).map((block) => (
            <RunActivityReasoningBlock block={block} key={block.id} />
          ))}
          {tools.length > 0 && <ToolExecutionContent tools={tools} />}
        </div>
      )}
    </section>
  );
}

export function RunActivityDetail({
  agentRounds = [],
  reasoningBlocks,
  processMessages,
  taskDelegations = [],
  tools,
  interrupted = false,
}: {
  agentRounds?: AgentRoundRecord[];
  reasoningBlocks: ReasoningBlock[];
  processMessages: ProcessMessageRecord[];
  taskDelegations?: TaskDelegationDisplayRecord[];
  tools: ToolExecutionRecord[];
  interrupted?: boolean;
}) {
  const { t } = useTranslation();
  if (agentRounds.length > 0) {
    const visibleRounds = agentRounds.filter((round) =>
      processMessages.some((message) => message.roundId === round.id && message.content.trim())
      || reasoningBlocks.some((block) => block.roundId === round.id && block.content.trim())
      || taskDelegations.some((delegation) => delegation.roundId === round.id)
      || tools.some((tool) => tool.roundId === round.id));
    if (visibleRounds.length === 0) {
      return <div className="cy-run-activity__empty">{t("messageList.organizingReply")}</div>;
    }
    return (
      <div className="cy-run-activity__detail">
        {visibleRounds.map((round) => (
          <AgentRoundGroup
            key={round.id}
            round={round}
            interrupted={interrupted && round.status === "running"}
            processMessages={processMessages.filter((message) => message.roundId === round.id)}
            taskDelegations={taskDelegations.filter((delegation) => delegation.roundId === round.id)}
            reasoningBlocks={reasoningBlocks.filter((block) => block.roundId === round.id)}
            tools={tools.filter((tool) => tool.roundId === round.id)}
          />
        ))}
      </div>
    );
  }
  const timeline: ReactNode[] = [];
  taskDelegations.forEach((delegation) => {
    timeline.push(<TaskDelegationRow delegation={delegation} key={`task-${delegation.invocationId}`} />);
  });
  for (let index = 0; index <= tools.length; index += 1) {
    processMessages
      .filter((message) => (message.afterToolCount ?? 0) === index)
      .forEach((message) => {
        if (!message.content.trim()) return;
        timeline.push(
          <div className="cy-run-activity__process" key={`process-${message.id}`}>
            <MarkdownContent content={message.content} />
          </div>,
        );
      });
    reasoningBlocks
      .filter((block) => (block.afterToolCount ?? 0) === index)
      .forEach((block) => {
        if (!block.content.trim()) return;
        timeline.push(
          <RunActivityReasoningBlock
            key={`reasoning-${block.id}`}
            block={block}
          />,
        );
      });
    if (index < tools.length) {
      timeline.push(<ToolExecutionContent key={`tool-${tools[index].id}`} tools={[tools[index]]} />);
    }
  }
  return timeline.length
    ? <div className="cy-run-activity__detail">{timeline}</div>
    : <div className="cy-run-activity__empty">{t("messageList.organizingReply")}</div>;
}

function RunActivityContent({
  activityId,
  activity,
  reasoningBlocks,
  processMessages,
  agentRounds,
  taskDelegations,
  tools,
  stage,
  taskPlan,
  expanded,
  onExpand,
}: {
  activityId: string;
  activity: RunActivityRecord;
  reasoningBlocks: ReasoningBlock[];
  processMessages: ProcessMessageRecord[];
  agentRounds: AgentRoundRecord[];
  taskDelegations: TaskDelegationDisplayRecord[];
  tools: ToolExecutionRecord[];
  stage?: AgentRunStage;
  taskPlan?: TaskPlanPresentation;
  expanded: boolean;
  onExpand: (expanded: boolean) => void;
}) {
  const { t } = useTranslation();
  const now = useRunActivityNow(activity.completedAt === undefined);
  const snapshot = resolveRunActivitySnapshot(activity, now);
  const wasProcessingRef = useRef(snapshot.processing);
  useEffect(() => {
    if (shouldAutoCollapseRunActivity(wasProcessingRef.current, snapshot.processing, activity.keepExpanded)) onExpand(false);
    wasProcessingRef.current = snapshot.processing;
  }, [activity.keepExpanded, onExpand, snapshot.processing]);

  const title = snapshot.processing
    ? t("messageList.activityProcessingTitle", { elapsed: formatElapsed(snapshot.processingMs) })
    : t("messageList.activityProcessedTitle", { elapsed: formatElapsed(snapshot.processingMs) });
  const image = snapshot.processing ? workingMoodUrl : processedMoodUrl;

  return (
    <section className={`cy-run-activity${snapshot.processing ? " is-processing" : " is-complete"}`}>
      <button
        type="button"
        className="cy-run-activity__header"
        onClick={() => onExpand(!expanded)}
        aria-expanded={expanded}
        aria-controls={`${activityId}-details`}
      >
        <span className="cy-run-activity__title">
            <span className="cy-run-activity__art" aria-hidden="true">
              <img src={image} alt="" draggable={false} />
              {snapshot.processing && <DotSpinner />}
            </span>
            <span>{title}</span>
            {stage && <RunStageIndicator stage={stage} />}
        </span>
        <svg className={`cy-run-activity__chevron${expanded ? " is-expanded" : ""}`} viewBox="0 0 16 16" aria-hidden="true">
          <path d="m4 6 4 4 4-4" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.75" />
        </svg>
      </button>
      {expanded && (
        <div className="cy-run-activity__expanded" id={`${activityId}-details`}>
          {taskPlan && <TaskPlanCard plan={taskPlan} />}
          <div className="cy-run-activity__divider" />
          <RunActivityDetail
            agentRounds={agentRounds}
            reasoningBlocks={reasoningBlocks}
            processMessages={processMessages}
            taskDelegations={taskDelegations}
            tools={tools}
            interrupted={Boolean(activity.keepExpanded && activity.completedAt !== undefined)}
          />
          <div className="cy-run-activity__divider" />
        </div>
      )}
    </section>
  );
}

function ToolExecutionContent({ tools }: { tools: ToolExecutionRecord[] }) {
  const { t } = useTranslation();
  return (
    <section className="cy-tool-executions" aria-label={t("messageList.toolExecutionsAria")}>
      <ThoughtChain
        rootClassName="cy-tool-executions__chain"
        line="dashed"
        items={tools.map((tool) => {
          const presentation = describeToolExecution(tool);
          return {
            key: tool.id,
            title: presentation.label,
            description: (
              <span className="cy-tool-executions__description">
                <span className="cy-tool-executions__status">{presentation.statusText}</span>
                {presentation.detail && <code className="cy-tool-executions__detail">{presentation.detail}</code>}
              </span>
            ),
            status: tool.status === "running" ? "loading" : tool.status === "error" ? "error" : "success",
            blink: tool.status === "running",
            collapsible: Boolean(tool.result || tool.changes),
            content: (tool.result || tool.changes)
              ? <ToolResultContent result={tool.result} changes={tool.changes} />
              : undefined,
          };
        })}
      />
    </section>
  );
}

/** 工具结果展示：优先用事件携带的结构化 changes 渲染 Diff Review 卡片；否则尝试解析完整 result JSON；最后原样展示 */
function ToolResultContent({ result, changes }: { result?: string; changes?: ToolFileChange[] }) {
  if (changes && changes.length > 0) return <FileChangeCard changes={changes} />;
  if (result) {
    const parsed = extractFileChanges(result);
    if (parsed) return <FileChangeCard changes={parsed} />;
    return <pre className="cy-tool-executions__result">{result}</pre>;
  }
  return null;
}

function attachmentStatus(attachment: ChatMessageAttachment): string | undefined {
  if (attachment.status === "processing") return t("messageList.attachmentProcessing");
  if (attachment.status === "error") return attachment.reason ?? t("messageList.attachmentErrorFallback");
  if (attachment.imageSendMode === "direct") return t("messageList.attachmentDirect");
  if (attachment.imageSendMode === "caption" && attachment.status === "done") return t("messageList.attachmentDone");
  return undefined;
}

function UserAttachments({ attachments }: { attachments: ChatMessageAttachment[] }) {
  useTranslation();
  if (attachments.length === 0) return null;
  return (
    <div className="cy-message__attachments">
      {attachments.map((attachment, index) => {
        const status = attachmentStatus(attachment);
        if (attachment.kind === "image" && (attachment.previewUrl || attachment.filePath)) {
          return (
            <figure className="cy-message__image-attachment" key={`${attachment.filePath ?? attachment.name}-${index}`}>
              <AttachmentImage attachment={attachment} />
              {status && <figcaption className={attachment.status === "error" ? "is-error" : ""}>{status}</figcaption>}
            </figure>
          );
        }
        return <span className="cy-message__file-attachment" key={`${attachment.filePath ?? attachment.name}-${index}`}>{attachment.name}</span>;
      })}
    </div>
  );
}

function AttachmentImage({ attachment }: { attachment: ChatMessageAttachment }) {
  const [src, setSrc] = useState(attachment.previewUrl);
  // blob: 预览 URL 只在当前页面有效，聊天记录持久化后刷新必失效；只允许一次磁盘重读兜底
  const diskFallbackTriedRef = useRef(false);

  function readFromDisk(): void {
    if (!attachment.filePath) return;
    void window.chat?.getImagePreview?.(attachment.filePath).then((result) => {
      if (result.ok && result.dataUrl) setSrc(result.dataUrl);
    });
  }

  useEffect(() => {
    setSrc(attachment.previewUrl);
    diskFallbackTriedRef.current = false;
    if ((!attachment.previewUrl || attachment.previewUrl.startsWith("file:")) && attachment.filePath) {
      let active = true;
      void window.chat?.getImagePreview?.(attachment.filePath).then((result) => {
        if (active && result.ok && result.dataUrl) setSrc(result.dataUrl);
      });
      return () => {
        active = false;
      };
    }
  }, [attachment.filePath, attachment.previewUrl]);

  // 历史 blob: URL 加载失败时从磁盘重读，修复刷新后的存量裂图
  function handleImageError(): void {
    if (diskFallbackTriedRef.current) return;
    diskFallbackTriedRef.current = true;
    readFromDisk();
  }

  return <img src={src} alt={attachment.name} draggable={false} onError={handleImageError} />;
}

function UserContent({
  content,
  stickerUrl,
  attachments = [],
  chatLayout,
  channelSource,
}: {
  content: string;
  stickerUrl?: string;
  attachments?: ChatMessageAttachment[];
  chatLayout: boolean;
  channelSource?: ChatMessageChannelSource;
}) {
  const { t } = useTranslation();
  return (
    <div className="cy-message__user-body">
      {channelSource && <ChannelSourceLabel source={channelSource} direction="incoming" />}
      <UserAttachments attachments={attachments} />
      {content && (chatLayout
        ? <div className="cy-message__user-bubble"><MarkdownContent content={content} /></div>
        : <MarkdownContent content={content} />)}
      {stickerUrl && <img className="cy-message__sticker" src={stickerUrl} alt={t("messageList.userStickerAlt")} draggable={false} />}
    </div>
  );
}

function LastUserMessageEditor({
  value,
  busy,
  onChange,
  onCancel,
  onSubmit,
}: {
  value: string;
  busy: boolean;
  onChange: (value: string) => void;
  onCancel: () => void;
  onSubmit: () => void;
}) {
  const { t } = useTranslation();
  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      onCancel();
    } else if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      onSubmit();
    }
  };
  return (
    <div className="cy-last-message-editor">
      <textarea
        autoFocus
        value={value}
        disabled={busy}
        aria-label={t("messageList.editLastMessageAria")}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={handleKeyDown}
      />
      <div className="cy-last-message-editor__actions">
        <button type="button" disabled={busy} onClick={onCancel}>{t("common.cancel")}</button>
        <button type="button" className="is-primary" disabled={busy || !value.trim()} onClick={onSubmit}>
          {t("messageList.saveAndRegenerate")}
        </button>
      </div>
    </div>
  );
}

function CyreneMessageAvatar() {
  const { t } = useTranslation();
  return <img className="cy-message-avatar__image" src={cyreneAvatarUrl} alt={t("messageList.cyreneAvatarAlt")} draggable={false} />;
}

function UserMessageAvatar({ src }: { src: string | null }) {
  const { t } = useTranslation();
  if (src) return <img className="cy-message-avatar__image" src={src} alt={t("messageList.userAvatarAlt")} draggable={false} />;
  return <span className="cy-message-avatar__user" aria-label={t("messageList.userAvatarAlt")} />;
}

function createRoles(
  userAvatarUrl: string | null,
  conversationId: string | undefined,
  mode: ConversationMode,
  preferredAddress: string,
  lastTurn: RevisableLastTurn | null,
  editingMessageId: string | null,
  editDraft: string,
  revisionBusy: boolean,
  onBeginEdit: (messageId: string, content: string) => void,
  onEditDraftChange: (value: string) => void,
  onCancelEdit: () => void,
  onSubmitEdit: () => void,
  onRegenerate: () => void,
  onDeleteMessage: ((messageId: string) => Promise<boolean>) | undefined,
  reasoningExpanded: Readonly<Record<string, boolean>>,
  onReasoningExpand: (id: string, expanded: boolean) => void,
  onTtsCacheKey?: (messageId: string, cacheKey: string, converterVersion: string) => void,
  onOpenReviewInspector?: (runId: string, fileIndex: number) => void,
  onIgnorePluginMessage?: (messageId: string) => Promise<boolean>,
  coldRecalls?: Readonly<Record<string, ChatColdRecallRecord>>,
  onResolveColdRecall?: (messageId: string, entryId: string, action: "related" | "unrelated" | "undo") => Promise<void>,
) {
  return {
  user: {
    placement: "end" as const,
    variant: "filled" as const,
    rootClassName: "cy-message cy-message--user",
    avatar: <UserMessageAvatar src={userAvatarUrl} />,
    contentRender: (content: string, info: { extraInfo?: { messageId?: string; stickerUrl?: string; attachments?: ChatMessageAttachment[]; channelSource?: ChatMessageChannelSource } }) => (
      info.extraInfo?.messageId === editingMessageId
        ? <LastUserMessageEditor
            value={editDraft}
            busy={revisionBusy}
            onChange={onEditDraftChange}
            onCancel={onCancelEdit}
            onSubmit={onSubmitEdit}
          />
        : <UserContent
            content={content}
            stickerUrl={info.extraInfo?.stickerUrl}
            attachments={info.extraInfo?.attachments}
            chatLayout={mode === "chat"}
            channelSource={info.extraInfo?.channelSource}
          />
    ),
    footer: (content: string, info: { extraInfo?: { messageId?: string; at?: number } }) => {
      const cleanText = content.replace(/\[sticker:[^\]]+\]/g, "").trim();
      const messageId = info.extraInfo?.messageId;
      if ((!messageId && !cleanText) || messageId === editingMessageId) return null;
      return (
        <div className="cy-message-actions">
          {cleanText && messageId === lastTurn?.userMessageId && (
            <LastTurnActionButton
              kind="edit"
              disabled={revisionBusy}
              onClick={() => onBeginEdit(messageId, cleanText)}
            />
          )}
          <CopyButton text={cleanText} size={mode === "chat" ? 14 : undefined} />
          {mode === "chat" && messageId && onDeleteMessage && (
            <DeleteMessageButton messageId={messageId} disabled={revisionBusy} onDelete={onDeleteMessage} />
          )}
          {mode === "chat" && <MessageTime at={info.extraInfo?.at} />}
        </div>
      );
    },
  },
  assistant: {
    placement: "start" as const,
    variant: "filled" as const,
    rootClassName: "cy-message cy-message--assistant",
    avatar: <CyreneMessageAvatar />,
    contentRender: (content: string, info: { extraInfo?: { streaming?: boolean; stickerUrl?: string; segments?: string[]; channelSource?: ChatMessageChannelSource } }) => (
      <AssistantContent
        content={content}
        streaming={Boolean(info.extraInfo?.streaming)}
        stickerUrl={info.extraInfo?.stickerUrl}
        segments={info.extraInfo?.segments}
        chatLayout={mode === "chat"}
        channelSource={info.extraInfo?.channelSource}
      />
    ),
    footer: (content: string, info: { extraInfo?: { messageId?: string; at?: number; streaming?: boolean; ttsCacheKey?: string; pluginDelivery?: ChatMessageItem["pluginDelivery"] } }) => {
      const cleanText = content.trim();
      const messageId = info.extraInfo?.messageId;
      const canRegenerate = messageId === lastTurn?.assistantMessageId;
      if (info.extraInfo?.streaming || (!messageId && !cleanText && !canRegenerate)) return null;
      return (
        <div className="cy-message-actions">
          {cleanText && messageId && conversationId && (
            <TtsButton
              conversationId={conversationId}
              messageId={messageId}
              text={cleanText}
              size={mode === "chat" ? 14 : undefined}
              speechMode={mode === "learn" ? "learn" : "default"}
              preferredAddress={preferredAddress}
              onCacheKey={(cacheKey, converterVersion) => onTtsCacheKey?.(messageId, cacheKey, converterVersion)}
            />
          )}
          {cleanText && <CopyButton text={cleanText} size={mode === "chat" ? 14 : undefined} />}
          {mode === "chat" && messageId && onDeleteMessage && (
            <DeleteMessageButton messageId={messageId} disabled={revisionBusy} onDelete={onDeleteMessage} />
          )}
          {messageId && info.extraInfo?.pluginDelivery?.ignoreFeedback === "pending" && onIgnorePluginMessage && (
            <PluginIgnoreButton messageId={messageId} onIgnore={onIgnorePluginMessage} />
          )}
          {mode === "chat" && messageId && coldRecalls?.[messageId] && onResolveColdRecall && (
            <ColdRecallButton record={coldRecalls[messageId]} onResolve={onResolveColdRecall} />
          )}
          {canRegenerate && (
            <LastTurnActionButton kind="regenerate" disabled={revisionBusy} onClick={onRegenerate} />
          )}
          {mode === "chat" && <MessageTime at={info.extraInfo?.at} />}
        </div>
      );
    },
  },
  reasoning: {
    placement: "start" as const,
    variant: "borderless" as const,
    rootClassName: "cy-message cy-message--reasoning",
    contentRender: (_content: string, info: { extraInfo?: { reasoningId?: string; reasoning?: string; reasoningStreaming?: boolean } }) => (
      <ReasoningContent
        content={info.extraInfo?.reasoning ?? ""}
        loading={Boolean(info.extraInfo?.reasoningStreaming)}
        expanded={info.extraInfo?.reasoningId
          ? resolveReasoningExpanded(reasoningExpanded, info.extraInfo.reasoningId)
          : false}
        onExpand={(expanded) => {
          if (info.extraInfo?.reasoningId) onReasoningExpand(info.extraInfo.reasoningId, expanded);
        }}
      />
    ),
  },
  activity: {
    placement: "start" as const,
    variant: "borderless" as const,
    avatar: null,
    rootClassName: "cy-message cy-message--activity",
    contentRender: (_content: string, info: {
      extraInfo?: {
        activityId?: string;
        activity?: RunActivityRecord;
        reasoningBlocks?: ReasoningBlock[];
        processMessages?: ProcessMessageRecord[];
        agentRounds?: AgentRoundRecord[];
        taskDelegations?: TaskDelegationDisplayRecord[];
        tools?: ToolExecutionRecord[];
        runStage?: AgentRunStage;
        taskPlan?: TaskPlanPresentation;
      };
    }) => {
      const activityId = info.extraInfo?.activityId;
      const activity = info.extraInfo?.activity;
      if (!activityId || !activity) return null;
      return (
        <RunActivityContent
          activityId={activityId}
          activity={activity}
          reasoningBlocks={info.extraInfo?.reasoningBlocks ?? []}
          processMessages={info.extraInfo?.processMessages ?? []}
          agentRounds={info.extraInfo?.agentRounds ?? []}
          taskDelegations={info.extraInfo?.taskDelegations ?? []}
          tools={info.extraInfo?.tools ?? []}
          stage={info.extraInfo?.runStage}
          taskPlan={info.extraInfo?.taskPlan}
          expanded={resolveRunActivityExpanded(reasoningExpanded, activityId, activity)}
          onExpand={(expanded) => onReasoningExpand(activityId, expanded)}
        />
      );
    },
  },
  tool: {
    placement: "start" as const,
    variant: "borderless" as const,
    avatar: null,
    rootClassName: "cy-message cy-message--tool",
    contentRender: (_content: string, info: { extraInfo?: { tools?: ToolExecutionRecord[] } }) => (
      info.extraInfo?.tools?.length ? <ToolExecutionContent tools={info.extraInfo.tools} /> : null
    ),
  },
  waiting: {
    placement: "start" as const,
    variant: "borderless" as const,
    avatar: null,
    rootClassName: "cy-message cy-message--waiting",
    contentRender: () => <ModelWaitContent />,
  },
  weather: {
    placement: "start" as const,
    variant: "borderless" as const,
    avatar: null,
    rootClassName: "cy-message cy-message--weather",
    contentRender: (_content: string, info: { extraInfo?: { weather?: WeatherData } }) => (
      info.extraInfo?.weather ? <WeatherCard data={info.extraInfo.weather} /> : null
    ),
  },
  review: {
    placement: "start" as const,
    variant: "borderless" as const,
    avatar: null,
    rootClassName: "cy-message cy-message--review",
    contentRender: (_content: string, info: { extraInfo?: { runId?: string } }) => (
      info.extraInfo?.runId
        ? <ReviewPanel runId={info.extraInfo.runId} onOpenInspector={onOpenReviewInspector} />
        : null
    ),
  },
  system: {
    placement: "start" as const,
    variant: "borderless" as const,
    rootClassName: "cy-message cy-message--system",
  },
  };
}

export function createMessageItems(
  messages: ChatMessageItem[],
  enabledStickers: EnabledSticker[],
  mode: ConversationMode = "work",
  segmentedOutputMode: SegmentedOutputMode = "off",
): BubbleItemType[] {
  return messages.flatMap((message) => createMessageItemsForMessage(message, enabledStickers, mode, segmentedOutputMode));
}

function createMessageItemsForMessage(
  message: ChatMessageItem,
  enabledStickers: EnabledSticker[],
  mode: ConversationMode,
  segmentedOutputMode: SegmentedOutputMode,
): BubbleItemType[] {
    if (message.role !== "assistant") {
      const stickerId = extractMessageStickerId(message.content, message.sticker);
      return [{
        key: message.id,
        role: message.role,
        content: stripMessageStickerMarkers(message.content),
        extraInfo: {
          stickerUrl: stickerId ? resolveStickerUrl(stickerId, enabledStickers) : undefined,
          attachments: message.attachments,
          messageId: message.id,
          at: message.at,
          channelSource: message.channelSource,
        },
      }];
    }

    const assistantItems: BubbleItemType[] = [];
    const stages = assistantRenderStages(message);
    if (message.waitingForFirstEvent && !message.runActivity) {
      assistantItems.push({
        key: `${message.id}-waiting`,
        role: "waiting",
        content: "",
      });
    }
    const reasoningBlocks = message.reasoningBlocks?.length
      ? message.reasoningBlocks
      : (stages.includes("reasoning") ? [{ id: `${message.id}-legacy`, content: message.reasoning ?? "", streaming: message.reasoningStreaming }] : []);
    const appendReasoning = (block: ReasoningBlock) => {
      assistantItems.push({
        key: `${message.id}-reasoning-${block.id}`,
        role: "reasoning",
        content: "",
        extraInfo: {
          reasoningId: block.id,
          reasoning: block.content,
          reasoningStreaming: block.streaming,
        },
      });
    };
    const tools = message.toolExecutions ?? [];
    if (message.runActivity) {
      assistantItems.push({
        key: `${message.id}-activity`,
        role: "activity",
        content: "",
        extraInfo: {
          activityId: `${message.id}-activity`,
          activity: message.runActivity,
          reasoningBlocks,
          processMessages: message.processMessages ?? [],
          agentRounds: message.agentRounds ?? [],
          taskDelegations: message.taskDelegations ?? [],
          tools,
          runStage: message.runStage,
          taskPlan: message.taskPlan,
        },
      });
    } else {
      for (let index = 0; index <= tools.length; index += 1) {
        reasoningBlocks.filter((block) => (block.afterToolCount ?? 0) === index).forEach(appendReasoning);
        if (index === tools.length) continue;
        assistantItems.push({
          key: `${message.id}-tool-${tools[index].id}`,
          role: "tool",
          content: "",
          extraInfo: { tools: [tools[index]] },
        });
      }
    }
    if (message.weather) {
      assistantItems.push({
        key: `${message.id}-weather`,
        role: "weather",
        content: "",
        extraInfo: { weather: message.weather },
      });
    }
    if (stages.includes("assistant")) {
      const segments = getAssistantReplyBubbleTexts(
        message.content,
        mode,
        mode === "chat" ? segmentedOutputMode : "off",
      );
      assistantItems.push({
        key: message.id,
        role: "assistant",
        content: message.content,
        streaming: message.streaming,
        extraInfo: {
          messageId: message.id,
          at: message.at,
          streaming: message.streaming,
          ttsCacheKey: message.ttsCacheKey,
          stickerUrl: message.sticker ? resolveStickerUrl(message.sticker, enabledStickers) : undefined,
          segments,
          channelSource: message.channelSource,
          pluginDelivery: message.pluginDelivery,
        },
      });
    }
    // Review 面板：Run 结束后（非 streaming/loading）且有 runId 时显示
    if (message.runId && !message.streaming && !message.loading) {
      assistantItems.push({
        key: `${message.id}-review`,
        role: "review",
        content: "",
        extraInfo: { runId: message.runId },
      });
    }
    return assistantItems;
}

export function ChatMessageList({
  messages,
  conversationId,
  mode,
  preferredAddress,
  stickerSize = "standard",
  segmentedOutputMode = "off",
  onTtsCacheKey,
  revisionBusy = false,
  onEditLastUserMessage,
  onRegenerateLastResponse,
  onDeleteMessage,
  onIgnorePluginMessage,
  onScrollToBottomVisibilityChange,
  onRegisterScrollToBottom,
  onOpenReviewInspector,
}: ChatMessageListProps) {
  const userAvatarUrl = useUserAvatar();
  const [enabledStickers, setEnabledStickers] = useState<EnabledSticker[]>([]);
  const [reasoningExpanded, setReasoningExpanded] = useState<Record<string, boolean>>({});
  const [coldRecalls, setColdRecalls] = useState<Record<string, ChatColdRecallRecord>>({});
  const [editingMessageId, setEditingMessageId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState("");
  const [visibleWindow, setVisibleWindow] = useState<{ key: string; firstMessageId: string } | null>(null);
  const windowKey = `${mode}:${conversationId ?? ""}`;
  const initialVisibleStart = Math.max(0, messages.length - CHAT_INITIAL_MESSAGE_COUNT);
  const anchoredStart = visibleWindow?.key === windowKey
    ? messages.findIndex((message) => message.id === visibleWindow.firstMessageId)
    : -1;
  const visibleStart = mode === "chat" && anchoredStart >= 0 ? anchoredStart : initialVisibleStart;
  const visibleMessages = useMemo(
    () => mode === "chat" ? messages.slice(visibleStart) : messages,
    [messages, mode, visibleStart],
  );
  const handlersRef = useRef({ onRegenerateLastResponse, onDeleteMessage, onIgnorePluginMessage, onTtsCacheKey, onOpenReviewInspector });
  handlersRef.current = { onRegenerateLastResponse, onDeleteMessage, onIgnorePluginMessage, onTtsCacheKey, onOpenReviewInspector };
  const deleteMessage = useCallback((messageId: string) => handlersRef.current.onDeleteMessage!(messageId), []);
  const ignorePluginMessage = useCallback((messageId: string) => handlersRef.current.onIgnorePluginMessage!(messageId), []);
  const reportTtsCacheKey = useCallback((messageId: string, cacheKey: string, converterVersion: string) => {
    handlersRef.current.onTtsCacheKey?.(messageId, cacheKey, converterVersion);
  }, []);
  const openReviewInspector = useCallback((runId: string, fileIndex: number) => {
    handlersRef.current.onOpenReviewInspector?.(runId, fileIndex);
  }, []);
  const canDeleteMessage = Boolean(onDeleteMessage);
  const canIgnorePluginMessage = Boolean(onIgnorePluginMessage);
  const canReportTtsCacheKey = Boolean(onTtsCacheKey);
  const canOpenReviewInspector = Boolean(onOpenReviewInspector);
  const latest = messages.at(-1);
  const coldRefreshId = latest?.role === "assistant" && !latest.loading && !latest.streaming ? latest.id : "";
  useEffect(() => {
    setColdRecalls({});
    if (mode !== "chat" || !conversationId || !window.memoryPanel?.getColdRecall) return;
    let cancelled = false;
    const load = async () => {
      try {
        const records = await window.memoryPanel.getColdRecall(conversationId);
        if (!cancelled) setColdRecalls(Object.fromEntries(records.map((record) => [record.messageId, record])));
      } catch { /* 插件未启用时不影响普通聊天。 */ }
    };
    void load();
    // 轮次落盘确认后，插件才收到最终消息 ID；补读一次避免与异步回执竞态。
    const retry = window.setTimeout(() => void load(), 900);
    const lateRetry = window.setTimeout(() => void load(), 3000);
    return () => { cancelled = true; window.clearTimeout(retry); window.clearTimeout(lateRetry); };
  }, [conversationId, mode, coldRefreshId]);
  const resolveColdRecall = useCallback(async (messageId: string, entryId: string, action: "related" | "unrelated" | "undo") => {
    if (!conversationId || !window.memoryPanel?.resolveColdRecall) throw new Error("归档记忆操作不可用");
    const updated = await window.memoryPanel.resolveColdRecall(conversationId, messageId, entryId, action);
    setColdRecalls((current) => ({ ...current, [messageId]: updated }));
  }, [conversationId]);
  const lastTurn = useMemo(() => resolveRevisableLastTurn(messages, mode), [messages, mode]);
  const onReasoningExpand = useCallback((id: string, expanded: boolean) => {
    setReasoningExpanded((current) => updateReasoningExpanded(current, id, expanded));
  }, []);
  const beginEdit = useCallback((messageId: string, content: string) => {
    setEditingMessageId(messageId);
    setEditDraft(content);
  }, []);
  const cancelEdit = useCallback(() => {
    if (revisionBusy) return;
    setEditingMessageId(null);
    setEditDraft("");
  }, [revisionBusy]);
  const submitEdit = useCallback(() => {
    if (!editingMessageId || !editDraft.trim() || !onEditLastUserMessage || revisionBusy) return;
    void onEditLastUserMessage(editingMessageId, editDraft.trim()).then((accepted) => {
      if (!accepted) return;
      setEditingMessageId(null);
      setEditDraft("");
    });
  }, [editDraft, editingMessageId, onEditLastUserMessage, revisionBusy]);
  const regenerate = useCallback(() => {
    const handler = handlersRef.current.onRegenerateLastResponse;
    if (!lastTurn || !handler || revisionBusy) return;
    void handler(lastTurn.userMessageId, lastTurn.assistantMessageId);
  }, [lastTurn, revisionBusy]);

  const containerRef = useRef<HTMLDivElement>(null);
  const isNearBottomRef = useRef(true);
  const pendingOlderAnchorRef = useRef<{ key: string; element: Element; top: number; scrollBox: HTMLDivElement } | null>(null);
  const loadOlderRef = useRef<() => void>(() => {});
  const getChatScrollBox = useCallback(
    () => containerRef.current?.querySelector<HTMLDivElement>(".ant-bubble-list-scroll-box") ?? null,
    [],
  );
  const getChatScrollContainer = useCallback(() => {
    const scrollBox = getChatScrollBox();
    if (scrollBox && scrollBox.scrollHeight > scrollBox.clientHeight + 1) {
      return { element: scrollBox, reversed: true };
    }
    return containerRef.current ? { element: containerRef.current, reversed: false } : null;
  }, [getChatScrollBox]);

  useEffect(() => {
    pendingOlderAnchorRef.current = null;
    setVisibleWindow(null);
  }, [windowKey]);

  loadOlderRef.current = () => {
    if (mode !== "chat" || visibleStart === 0 || pendingOlderAnchorRef.current) return;
    const scrollBox = getChatScrollContainer()?.element;
    const firstBubble = getChatScrollBox()?.querySelector(".ant-bubble-list-scroll-content")?.firstElementChild;
    if (!scrollBox || !firstBubble) return;
    const nextStart = Math.max(0, visibleStart - CHAT_OLDER_MESSAGE_BATCH);
    pendingOlderAnchorRef.current = {
      key: windowKey,
      element: firstBubble,
      top: firstBubble.getBoundingClientRect().top,
      scrollBox,
    };
    setVisibleWindow({ key: windowKey, firstMessageId: messages[nextStart].id });
  };

  useLayoutEffect(() => {
    const anchor = pendingOlderAnchorRef.current;
    if (!anchor || anchor.key !== windowKey) return;
    if (anchor.element.isConnected) {
      anchor.scrollBox.scrollTop += anchor.element.getBoundingClientRect().top - anchor.top;
    }
    pendingOlderAnchorRef.current = null;
  }, [visibleStart, windowKey]);

  const scrollToBottom = useCallback((behavior: ScrollBehavior = "smooth") => {
    const outer = containerRef.current;
    if (!outer) return;
    outer.scrollTo({ top: outer.scrollHeight, behavior });
    if (mode === "chat") getChatScrollBox()?.scrollTo({ top: 0, behavior });
  }, [getChatScrollBox, mode]);

  // 向父组件注册滚动到底部的回调
  useEffect(() => {
    onRegisterScrollToBottom?.(scrollToBottom);
  }, [onRegisterScrollToBottom, scrollToBottom]);

  const updateScrollState = useCallback(() => {
    const outer = containerRef.current;
    if (!outer) return;
    const scrollBox = mode === "chat" ? getChatScrollBox() : null;
    const outerDistance = outer.scrollHeight - outer.scrollTop - outer.clientHeight;
    const innerDistance = scrollBox && scrollBox.scrollHeight > scrollBox.clientHeight + 1
      ? Math.abs(scrollBox.scrollTop)
      : 0;
    const distance = Math.max(outerDistance, innerDistance);
    const nearBottom = distance < 100;
    isNearBottomRef.current = nearBottom;
    onScrollToBottomVisibilityChange?.(!nearBottom);
  }, [getChatScrollBox, mode, onScrollToBottomVisibilityChange]);

  // 打开/切换会话时滚动到底部
  useEffect(() => {
    scrollToBottom("auto");
    // 内容渲染后再次兜底滚动
    const timer = window.setTimeout(() => scrollToBottom("auto"), 100);
    isNearBottomRef.current = true;
    onScrollToBottomVisibilityChange?.(false);
    return () => window.clearTimeout(timer);
  }, [conversationId, onScrollToBottomVisibilityChange, scrollToBottom]);

  const roles = useMemo(
    () => createRoles(
      userAvatarUrl,
      conversationId,
      mode,
      preferredAddress,
      lastTurn,
      editingMessageId,
      editDraft,
      revisionBusy,
      beginEdit,
      setEditDraft,
      cancelEdit,
      submitEdit,
      regenerate,
      canDeleteMessage ? deleteMessage : undefined,
      reasoningExpanded,
      onReasoningExpand,
      canReportTtsCacheKey ? reportTtsCacheKey : undefined,
      canOpenReviewInspector ? openReviewInspector : undefined,
      canIgnorePluginMessage ? ignorePluginMessage : undefined,
      coldRecalls,
      resolveColdRecall,
    ),
    [beginEdit, cancelEdit, canDeleteMessage, canIgnorePluginMessage, canOpenReviewInspector, canReportTtsCacheKey, coldRecalls, conversationId, deleteMessage, editDraft, editingMessageId, ignorePluginMessage, lastTurn, mode, onReasoningExpand, openReviewInspector, preferredAddress, reasoningExpanded, regenerate, reportTtsCacheKey, resolveColdRecall, revisionBusy, submitEdit, userAvatarUrl],
  );

  useEffect(() => {
    if (editingMessageId && editingMessageId !== lastTurn?.userMessageId) {
      setEditingMessageId(null);
      setEditDraft("");
    }
  }, [editingMessageId, lastTurn?.userMessageId]);

  useEffect(() => stopTtsPlayback, [conversationId]);

  useEffect(() => {
    let active = true;
    void window.chat?.getEnabledStickers?.().then((stickers) => {
      if (active) setEnabledStickers(stickers);
    }).catch(() => {
      if (active) setEnabledStickers([]);
    });
    return () => {
      active = false;
    };
  }, []);

  const itemCacheRef = useRef<{
    mode: ConversationMode;
    segmentedOutputMode: SegmentedOutputMode;
    enabledStickers: EnabledSticker[];
    byMessage: WeakMap<ChatMessageItem, BubbleItemType[]>;
  } | null>(null);
  const items = useMemo(() => {
    let cache = itemCacheRef.current;
    if (!cache || cache.mode !== mode || cache.segmentedOutputMode !== segmentedOutputMode || cache.enabledStickers !== enabledStickers) {
      cache = { mode, segmentedOutputMode, enabledStickers, byMessage: new WeakMap() };
      itemCacheRef.current = cache;
    }
    return visibleMessages.flatMap((message) => {
      let parts = cache.byMessage.get(message);
      if (!parts) {
        parts = createMessageItemsForMessage(message, enabledStickers, mode, segmentedOutputMode);
        cache.byMessage.set(message, parts);
      }
      return parts;
    });
  }, [visibleMessages, enabledStickers, mode, segmentedOutputMode]);
  const channelConversationLabel = useMemo(() => resolveChannelConversationLabel(messages), [messages]);
  const bubbleList = useMemo(
    () => <Bubble.List items={items} role={roles} autoScroll onScroll={mode === "chat" ? updateScrollState : undefined} />,
    [items, mode, roles, updateScrollState],
  );

  const firstVisibleMessageId = visibleMessages[0]?.id;
  useEffect(() => {
    if (mode !== "chat" || visibleStart === 0 || !firstVisibleMessageId || typeof IntersectionObserver === "undefined") return;
    const scrollContainer = getChatScrollContainer();
    const firstBubble = getChatScrollBox()?.querySelector(".ant-bubble-list-scroll-content")?.firstElementChild;
    if (!scrollContainer || !firstBubble) return;
    const observer = new IntersectionObserver(([entry]) => {
      const { element, reversed } = scrollContainer;
      const distanceToTop = reversed
        ? element.scrollHeight - element.clientHeight + element.scrollTop
        : element.scrollTop;
      if (entry?.isIntersecting && distanceToTop < 160) loadOlderRef.current();
    }, { root: scrollContainer.element, rootMargin: "80px 0px 0px 0px" });
    observer.observe(firstBubble);
    return () => observer.disconnect();
  }, [firstVisibleMessageId, getChatScrollBox, getChatScrollContainer, mode, visibleStart]);

  return (
    <div
      ref={containerRef}
      className={`cy-message-list cy-message-list--stickers-${stickerSize}`}
      aria-live="polite"
      onScroll={updateScrollState}
    >
      {channelConversationLabel && (
        <div className="cy-message-list__channel-context" role="note" aria-label={channelConversationLabel}>
          <span className="cy-message-list__channel-dot" aria-hidden="true" />
          <span>{channelConversationLabel}</span>
        </div>
      )}
      {bubbleList}
    </div>
  );
}
