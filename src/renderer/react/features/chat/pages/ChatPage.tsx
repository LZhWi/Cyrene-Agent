import { useEffect, useRef, useState, type DragEvent } from "react";
import { ChatComposer, type ComposerAttachment } from "../components/ChatComposer";
import { ChatMessageList, type ChatMessageItem } from "../components/ChatMessageList";
import { getTtsPlaybackSnapshot, playTtsToCompletion, stopTtsPlayback } from "../components/tts-playback";
import { EarlyTtsPlaybackQueue } from "../tts/early-tts-queue";
import { ConversationSidebar } from "../components/ConversationSidebar";
import type { ChatMessage, ChatSession, ChatSessionMeta, ConversationMode, ToolExecutionRecord } from "../../../../../shared/chat-types";
import { SidebarToggle } from "../../../components/ui/SidebarToggle";
import { ModeSwitch } from "../../../components/ui/ModeSwitch";
import { CharacterStatusPill } from "../../../components/ui/CharacterStatusPill";
import { WindowControls } from "../../../components/ui/WindowControls";
import { SettingsButton } from "../../../components/ui/SettingsButton";
import { UserAvatar } from "../../../components/ui/UserAvatar";
import { useUserCallPreference } from "../../../hooks/useUserNickname";
import { resolveRevisableLastTurn } from "../components/last-turn-actions";
import { NewTaskButton } from "../../../components/ui/NewTaskButton";
import "../../../components/ui/SidebarToggle.css";
import "../../../components/ui/ModeSwitch.css";
import "../../../components/ui/CharacterStatusPill.css";
import "../../../components/ui/WindowControls.css";
import "../../../components/ui/SettingsButton.css";
import "../../../components/ui/UserAvatar.css";
import "../../../components/ui/NewTaskButton.css";
import "../components/ChatComposer.css";
import "../components/ReasoningControl.css";
import "../components/StyleControl.css";
import "../components/PermissionControl.css";
import "../components/ChatMessageList.css";
import "../components/ConversationSidebar.css";

import avatarLight from "../../../assets/avatars/avatar-light.png";

const CONVERSATION_MODES: readonly ConversationMode[] = ["chat", "work", "code", "learn", "daily"];

function isConversationMode(value: string): value is ConversationMode {
  return CONVERSATION_MODES.includes(value as ConversationMode);
}

const DEMO_RESPONSES: Readonly<Record<string, string>> = {
  "1": "收到啦♪ 这是一条普通会话消息。今天也一起把界面慢慢打磨得更舒服吧。",
  "2": [
    "## Markdown 渲染测试",
    "",
    "这是一段包含 **粗体**、*斜体* 和 `行内代码` 的内容。",
    "",
    "- 第一项：消息列表使用 Bubble",
    "- 第二项：正文使用 XMarkdown",
    "- 第三项：样式仍由昔涟主题控制",
    "",
    "> 这是一段引用，用来观察间距、颜色和左侧边线。",
    "",
    "| 功能 | 状态 |",
    "| --- | --- |",
    "| Markdown | 正常 |",
    "| 表格 | 正常 |",
  ].join("\n"),
  "3": String.raw`数学公式测试开始♪

行内公式：$E = mc^2$

块级公式：

$$
\int_{-\infty}^{\infty} e^{-x^2}\,dx = \sqrt{\pi}
$$

再来一个二次方程：

$$
x = \frac{-b \pm \sqrt{b^2 - 4ac}}{2a}
$$`,
  "4": [
    "下面是一段 TypeScript 代码，用来测试语法高亮和复制功能：",
    "",
    "```ts",
    "type CyreneMode = \"work\" | \"chat\" | \"code\" | \"learn\" | \"daily\";",
    "",
    "function greeting(mode: CyreneMode): string {",
    "  return mode === \"chat\"",
    "    ? \"昔涟期待和你一起聊天♪\"",
    "    : `当前模式：${mode}`;",
    "}",
    "",
    "console.log(greeting(\"chat\"));",
    "```",
  ].join("\n"),
};

const DEMO_STICKERS: Readonly<Record<string, string>> = {
  "5": "playful",
};

interface ChatStoreApi {
  list: (options?: { mode?: ConversationMode }) => Promise<ChatSessionMeta[]>;
  get: (id: string) => Promise<ChatSession | null>;
  create: (input: { identityId: null; mode: ConversationMode; title?: string }) => Promise<ChatSession>;
  append: (id: string, message: ChatMessage) => Promise<ChatSession | null>;
  replaceTail: (id: string, startIndex: number, messages: ChatMessage[]) => Promise<ChatSession | null>;
  setMessageTtsCacheKey: (id: string, messageId: string, cacheKey: string, converterVersion: string) => Promise<ChatSession | null>;
  delete: (id: string) => Promise<boolean>;
  pickWorkspaceFolder: () => Promise<{ ok: boolean; path?: string; displayName?: string; error?: string }>;
  setWorkspace: (sessionId: string, workspaceRoot: string) => Promise<{ ok: boolean; error?: string }>;
  openWorkspace: (workspaceRoot: string) => Promise<{ ok: boolean; error?: string }>;
  setActiveSession: (sessionId: string | null) => Promise<unknown>;
  onChanged: (callback: () => void) => () => void;
}

