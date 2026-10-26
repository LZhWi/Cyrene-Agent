// channels/dispatcher —— 入站消息处理核心。
//
// 设计原则：
//   - 不知道任何具体平台。平台信息只用于查找适配器、记录日志和生成会话标识。
//   - 统一编排限速、智能体执行、响应发送与上下文提交，具体能力由外部依赖提供。
//
// sessionId 生成规则：
//   `channel:<channel>:<sha256(channel:senderId).slice(0,16)>`
//   加 channel 前缀防止跨平台 ID 冲突；hash 截断 16 字符节约空间且日志脱敏。
//
// capability 降级：
//   把 OutgoingMessage 按目标渠道的 cap 翻译 —— image→text 描述 / card→markdown / sticker 跳过。
import type {
  IncomingMessage,
  OutgoingMessage,
} from "./types";
import type { ChannelsSettings } from "./settings-store";
import { appendLog } from "./message-log";
import type { MobileMessageSegmentationMode } from "../../shared/preferences";
import { rememberProactiveChannelRecipient } from "./proactive-delivery";
import type { ChannelRateLimiter } from "./rate-limiter";
import type { KeyedQueue } from "./keyed-queue";
import type { ChannelDeliveryService } from "./delivery-service";
import type { OutgoingComposer } from "./outgoing-composer";
import { channelReceipt } from './durable-delivery';
import {
  makeSessionId,
  type ChannelContext,
  type ChatMessage,
  type DispatchContext,
} from "./channel-context";

export {
  formatChannelUserText,
  lookupOriginalSender,
  makeSessionId,
} from "./channel-context";
export type {
  BoundConversationMessageMetadata,
  ChatMessage,
  DispatchContext,
} from "./channel-context";

const LOG = "[ChannelDispatcher]";

/** Dispatcher 配置（依赖注入）。 */
export interface DispatcherDeps {
  /** 按外部会话和绑定桌面会话串行执行。 */
  readonly queue: KeyedQueue;
  /** 原子消费渠道和用户限速额度。 */
  readonly limiter: ChannelRateLimiter;
  /** 读取和提交渠道与绑定桌面会话上下文。 */
  readonly context: ChannelContext;
  /** 根据渠道能力组装出站消息。 */
  readonly composer: OutgoingComposer;
  /** 统一渠道发送边界。 */
  readonly delivery: ChannelDeliveryService;
  /** 执行完整智能体调用。 */
  readonly buildAndRunAgent: (
    msg: IncomingMessage,
    sessionId: string,
    priorMessages?: ChatMessage[],
  ) => Promise<{ text: string; sticker: string | null }>;
  /** 延迟读取渠道设置，避免应用就绪前访问加密存储。 */
  readonly loadSettings: () => ChannelsSettings;
  /** 读取与渠道发送有关的通用设置。 */
  readonly loadGeneralSettings: () => {
    mobileMessageSegmentation?: MobileMessageSegmentationMode;
  };
  /** 记录最近见到的外部聊天，供设置页列出可绑定的来源。 */
  readonly observeExternalChat?: (sessionId: string, msg: IncomingMessage) => void;
  /** 可选 — 桌面端镜像广播：bot 入站/出站消息通知给 chatWindow。 */
  readonly broadcastChat?: (event: {
    type: "bot:incoming" | "bot:outgoing";
    channel: string;
    senderId: string;
    senderName?: string;
    chatId: string;
    text: string;
    at: number;
  }) => void;
}

export class ChannelDispatcher {
  private settingsCache: ChannelsSettings | null = null;

  constructor(private readonly deps: DispatcherDeps) {}

  /** 首次处理消息时再读取设置，避免应用就绪前访问加密存储。 */
  private get settings(): ChannelsSettings {
    if (!this.settingsCache) {
      this.settingsCache = this.deps.loadSettings();
      this.deps.limiter.reconfigure({
        perUser: this.settingsCache.rateLimitPerUser,
        perChannel: this.settingsCache.rateLimitPerChannel,
      });
    }
    return this.settingsCache;
  }

  /** 重新加载设置，并按新配置清空和更新限速器。 */
  reloadSettings(): void {
    this.settingsCache = null;
    void this.settings;
  }

  /**
   * 处理一条入站消息。这是 manager 注入到 adapter.onMessage 的回调。
   *
   * 流程：计算会话标识 → 限速 → 加载历史滑窗 → 本条落历史 → 调用智能体 →
   * 组装并发送出站消息 → 确认成功后提交助手状态。
   * 返回的出站消息仅供调用方观测和测试，不要求适配器再次发送。
   */
  async handleIncoming(msg: IncomingMessage): Promise<OutgoingMessage | null> {
    const sessionId = makeSessionId(msg.channel, msg.chatId);
    // 读取设置会同步刷新限速器，必须发生在本轮额度消费之前。
    void this.settings;
    return this.deps.queue.run(`external:${sessionId}`, async () => {
      if (!this.deps.limiter.tryConsume(msg.channel, msg.senderId)) {
        console.warn(LOG, `限速: ${msg.channel}:${msg.senderId}`);
        return null;
      }

      try {
        this.deps.observeExternalChat?.(sessionId, msg);
      } catch (err) {
        console.warn(LOG, "observeExternalChat 失败（继续处理消息）:", err);
      }

      const context = this.deps.context.resolveDispatchContext(sessionId);
      const execute = () => this.processIncoming(msg, context);
      return context.boundConversationId
        ? this.deps.queue.run(`conversation:${context.boundConversationId}`, execute)
        : execute();
    });
  }