interface SidebarApi {
  openSettings: (section?: string) => void;
}

interface AguiEvent {
  type?: string;
  delta?: string;
  message?: string;
  error?: string;
  content?: string;
  name?: string;
  value?: unknown;
  toolCallId?: string;
  toolCallName?: string;
  status?: string;
}

interface AguiApi {
  run: (input: {
    messages: Array<{ role: "user" | "model"; content: string; at?: number }>;
    userTurnId: string;
    assistantTurnId: string;
    styleId?: string;
    sessionId: string;
    imageAttachments?: Array<{ name: string; filePath: string; mime?: string }>;
  }) => Promise<{ success: boolean; error?: string }>;
  onEvent: (callback: (event: AguiEvent) => void) => () => void;
}

interface PublicModelConfig {
  model?: unknown;
  stickerSize?: "small" | "standard" | "large";
}

interface ModelConfigApi {
  get: () => Promise<PublicModelConfig>;
  onChanged: (callback: (config: PublicModelConfig) => void) => () => void;
}

function chatStore(): ChatStoreApi | undefined {
  return (window as typeof window & { chatStore?: ChatStoreApi }).chatStore;
}

function sidebarApi(): SidebarApi | undefined {
  return (window as typeof window & { sidebar?: SidebarApi }).sidebar;
}

function aguiApi(): AguiApi | undefined {
  return (window as typeof window & { agui?: AguiApi }).agui;
}

function toUiMessages(session: ChatSession): ChatMessageItem[] {
  return session.messages.map((message) => ({
    id: message.id,
    role: message.role === "model" ? "assistant" : "user",
    content: message.content,
    reasoning: message.reasoning,
    ttsCacheKey: message.ttsCacheKey,
    ttsCacheVersion: message.ttsCacheVersion,
    responseStarted: message.role === "model",
    sticker: message.sticker,
    toolExecutions: message.toolExecutions,
    attachments: message.attachments,
  }));
}