  private async processIncoming(
    msg: IncomingMessage,
    context: DispatchContext,
  ): Promise<OutgoingMessage | null> {
    const { sessionId } = context;
    const receipt=channelReceipt(msg);
    if(receipt?.saved){
      if(receipt.saved.status==='delivered'){
        await receipt.commit(this.deps.context);return null;
      }
      // An interrupted/failed segmented send can already have external effects.
      // Never automatically resend an outcome whose delivery is uncertain.
      if(receipt.saved.status==='committed')return null;
      if(['sending','failed'].includes(receipt.saved.status)) {
        const warning='[发送回执待核对] 上次发送结果未确认，不自动重发。';
        console.warn(LOG,warning);
        appendLog({dir:'error',channel:msg.channel,senderId:msg.senderId,chatId:msg.chatId,text:warning});
        return null;
      }
    }
    // 绑定只选择历史与消息镜像目标，Agent 运行身份始终属于原渠道。
    this.deps.context.recordIncomingSession(msg, context);
    rememberProactiveChannelRecipient(msg, sessionId);

    // 入站消息广播到桌面端 chatWindow（让用户看到 bot 在和谁聊天）
    if (this.settings.mirrorToDesktop) {
      try {
        this.deps.broadcastChat?.({
          type: "bot:incoming",
          channel: msg.channel,
          senderId: msg.senderId,
          senderName: msg.senderName,
          chatId: msg.chatId,
          text: msg.text,
          at: msg.at.getTime(),
        });
      } catch (err) {
        console.warn(LOG, "broadcastChat (incoming) 失败:", err);
      }
    }

    // 入站消息写日志
    try {
      appendLog({
        dir: "incoming",
        channel: msg.channel,
        senderId: msg.senderId,
        senderName: msg.senderName,
        chatId: msg.chatId,
        text: msg.text,
        hasAttachments: (msg.attachments?.length ?? 0) > 0,
      });
    } catch (err) {
      console.warn(LOG, "appendLog (incoming) 失败:", err);
    }

    // 先加载历史滑窗（此时还不含本条），再落本条入站消息。
    // 顺序不能反：先 append 再 load 会让本条消息既出现在滑窗末尾、又作为新 user
    // 消息追加给 agent，模型会把同一条消息读两遍。
    const priorMessages = await this.deps.context.resolvePriorMessages(context, 16);

    // 入站消息落对话历史（下一轮滑窗的数据源）
    await this.deps.context.appendIncomingContext(msg, context);

    // 拼接最近 16 条历史（同桌面端模型消息构造行为）。
    let replyText: string;
    let sticker: string | null;
    try {
      const result = await this.deps.buildAndRunAgent(msg, sessionId, priorMessages);
      replyText = result.text;
      sticker = result.sticker;
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      console.error(LOG, "agent 调用失败:", errMsg);
      // 打包版通常看不到主进程输出，必须留下错误日志便于定位。
      try {
        appendLog({
          dir: "error",
          channel: msg.channel,
          senderId: msg.senderId,
          senderName: msg.senderName,
          chatId: msg.chatId,
          text: `[agent 调用失败] ${errMsg}`,
        });
      } catch (logErr) {
        console.warn(LOG, "appendLog (error) 失败:", logErr);
      }
      return null;
    }

    const prepared = await this.deps.composer.compose({
      incoming: msg,
      replyText,
      sticker,
      settings: {
        ttsEnabled: this.settings.ttsEnabled,
        stickerEnabled: this.settings.stickerEnabled,
      },
      mobileMessageSegmentation: this.deps.loadGeneralSettings().mobileMessageSegmentation,
    });

    try {
      receipt?.write({status:'sending',context,prepared:{assistantText:prepared.assistantText,stickerId:prepared.stickerId}});
      const deliveryResult = await this.deps.delivery.send(prepared.message);
      if (!deliveryResult.ok) {
        receipt?.write({status:'failed',error:deliveryResult.error});
        console.warn(LOG, `发送失败 [${msg.channel}]:`, deliveryResult.error);
        try {
          appendLog({
            dir: "error",
            channel: msg.channel,
            senderId: msg.senderId,
            senderName: msg.senderName,
            chatId: msg.chatId,
            text: `[发送失败] ${deliveryResult.error}`,
          });
        } catch (err) {
          console.warn(LOG, "appendLog (delivery error) 失败:", err);
        }
        return null;
      }

      receipt?.write({status:'delivered',context,prepared:{assistantText:prepared.assistantText,stickerId:prepared.stickerId}});

      // 出站消息广播到桌面端
      if (this.settings.mirrorToDesktop) {
        try {
          this.deps.broadcastChat?.({
            type: "bot:outgoing",
            channel: msg.channel,
            senderId: msg.senderId,
            senderName: msg.senderName,
            chatId: msg.chatId,
            text: prepared.assistantText,
            at: Date.now(),
          });
        } catch (err) {
          console.warn(LOG, "broadcastChat (outgoing) 失败:", err);
        }
      }

      // 出站消息写日志（仅文本片段，附件路径不写入日志）
      try {
        appendLog({
          dir: "outgoing",
          channel: msg.channel,
          senderId: msg.senderId,
          senderName: msg.senderName,
          chatId: msg.chatId,
          text: prepared.assistantText,
          hasAttachments: prepared.message.parts.some((part) => part.kind === "audio"),
        });
      } catch (err) {
        console.warn(LOG, "appendLog (outgoing) 失败:", err);
      }

      // 助手上下文只在渠道确认发送成功后提交。
      if(receipt)await receipt.commit(this.deps.context);
      else await this.deps.context.appendAssistantContext(msg, context, prepared);

      return prepared.message;
    } finally {
      try {
        await this.deps.composer.cleanupTransientFiles(prepared.transientFiles);
      } catch (err) {
        console.warn(LOG, "清理出站临时文件失败:", err);
      }
    }
  }
}