export function ChatPage() {
  const preferredAddress = useUserCallPreference();
  const [collapsed, setCollapsed] = useState(false);
  const [mode, setMode] = useState<ConversationMode>("chat");
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [messagesByMode, setMessagesByMode] = useState<Partial<Record<ConversationMode, ChatMessageItem[]>>>({});
  const [workspaceNames, setWorkspaceNames] = useState<Partial<Record<ConversationMode, string>>>({});
  const [attachmentsByScope, setAttachmentsByScope] = useState<Record<string, ComposerAttachment[]>>({});
  const [sessionsByMode, setSessionsByMode] = useState<Partial<Record<ConversationMode, ChatSessionMeta[]>>>({});
  const [activeSessionIds, setActiveSessionIds] = useState<Partial<Record<ConversationMode, string>>>({});
  const [attachmentBusy, setAttachmentBusy] = useState(false);
  const [modelBusy, setModelBusy] = useState(false);
  const [lastTurnRevisionStarting, setLastTurnRevisionStarting] = useState(false);
  const [modelName, setModelName] = useState("模型未连接");
  const [stickerSize, setStickerSize] = useState<"small" | "standard" | "large">("standard");
  const [isDraggingFiles, setIsDraggingFiles] = useState(false);
  const activeModeRef = useRef(mode);
  const activeSessionIdsRef = useRef(activeSessionIds);
  const activeScopeRef = useRef(`mode:${mode}`);
  const sessionSelectionGeneration = useRef(0);
  const dragDepthRef = useRef(0);
  const localPreviewUrlsRef = useRef(new Set<string>());
  const demoTimers = useRef(new Set<number>());

  useEffect(() => {
    const modelConfig = (window as typeof window & { modelConfig?: ModelConfigApi }).modelConfig;
    if (!modelConfig) return;
    let active = true;
    const apply = (config: PublicModelConfig) => {
      if (!active) return;
      setModelName(typeof config.model === "string" && config.model.trim() ? config.model.trim() : "模型未连接");
      setStickerSize(config.stickerSize === "small" || config.stickerSize === "large" ? config.stickerSize : "standard");
    };
    void modelConfig.get().then(apply).catch(() => {
      if (active) setModelName("模型未连接");
    });
    const off = modelConfig.onChanged(apply);
    return () => {
      active = false;
      off();
    };
  }, []);
  const modelBusyRef = useRef(false);
  const lastTurnRevisionStartingRef = useRef(false);
  const activeAguiOffRef = useRef<(() => void) | null>(null);
  const activeEarlyTtsRef = useRef<{
    queue: EarlyTtsPlaybackQueue;
    mode: ConversationMode;
    sessionId: string;
    messageId: string;
  } | null>(null);

  const taskLabel = ["work", "daily", "code"].includes(mode) ? "新建任务" : "新建对话";
  const activeSessionId = activeSessionIds[mode];
  const scopeKey = activeSessionId ?? `mode:${mode}`;
  const draft = drafts[scopeKey] ?? "";
  const messages = messagesByMode[mode] ?? [];
  const hasMessages = messages.length > 0;
  const attachments = attachmentsByScope[scopeKey] ?? [];
  const sessions = sessionsByMode[mode] ?? [];

  activeModeRef.current = mode;
  activeSessionIdsRef.current = activeSessionIds;
  activeScopeRef.current = scopeKey;

  useEffect(() => () => {
    for (const timer of demoTimers.current) {
      window.clearTimeout(timer);
      window.clearInterval(timer);
    }
    demoTimers.current.clear();
    activeAguiOffRef.current?.();
    activeAguiOffRef.current = null;
    activeEarlyTtsRef.current?.queue.cancel();
    activeEarlyTtsRef.current = null;
    for (const url of localPreviewUrlsRef.current) URL.revokeObjectURL(url);
    localPreviewUrlsRef.current.clear();
  }, []);

  useEffect(() => window.chat?.onScreenshotInsert?.((data) => {
    const targetScope = activeScopeRef.current;
    const attachment: ComposerAttachment = {
      kind: "image",
      name: `截图_${Date.now()}.png`,
      filePath: data.filePath,
      mime: data.mime,
      previewUrl: data.previewUrl,
      hasAnnotations: data.hasAnnotations,
    };
    setAttachmentsByScope((current) => ({
      ...current,
      [targetScope]: [...(current[targetScope] ?? []), attachment],
    }));
  }), []);

  useEffect(() => {
    const store = chatStore();
    if (!store) return;
    const refresh = () => void refreshSessions(activeModeRef.current, true);
    const off = store.onChanged(refresh);
    return off;
  }, []);

  useEffect(() => {
    void refreshSessions(mode, true);
  }, [mode]);

  useEffect(() => {
    const active = activeEarlyTtsRef.current;
    if (active && (active.mode !== mode || active.sessionId !== activeSessionId)) {
      active.queue.cancel();
      activeEarlyTtsRef.current = null;
    }
  }, [activeSessionId, mode]);

  function updateMessage(targetMode: ConversationMode, id: string, patch: Partial<ChatMessageItem>) {
    setMessagesByMode((current) => ({
      ...current,
      [targetMode]: (current[targetMode] ?? []).map((item) => (
        item.id === id ? { ...item, ...patch } : item
      )),
    }));
  }

  function handleTtsCacheKey(
    targetMode: ConversationMode,
    sessionId: string,
    messageId: string,
    cacheKey: string,
    converterVersion: string,
  ) {
    updateMessage(targetMode, messageId, { ttsCacheKey: cacheKey, ttsCacheVersion: converterVersion });
    void chatStore()?.setMessageTtsCacheKey(sessionId, messageId, cacheKey, converterVersion);
  }

  function createEarlyTtsQueue(
    targetMode: ConversationMode,
    sessionId: string,
    messageId: string,
  ): EarlyTtsPlaybackQueue {
    activeEarlyTtsRef.current?.queue.cancel();
    const queue = new EarlyTtsPlaybackQueue(
      async (segment) => {
        if (
          activeModeRef.current !== targetMode
          || activeSessionIdsRef.current[targetMode] !== sessionId
          || activeEarlyTtsRef.current?.queue !== queue
        ) return "interrupted";
        return await playTtsToCompletion({
          conversationId: sessionId,
          messageId,
          text: segment,
          speechMode: targetMode === "learn" ? "learn" : "default",
          preferredAddress,
          automatic: true,
        });
      },
      stopTtsPlayback,
    );
    activeEarlyTtsRef.current = { queue, mode: targetMode, sessionId, messageId };
    return queue;
  }

  function finishEarlyTtsQueue(queue: EarlyTtsPlaybackQueue, fullText: string): void {
    void queue.finish(fullText).finally(() => {
      const active = activeEarlyTtsRef.current;
      if (active?.queue !== queue) return;
      const playback = getTtsPlaybackSnapshot();
      if (playback.messageId === active.messageId && playback.status === "completed") stopTtsPlayback();
      activeEarlyTtsRef.current = null;
    });
  }

  async function selectSession(sessionId: string, targetMode: ConversationMode = mode) {
    const store = chatStore();
    if (!store) return;
    const generation = ++sessionSelectionGeneration.current;
    const session = await store.get(sessionId);
    if (!session || generation !== sessionSelectionGeneration.current) return;
    setActiveSessionIds((current) => {
      const next = { ...current, [targetMode]: sessionId };
      activeSessionIdsRef.current = next;
      return next;
    });
    setMessagesByMode((current) => ({ ...current, [targetMode]: toUiMessages(session) }));
    setWorkspaceNames((current) => ({
      ...current,
      [targetMode]: session.workspaceBinding?.displayName,
    }));
    if (targetMode === activeModeRef.current) void store.setActiveSession(sessionId);
  }

  async function refreshSessions(targetMode: ConversationMode, selectCurrent: boolean) {
    const store = chatStore();
    if (!store) return;
    const listed = await store.list({ mode: targetMode });
    setSessionsByMode((current) => ({ ...current, [targetMode]: listed }));
    if (!selectCurrent) return;
    const currentId = activeSessionIdsRef.current[targetMode];
    const nextId = listed.some((session) => session.id === currentId) ? currentId : listed[0]?.id;
    if (nextId) {
      await selectSession(nextId, targetMode);
      return;
    }
    setActiveSessionIds((current) => {
      const next = { ...current };
      delete next[targetMode];
      activeSessionIdsRef.current = next;
      return next;
    });
    setMessagesByMode((current) => ({ ...current, [targetMode]: [] }));
    setWorkspaceNames((current) => ({ ...current, [targetMode]: undefined }));
    if (targetMode === activeModeRef.current) void store.setActiveSession(null);
  }

  function streamDemoResponse(targetMode: ConversationMode, id: string, response: string, sessionId?: string) {
    const earlyTtsQueue = sessionId ? createEarlyTtsQueue(targetMode, sessionId, id) : null;
    const loadingTimer = window.setTimeout(() => {
      demoTimers.current.delete(loadingTimer);
      updateMessage(targetMode, id, { loading: false, streaming: true, responseStarted: true });

      const characters = Array.from(response);
      const chunkSize = Math.max(1, Math.min(4, Math.ceil(characters.length / 120)));
      let cursor = 0;
      let spokenCursor = 0;
      const streamTimer = window.setInterval(() => {
        cursor = Math.min(characters.length, cursor + chunkSize);
        const finished = cursor >= characters.length;
        earlyTtsQueue?.append(characters.slice(spokenCursor, cursor).join(""));
        spokenCursor = cursor;
        updateMessage(targetMode, id, {
          content: characters.slice(0, cursor).join(""),
          streaming: !finished,
        });
        if (finished) {
          window.clearInterval(streamTimer);
          demoTimers.current.delete(streamTimer);
          if (sessionId) {
            void chatStore()?.append(sessionId, {
              id,
              role: "model",
              content: response,
              at: Date.now(),
            }).then((saved) => {
              void refreshSessions(targetMode, false);
              if (saved) finishEarlyTtsQueue(earlyTtsQueue!, response);
              else earlyTtsQueue?.cancel();
            });
          } else {
            earlyTtsQueue?.cancel();
          }
        }
      }, 30);
      demoTimers.current.add(streamTimer);
    }, 450);
    demoTimers.current.add(loadingTimer);
  }

  async function runModel(input: {
    targetMode: "chat" | "work" | "daily";
    sessionId: string;
    userMessageId: string;
    assistantId: string;
    session: ChatSession;
    attachments: ComposerAttachment[];
  }) {
    const api = aguiApi();
    const store = chatStore();
    if (!api || !store) {
      const visibleError = "模型请求失败：AG-UI 模型服务尚未就绪";
      updateMessage(input.targetMode, input.assistantId, {
        content: visibleError,
        loading: false,
        waitingForFirstEvent: false,
        streaming: false,
        responseStarted: true,
      });
      await store?.append(input.sessionId, {
        id: input.assistantId,
        role: "model",
        content: visibleError,
        at: Date.now(),
      });
      return;
    }

    modelBusyRef.current = true;
    setModelBusy(true);
    const earlyTtsQueue = createEarlyTtsQueue(input.targetMode, input.sessionId, input.assistantId);
    let streamContent = "";
    let reasoningContent = "";
    let sticker: string | null = null;
    let toolExecutions: ToolExecutionRecord[] = [];
    let runStarted = false;
    let resolveTerminal!: (error?: Error) => void;
    const terminal = new Promise<Error | undefined>((resolve) => {
      resolveTerminal = resolve;
    });
    const updateRunTool = (toolId: string, patch: Partial<ToolExecutionRecord>) => {
      const index = toolExecutions.findIndex((tool) => tool.id === toolId);
      toolExecutions = index === -1
        ? [...toolExecutions, { id: toolId, name: patch.name ?? "工具调用", status: patch.status ?? "running", result: patch.result }]
        : toolExecutions.map((tool, toolIndex) => toolIndex === index ? { ...tool, ...patch } : tool);
      updateMessage(input.targetMode, input.assistantId, { toolExecutions });
    };
    const markFirstResponse = () => {
      updateMessage(input.targetMode, input.assistantId, { waitingForFirstEvent: false });
    };

    const off = api.onEvent((event) => {
      if (event.type === "RUN_STARTED") {
        runStarted = true;
        return;
      }
      if (!runStarted) return;
      if (
        event.type === "REASONING_MESSAGE_START"
        || event.type === "REASONING_MESSAGE_CONTENT"
        || event.type === "REASONING_MESSAGE_END"
        || event.type === "TOOL_CALL_START"
        || event.type === "TOOL_CALL_RESULT"
        || event.type === "TOOL_CALL_END"
        || event.type === "TEXT_MESSAGE_START"
        || event.type === "TEXT_MESSAGE_CONTENT"
        || event.type === "TEXT_MESSAGE_END"
        || event.type === "CUSTOM"
      ) markFirstResponse();
      if (event.type === "REASONING_MESSAGE_START") {
        updateMessage(input.targetMode, input.assistantId, {
          loading: false,
          reasoningStreaming: true,
        });
      } else if (event.type === "REASONING_MESSAGE_CONTENT" && event.delta) {
        reasoningContent += event.delta;
        updateMessage(input.targetMode, input.assistantId, {
          reasoning: reasoningContent,
          loading: false,
          reasoningStreaming: true,
        });
      } else if (event.type === "REASONING_MESSAGE_END") {
        updateMessage(input.targetMode, input.assistantId, { reasoningStreaming: false, loading: false });
        } else if (event.type === "TOOL_CALL_START" && event.toolCallId) {
          updateRunTool(event.toolCallId, {
            name: event.toolCallName ?? "工具调用",
            status: "running",
          });
        } else if (event.type === "TOOL_CALL_RESULT" && event.toolCallId) {
        updateRunTool(event.toolCallId, {
          status: event.status === "failed" ? "error" : "success",
          result: (event.content ?? "").slice(0, 4000),
        });
      } else if (event.type === "TOOL_CALL_END" && event.toolCallId) {
        updateRunTool(event.toolCallId, {});
      } else if (event.type === "TEXT_MESSAGE_START") {
        updateMessage(input.targetMode, input.assistantId, {
          loading: false,
          reasoningStreaming: false,
          responseStarted: true,
          streaming: true,
        });
      } else if (event.type === "TEXT_MESSAGE_CONTENT" && event.delta) {
        streamContent += event.delta;
        earlyTtsQueue.append(event.delta);
        updateMessage(input.targetMode, input.assistantId, {
          content: streamContent,
          loading: false,
          streaming: true,
          responseStarted: true,
        });
      } else if (event.type === "TEXT_MESSAGE_END") {
        updateMessage(input.targetMode, input.assistantId, { streaming: false });
      } else if (event.type === "CUSTOM" && event.name === "cyrene.sticker") {
        sticker = typeof event.value === "string" ? event.value : null;
        updateMessage(input.targetMode, input.assistantId, { sticker });
      } else if (event.type === "RUN_FINISHED") {
        resolveTerminal();
      } else if (event.type === "RUN_ERROR") {
        resolveTerminal(new Error(event.message ?? event.error ?? event.content ?? "模型请求失败"));
      }
    });
    activeAguiOffRef.current?.();
    activeAguiOffRef.current = off;

    try {
      const general = await window.chat?.getGeneralSettings?.();
      const ack = await api.run({
        messages: input.session.messages.slice(-16).map((item) => ({
          role: item.role,
          content: item.content,
          at: item.at,
        })),
        userTurnId: input.userMessageId,
        assistantTurnId: input.assistantId,
        styleId: general?.currentStyleId,
        sessionId: input.sessionId,
        imageAttachments: input.attachments
          .filter((attachment) => attachment.kind === "image" && attachment.filePath)
          .map((attachment) => ({
            name: attachment.name,
            filePath: attachment.filePath!,
            mime: attachment.mime,
          })),
      });
      if (!ack.success) throw new Error(ack.error ?? "模型请求发起失败");
      const terminalError = await terminal;
      if (terminalError) throw terminalError;

      const finalContent = streamContent.trim() ? streamContent : "任务已完成。";
      updateMessage(input.targetMode, input.assistantId, {
        content: finalContent,
        loading: false,
        waitingForFirstEvent: false,
        streaming: false,
        reasoning: reasoningContent || undefined,
        reasoningStreaming: false,
        responseStarted: true,
        sticker,
        toolExecutions,
      });
      const savedAssistant = await store.append(input.sessionId, {
        id: input.assistantId,
        role: "model",
        content: finalContent,
        reasoning: reasoningContent || undefined,
        at: Date.now(),
        sticker,
        toolExecutions,
      });
      if (savedAssistant) {
        finishEarlyTtsQueue(earlyTtsQueue, finalContent);
      } else earlyTtsQueue.cancel();
    } catch (error) {
      earlyTtsQueue.cancel();
      const errorMessage = error instanceof Error ? error.message : String(error);
      const visibleError = `模型请求失败：${errorMessage}`;
      updateMessage(input.targetMode, input.assistantId, {
        content: visibleError,
        loading: false,
        waitingForFirstEvent: false,
        streaming: false,
        reasoningStreaming: false,
        responseStarted: true,
      });
      await store.append(input.sessionId, {
        id: input.assistantId,
        role: "model",
        content: visibleError,
        at: Date.now(),
      });
    } finally {
      off();
      if (activeAguiOffRef.current === off) activeAguiOffRef.current = null;
      modelBusyRef.current = false;
      setModelBusy(false);
      void refreshSessions(input.targetMode, false);
    }
  }

  async function restartLastChatTurn(
    expectedUserMessageId: string,
    expectedAssistantMessageId: string,
    editedContent?: string,
  ): Promise<boolean> {
    if (
      activeModeRef.current !== "chat"
      || modelBusyRef.current
      || lastTurnRevisionStartingRef.current
    ) return false;
    const store = chatStore();
    const sessionId = activeSessionIdsRef.current.chat;
    if (!store || !sessionId) return false;
    lastTurnRevisionStartingRef.current = true;
    setLastTurnRevisionStarting(true);
    try {
      const session = await store.get(sessionId);
      if (!session || session.mode !== "chat") return false;
      const lastTurn = resolveRevisableLastTurn(session.messages, "chat");
      if (
        !lastTurn
        || lastTurn.userMessageId !== expectedUserMessageId
        || lastTurn.assistantMessageId !== expectedAssistantMessageId
      ) return false;

      const nextContent = editedContent === undefined ? undefined : editedContent.trim();
      if (editedContent !== undefined && !nextContent) return false;
      const userIndex = session.messages.length - 2;
      const previousUserMessage = session.messages[userIndex];
      const nextUserMessage: ChatMessage = nextContent === undefined
        ? previousUserMessage
        : {
            ...previousUserMessage,
            content: nextContent,
            at: Date.now(),
          };
      const truncatedSession = await store.replaceTail(sessionId, userIndex, [nextUserMessage]);
      if (!truncatedSession) return false;

      activeEarlyTtsRef.current?.queue.cancel();
      activeEarlyTtsRef.current = null;
      stopTtsPlayback();
      const assistantId = crypto.randomUUID();
      setMessagesByMode((current) => ({
        ...current,
        chat: [
          ...toUiMessages(truncatedSession),
          {
            id: assistantId,
            role: "assistant",
            content: "",
            loading: true,
            waitingForFirstEvent: true,
            streaming: false,
            responseStarted: false,
          },
        ],
      }));
      void runModel({
        targetMode: "chat",
        sessionId,
        userMessageId: nextUserMessage.id,
        assistantId,
        session: truncatedSession,
        attachments: (nextUserMessage.attachments ?? []).map((attachment) => ({ ...attachment })),
      });
      return true;
    } catch (error) {
      console.error("[Cyrene React] 重建最后一轮对话失败:", error);
      return false;
    } finally {
      lastTurnRevisionStartingRef.current = false;
      setLastTurnRevisionStarting(false);
    }
  }

  async function editLastChatUserMessage(messageId: string, content: string): Promise<boolean> {
    const lastTurn = resolveRevisableLastTurn(messagesByMode.chat ?? [], "chat");
    if (!lastTurn || lastTurn.userMessageId !== messageId) return false;
    return restartLastChatTurn(lastTurn.userMessageId, lastTurn.assistantMessageId, content);
  }

  async function regenerateLastChatResponse(
    userMessageId: string,
    assistantMessageId: string,
  ): Promise<boolean> {
    return restartLastChatTurn(userMessageId, assistantMessageId);
  }

  async function ensureSession(targetMode: ConversationMode): Promise<string> {
    const existing = activeSessionIdsRef.current[targetMode];
    if (existing) return existing;
    const store = chatStore();
    if (!store) throw new Error("聊天会话服务尚未就绪");
    const session = await store.create({
      identityId: null,
      mode: targetMode,
      title: targetMode === "work" || targetMode === "code" || targetMode === "daily" ? "新任务" : "新对话",
    });
    await refreshSessions(targetMode, false);
    await selectSession(session.id, targetMode);
    return session.id;
  }

  async function chooseWorkspace() {
    const targetMode = mode;
    if (targetMode === "chat" || targetMode === "learn") return;
    const store = chatStore();
    if (!store) return;
    const picked = await store.pickWorkspaceFolder();
    if (!picked.ok || !picked.path) return;
    const sessionId = await ensureSession(targetMode);
    const result = await store.setWorkspace(sessionId, picked.path);
    if (!result.ok) {
      window.alert(`设置工作区失败：${result.error ?? "未知错误"}`);
      return;
    }
    setWorkspaceNames((current) => ({ ...current, [targetMode]: picked.displayName ?? "工作文件夹" }));
    await refreshSessions(targetMode, false);
  }

  async function createNewTask() {
    const targetMode = mode;
    const store = chatStore();
    if (!store) return;
    let workspace: { path: string; displayName?: string } | undefined;
    if (targetMode === "work" || targetMode === "code" || targetMode === "daily") {
      const picked = await store.pickWorkspaceFolder();
      if (!picked.ok || !picked.path) return;
      workspace = { path: picked.path, displayName: picked.displayName };
    }
    const session = await store.create({
      identityId: null,
      mode: targetMode,
      title: workspace ? "新任务" : "新对话",
    });
    if (workspace) {
      const result = await store.setWorkspace(session.id, workspace.path);
      if (!result.ok) {
        await store.delete(session.id);
        window.alert(`设置工作区失败：${result.error ?? "未知错误"}`);
        return;
      }
    }
    await refreshSessions(targetMode, false);
    await selectSession(session.id, targetMode);
  }

  async function chooseFiles(files: File[]) {
    const targetScope = scopeKey;
    if (!window.chat || files.length === 0) return;
    setAttachmentBusy(true);
    const previewsByName = new Map<string, string[]>();
    for (const file of files) {
      if (!file.type.startsWith("image/") && !/\.(png|jpe?g|webp|gif|bmp)$/i.test(file.name)) continue;
      const previewUrl = URL.createObjectURL(file);
      localPreviewUrlsRef.current.add(previewUrl);
      previewsByName.set(file.name, [...(previewsByName.get(file.name) ?? []), previewUrl]);
    }
    try {
      const results = await window.chat.ingestDroppedFiles(files);
      if (results.length > 0) {
        const hydratedResults = results.map((attachment) => {
          if (attachment.kind !== "image") return attachment;
          const previews = previewsByName.get(attachment.name);
          const localPreview = previews?.shift();
          return localPreview ? { ...attachment, previewUrl: localPreview } : attachment;
        });
        setAttachmentsByScope((current) => ({
          ...current,
          [targetScope]: [...(current[targetScope] ?? []), ...hydratedResults],
        }));
      }
    } catch (error) {
      window.alert(`文件摄入失败：${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setAttachmentBusy(false);
    }
  }

  function updateMessageAttachments(
    targetMode: ConversationMode,
    messageId: string,
    updater: (attachments: ComposerAttachment[]) => ComposerAttachment[],
  ) {
    setMessagesByMode((current) => ({
      ...current,
      [targetMode]: (current[targetMode] ?? []).map((item) => (
        item.id === messageId
          ? { ...item, attachments: updater(item.attachments ?? []) }
          : item
      )),
    }));
  }

  async function prepareImageAttachments(
    targetMode: ConversationMode,
    messageId: string,
    attachments: ComposerAttachment[],
  ) {
    const images = attachments.filter((attachment) => attachment.kind === "image" && attachment.filePath);
    if (images.length === 0 || !window.chat) return;

    let strategy: { mode: "direct" | "caption" } = { mode: "caption" };
    try {
      strategy = await window.chat.getImageSendStrategy();
    } catch (error) {
      console.warn("[Cyrene React] 获取图片发送策略失败，回退视觉描述:", error);
    }

    if (strategy.mode === "direct") {
      const paths = new Set(images.map((image) => image.filePath));
      updateMessageAttachments(targetMode, messageId, (current) => current.map((attachment) => (
        paths.has(attachment.filePath)
          ? { ...attachment, imageSendMode: "direct", status: "done" }
          : attachment
      )));
      return;
    }

    for (const image of images) {
      updateMessageAttachments(targetMode, messageId, (current) => current.map((attachment) => (
        attachment.filePath === image.filePath
          ? { ...attachment, imageSendMode: "caption", status: "processing" }
          : attachment
      )));
      let result: { ok: boolean; caption?: string; error?: string };
      try {
        result = await window.chat.captionImage(image.filePath!, image.hasAnnotations === true);
      } catch (error) {
        result = { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
      updateMessageAttachments(targetMode, messageId, (current) => current.map((attachment) => (
        attachment.filePath === image.filePath
          ? result.ok && result.caption
            ? { ...attachment, imageSendMode: "caption", status: "done", caption: result.caption, reason: undefined }
            : { ...attachment, imageSendMode: "caption", status: "error", reason: result.error ?? "图片分析失败" }
          : attachment
      )));
    }
  }

  function removeAttachment(index: number) {
    const targetScope = scopeKey;
    setAttachmentsByScope((current) => ({
      ...current,
      [targetScope]: (current[targetScope] ?? []).filter((_, itemIndex) => itemIndex !== index),
    }));
  }

  function containsFiles(dataTransfer: DataTransfer): boolean {
    return Array.from(dataTransfer.types).includes("Files");
  }

  function handleDragEnter(event: DragEvent<HTMLElement>) {
    if (!containsFiles(event.dataTransfer)) return;
    event.preventDefault();
    dragDepthRef.current += 1;
    setIsDraggingFiles(true);
  }

  function handleDragOver(event: DragEvent<HTMLElement>) {
    if (!containsFiles(event.dataTransfer)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
  }

  function handleDragLeave(event: DragEvent<HTMLElement>) {
    if (!containsFiles(event.dataTransfer)) return;
    event.preventDefault();
    dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
    if (dragDepthRef.current === 0) setIsDraggingFiles(false);
  }

  function handleDrop(event: DragEvent<HTMLElement>) {
    if (!containsFiles(event.dataTransfer)) return;
    event.preventDefault();
    dragDepthRef.current = 0;
    setIsDraggingFiles(false);
    const files = Array.from(event.dataTransfer.files);
    if (files.length > 0) void chooseFiles(files);
  }

  async function sendMessage(content: string) {
    const message = content.trim();
    if (!message) return;
    activeEarlyTtsRef.current?.queue.cancel();
    activeEarlyTtsRef.current = null;
    const stickerMatch = message.match(/\[sticker:([^\]]+)\]/);
    const userSticker = stickerMatch?.[1];
    const visibleMessage = message.replace(/\[sticker:[^\]]+\]/g, "").trim();
    const demoResponse = DEMO_RESPONSES[message];
    const demoSticker = DEMO_STICKERS[message];
    const shouldRunModel = (mode === "chat" || mode === "work" || mode === "daily") && !demoResponse && !demoSticker;
    if (shouldRunModel && modelBusyRef.current) return;
    const assistantId = demoResponse || demoSticker || shouldRunModel ? crypto.randomUUID() : undefined;
    const userMessageId = crypto.randomUUID();
    const attachmentsForMessage = attachments.map((attachment) => ({ ...attachment }));
    const targetMode = mode;
    const sessionId = await ensureSession(targetMode);
    setMessagesByMode((current) => ({
      ...current,
      [targetMode]: [
        ...(current[targetMode] ?? []),
        {
          id: userMessageId,
          role: "user",
          content: visibleMessage,
          sticker: userSticker,
          attachments: attachmentsForMessage.length > 0 ? attachmentsForMessage : undefined,
        },
        ...(assistantId ? [{
          id: assistantId!,
          role: "assistant" as const,
          content: "",
          loading: Boolean(demoResponse || shouldRunModel),
          waitingForFirstEvent: Boolean(shouldRunModel),
          streaming: false,
          responseStarted: Boolean(demoSticker),
          sticker: demoSticker,
        }] : []),
      ],
    }));
    setDrafts((current) => ({ ...current, [scopeKey]: "" }));
    setAttachmentsByScope((current) => ({ ...current, [scopeKey]: [] }));
    const updatedSession = await chatStore()?.append(sessionId, {
      id: userMessageId,
      role: "user",
      content: message,
      at: Date.now(),
      sticker: userSticker,
      attachments: attachmentsForMessage
        .filter((attachment) => (attachment.kind === "image" || attachment.kind === "document") && attachment.filePath)
        .map((attachment) => attachment.kind === "image" ? {
          kind: "image" as const,
          name: attachment.name,
          filePath: attachment.filePath!,
          mime: attachment.mime ?? "application/octet-stream",
          caption: attachment.caption,
          status: "pending" as const,
        } : {
          kind: "document" as const,
          name: attachment.name,
          filePath: attachment.filePath!,
          status: "pending" as const,
        }),
    });
    void refreshSessions(targetMode, false);
    if (attachmentsForMessage.length > 0) {
      void prepareImageAttachments(targetMode, userMessageId, attachmentsForMessage);
    }
    if (demoResponse && assistantId) streamDemoResponse(targetMode, assistantId, demoResponse, sessionId);
    if (shouldRunModel && assistantId && !updatedSession) {
      updateMessage(targetMode, assistantId, {
        content: "模型请求失败：用户消息未能写入当前会话",
        loading: false,
        waitingForFirstEvent: false,
        streaming: false,
        responseStarted: true,
      });
    } else if (shouldRunModel && assistantId && updatedSession) {
      await runModel({
        targetMode,
        sessionId,
        userMessageId,
        assistantId,
        session: updatedSession,
        attachments: attachmentsForMessage,
      });
    }
  }

  return (
    <div className={`cy-page ${collapsed ? "is-collapsed" : ""}`}>
      <div className="cy-page-toggle">
        <SidebarToggle collapsed={collapsed} onToggle={() => setCollapsed((v) => !v)} />
      </div>
      <div className="cy-page-mode">
        <ModeSwitch value={mode} onChange={(nextMode) => {
          if (isConversationMode(nextMode)) setMode(nextMode);
        }} />
      </div>
      <div className="cy-page-status">
        <CharacterStatusPill avatarPath={avatarLight} status={modelName} />
      </div>
      <div className="cy-page-windows">
        <WindowControls
          onMinimize={() => window.chat?.minimize()}
          onMaximize={() => window.chat?.toggleMaximize()}
          onClose={() => window.chat?.close()}
        />
      </div>
      <div className="cy-page-settings">
        <SettingsButton onClick={() => sidebarApi()?.openSettings("appearance")} />
      </div>
      <div className="cy-page-user">
        <UserAvatar />
      </div>
      <div className="cy-page-newtask">
        <NewTaskButton label={taskLabel} onClick={() => void createNewTask()} />
      </div>
      <div className="cy-page-conversations">
        <ConversationSidebar
          mode={mode}
          sessions={sessions}
          activeSessionId={activeSessionId}
          onSelect={(sessionId) => void selectSession(sessionId)}
          onOpenProject={(workspaceRoot) => {
            void chatStore()?.openWorkspace(workspaceRoot).then((result) => {
              if (!result.ok) window.alert(`无法打开项目文件夹：${result.error ?? "未知错误"}`);
            });
          }}
        />
      </div>
      <main
        className={`cy-workspace ${hasMessages ? "has-messages" : "is-empty"} ${isDraggingFiles ? "is-dragging-files" : ""}`}
        onDragEnter={handleDragEnter}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
      >
        {isDraggingFiles && (
          <div className="cy-file-drop-overlay" aria-hidden="true">
            <span>松开即可添加到当前对话</span>
          </div>
        )}
        {hasMessages && (
          <ChatMessageList
            messages={messages}
            conversationId={activeSessionId}
            mode={mode}
            preferredAddress={preferredAddress}
            stickerSize={stickerSize}
            revisionBusy={modelBusy || lastTurnRevisionStarting}
            onEditLastUserMessage={mode === "chat" ? editLastChatUserMessage : undefined}
            onRegenerateLastResponse={mode === "chat" ? regenerateLastChatResponse : undefined}
            onTtsCacheKey={activeSessionId
              ? (messageId, cacheKey, converterVersion) => handleTtsCacheKey(
                mode,
                activeSessionId,
                messageId,
                cacheKey,
                converterVersion,
              )
              : undefined}
          />
        )}
        <div className="cy-workspace-composer">
          <ChatComposer
            value={draft}
            mode={mode}
            docked={hasMessages}
            workspaceName={workspaceNames[mode]}
            attachments={attachments}
            attachmentBusy={attachmentBusy}
            modelBusy={modelBusy && (mode === "chat" || mode === "work" || mode === "daily")}
            onChange={(value) => setDrafts((current) => ({ ...current, [scopeKey]: value }))}
            onSubmit={(value) => void sendMessage(value)}
            onChooseWorkspace={() => void chooseWorkspace()}
            onChooseFiles={(files) => void chooseFiles(files)}
            onRemoveAttachment={removeAttachment}
            onScreenshot={() => void window.chat?.startScreenshot()}
            onChooseSticker={(id) => {
              const separator = draft && !draft.endsWith(" ") ? " " : "";
              setDrafts((current) => ({ ...current, [scopeKey]: `${draft}${separator}[sticker:${id}]` }));
            }}
          />
        </div>
      </main>
    </div>
  );
}
