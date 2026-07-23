// channels/inbound-server —— 本地 HTTP server，给外部渠道（OpenClaw / Feishu）回调用。
//
// 安全策略：
//   - 只绑 127.0.0.1，外部网络不可达
//   - 共享密钥 header：X-Cyrene-Channel-Secret（启动时自动生成 32 字节 hex）
//   - 路由前缀：/channels/<id>/inbound   /channels/<id>/healthz
//
// Phase 0 只搭骨架（健康检查 + 路由框架）。Phase 1 接入 wechat 路由，Phase 2 接入 feishu 路由。
import * as http from "http";
import { createHmac, randomBytes, timingSafeEqual } from "crypto";
import { loadChannelsSettings, saveChannelsSettings } from "./settings-store";
import { channelManager } from "./manager";
import type { ChannelId, IncomingMessage } from "./types";
import { applySyncSnapshot, buildSyncSnapshot } from "../sync/sync-service";
import type { HistoryBundle, SyncSnapshot } from "../sync/types";
import { getAllStickerConfig } from "../sticker-storage";
import { resolveStickerImagePath } from "./dispatcher";
import { resolveBlobPath, extToMime } from "./mobile-blobs";
import { readHistoryByStem, writeHistoryByStem, stemForSession } from "./history-log";
import * as fs from "fs";
import * as path from "path";

const LOG = "[InboundServer]";

/** PC 端设备标识（阶段 3 CRDT 会持久化；阶段 1 仅进程内生成，用于快照来源标注）。 */
let pcDeviceId: string | null = null;
function getPcDeviceId(): string {
  if (!pcDeviceId) pcDeviceId = `pc-${randomBytes(6).toString("hex")}`;
  return pcDeviceId;
}


/** 给定 channelId + raw payload → IncomingMessage。每个 adapter 自己注册。 */
export type NormalizeFn = (channel: ChannelId, raw: unknown) => IncomingMessage | null;

interface InboundRoute {
  channel: ChannelId;
  normalize: NormalizeFn;
}

const routes: InboundRoute[] = [];

/** adapter 在 start() 时调用一次注册自己的路由。重复注册按 id 覆盖。 */
export function registerInboundRoute(channel: ChannelId, normalize: NormalizeFn): void {
  const existing = routes.findIndex((r) => r.channel === channel);
  if (existing >= 0) routes[existing] = { channel, normalize };
  else routes.push({ channel, normalize });
}

/**
 * 手机 App 聊天转发的运行器（可注入）。
 *
 * 阶段 1 的 "RN 聊天先经 PC 转发"：手机把一条文本 POST 到 /chat，PC 用
 * 现有两阶段大脑生成回复并写入该 sessionId 的历史（随后手机通过 /sync/pull 也能拿到）。
 * index.ts 启动时注入真实实现；未注入时 /chat 返回 503（大脑未就绪）。
 */
export type InboundChatRunner = (input: {
  /** 稳定会话 id，手机端固定用（如 "channel:mobile:main"），同时作为同步 stem。 */
  sessionId: string;
  /** 用户输入文本。 */
  text: string;
  /** 手机随消息发来的图片（base64）。运行器落 blob 并做视觉分析。 */
  images?: { name: string; mime: string; dataBase64: string }[];
}) => Promise<{
  reply: string;
  /** 权威 user 内容（含 [image:hash] 标记），端上按此存本地，保证与 /sync 去重键一致。 */
  userContent?: string;
  /** PC 给用户消息落历史时的权威时间戳（ISO）。 */
  userAt?: string;
  /** PC 给回复落历史时的权威时间戳（ISO）。 */
  assistantAt?: string;
}>;

let chatRunner: InboundChatRunner | null = null;
export function setInboundChatRunner(fn: InboundChatRunner | null): void {
  chatRunner = fn;
}

/**
 * 手机「桌面对话」主动消息回复运行器（可注入）。
 *
 * 用途：手机在「桌面对话」里回复 PC 的 proactive-chat 主动消息。运行器复用 PC 大脑，
 * 且必须在 index.ts 侧完整复刻桌面回复主动消息时的副作用（invalidateForUserMessage 重置冷却、
 * 会话生命周期 busy 计数、记忆抽取、写入 chats-store 的 proactive-chat 会话并广播刷新）。
 * 未注入时 /proactive/reply 返回 503。手机随后 /sync/pull 拉到的只读桌面镜像即含本轮问答。
 */
export type ProactiveReplyRunner = (input: {
  /** 用户在手机上对主动消息的回复文本。 */
  text: string;
}) => Promise<{
  reply: string;
  /** PC 给用户消息落库时的权威时间戳（ISO）。 */
  userAt?: string;
  /** PC 给回复落库时的权威时间戳（ISO）。 */
  assistantAt?: string;
}>;

let proactiveReplyRunner: ProactiveReplyRunner | null = null;
export function setProactiveReplyRunner(fn: ProactiveReplyRunner | null): void {
  proactiveReplyRunner = fn;
}

/**
 * 只读桌面历史提供者（可注入）。
 *
 * 用途：手机端「桌面对话」只读镜像。桌面 proactive-chat 会话存在 chatsStore（非 history-log），
 * 不在 buildSyncSnapshot 的常规 stem 里。这里由 index.ts 注入一个把 proactive-chat 会话转成
 * HistoryBundle 的函数，/sync/pull 时把它追加进快照 history（stem 用只读前缀，见 types.ts）。
 * 手机拉到后仅展示、不回写；PC 收到 push 时会跳过该前缀的 stem（防幻影历史文件）。
 */
export type DesktopHistoryProvider = (since: number) => HistoryBundle[];

let desktopHistoryProvider: DesktopHistoryProvider | null = null;
export function setDesktopHistoryProvider(fn: DesktopHistoryProvider | null): void {
  desktopHistoryProvider = fn;
}

/** 内部：检查共享密钥（仅当 secret 已设置时强制校验） */
function checkSecret(req: http.IncomingMessage, secret: string): boolean {
  if (!secret) return true; // 未启用时不校验
  const got = req.headers["x-cyrene-channel-secret"];
  if (typeof got !== "string") return false;
  const expected = Buffer.from(secret, "utf8");
  const actual = Buffer.from(got, "utf8");
  if (expected.length !== actual.length) return false;
  return timingSafeEqual(expected, actual);
}

/** 内部：读 body */
function readBody(req: http.IncomingMessage, max = 4 * 1024 * 1024): Promise<string> {
  return new Promise((resolve, reject) => {
    let total = 0;
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => {
      total += c.length;
      if (total > max) {
        reject(new Error("payload too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

/** 内部：构造响应 */
function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

/** 内部：把磁盘文件以给定 mime 流式返回，并妥善处理流错误（避免未捕获 error 崩溃进程）。 */
function streamFile(res: http.ServerResponse, fp: string, mime: string): void {
  res.writeHead(200, { "content-type": mime, "cache-control": "public, max-age=31536000" });
  const stream = fs.createReadStream(fp);
  stream.on("error", (err) => {
    console.error(LOG, "文件流失败:", err);
    if (!res.headersSent) {
      try { sendJson(res, 500, { ok: false, error: "file read failed" }); } catch { /* ignore */ }
    } else {
      res.destroy(err);
    }
  });
  stream.pipe(res);
}

async function handleRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  secret: string,
): Promise<void> {
  // 健康检查：免密钥
  if (req.url === "/channels/healthz" && req.method === "GET") {
    sendJson(res, 200, { ok: true, channels: channelManager.listChannels() });
    return;
  }

  // 入站路由：/channels/<id>/inbound
  const m = /^\/channels\/([^/]+)\/inbound\/?$/.exec(req.url || "");
  if (m && req.method === "POST") {
    const channelId = decodeURIComponent(m[1]) as ChannelId;
    if (!checkSecret(req, secret)) {
      sendJson(res, 401, { ok: false, error: "invalid shared secret" });
      return;
    }
    const route = routes.find((r) => r.channel === channelId);
    if (!route) {
      sendJson(res, 404, { ok: false, error: `no route registered for channel: ${channelId}` });
      return;
    }
    let raw: unknown = null;
    try {
      const text = await readBody(req);
      raw = text ? JSON.parse(text) : null;
    } catch (err) {
      sendJson(res, 400, { ok: false, error: err instanceof Error ? err.message : "bad json" });
      return;
    }
    let msg: IncomingMessage | null = null;
    try {
      msg = route.normalize(channelId, raw);
    } catch (err) {
      console.error(LOG, `normalize 失败 [${channelId}]:`, err);
      sendJson(res, 500, { ok: false, error: "normalize failed" });
      return;
    }
    if (!msg) {
      sendJson(res, 200, { ok: true, ignored: true });
      return;
    }
    // 同步给 adapter.onMessage handler；handler 是 dispatcher
    const adapter = channelManager.getAdapter(channelId);
    if (!adapter || !adapter.onMessage) {
      sendJson(res, 503, { ok: false, error: "adapter not ready" });
      return;
    }
    try {
      const outgoing = await adapter.onMessage(msg);
      // 当前只回 ack；adapters 自己负责把 outgoing 真的发出去
      sendJson(res, 200, { ok: true, replied: outgoing != null });
    } catch (err) {
      console.error(LOG, `handler 失败 [${channelId}]:`, err);
      sendJson(res, 500, { ok: false, error: "handler failed" });
    }
    return;
  }

  // 同步：拉取增量快照。GET /sync/pull?since=<ms>
  // 鉴权沿用 X-Cyrene-Channel-Secret。since 为上次游标（ms），缺省 = 全量。
  {
    const pull = /^\/sync\/pull(?:\?.*)?$/.exec(req.url || "");
    if (pull && req.method === "GET") {
      if (!checkSecret(req, secret)) {
        sendJson(res, 401, { ok: false, error: "invalid shared secret" });
        return;
      }
      let since = 0;
      try {
        const u = new URL(req.url || "", "http://127.0.0.1");
        const raw = u.searchParams.get("since");
        if (raw) {
          const n = Number(raw);
          if (Number.isFinite(n) && n >= 0) since = n;
        }
      } catch {
        /* ignore malformed query, treat as full pull */
      }
      try {
        const snapshot = await buildSyncSnapshot(getPcDeviceId(), since);
        // 追加只读桌面镜像 bundle（手机「桌面对话」用）。失败不影响主同步。
        if (desktopHistoryProvider) {
          try {
            const extra = desktopHistoryProvider(since);
            for (const bundle of extra) {
              if (bundle && bundle.stem && bundle.entries.length > 0) snapshot.history.push(bundle);
            }
          } catch (err) {
            console.warn(LOG, "desktopHistoryProvider 失败（跳过只读镜像）:", err);
          }
        }
        sendJson(res, 200, { ok: true, snapshot });
      } catch (err) {
        console.error(LOG, "sync/pull 失败:", err);
        sendJson(res, 500, { ok: false, error: "sync pull failed" });
      }
      return;
    }
  }

  // 同步：接收对端推送并合并。POST /sync/push  body=SyncSnapshot
  {
    const push = /^\/sync\/push\/?$/.exec(req.url || "");
    if (push && req.method === "POST") {
      if (!checkSecret(req, secret)) {
        sendJson(res, 401, { ok: false, error: "invalid shared secret" });
        return;
      }
      let snapshot: SyncSnapshot | null = null;
      try {
        const text = await readBody(req);
        snapshot = text ? (JSON.parse(text) as SyncSnapshot) : null;
      } catch (err) {
        sendJson(res, 400, { ok: false, error: err instanceof Error ? err.message : "bad json" });
        return;
      }
      if (!snapshot || typeof snapshot !== "object" || !snapshot.l0 || !snapshot.l1) {
        sendJson(res, 400, { ok: false, error: "invalid sync snapshot" });
        return;
      }
      try {
        const { cursor, applied } = await applySyncSnapshot(snapshot);
        sendJson(res, 200, { ok: true, cursor, applied });
      } catch (err) {
        console.error(LOG, "sync/push 失败:", err);
        sendJson(res, 500, { ok: false, error: "sync push failed" });
      }
      return;
    }
  }

  // 手机 App 聊天转发。POST /chat  body={ sessionId, text }
  // PC 用现有大脑生成回复并落该 sessionId 历史（手机随后 /sync/pull 也能拿到）。
  {
    const chat = /^\/chat\/?$/.exec(req.url || "");
    if (chat && req.method === "POST") {
      if (!checkSecret(req, secret)) {
        sendJson(res, 401, { ok: false, error: "invalid shared secret" });
        return;
      }
      if (!chatRunner) {
        sendJson(res, 503, { ok: false, error: "chat runner not ready" });
        return;
      }
      let body:
        | { sessionId?: unknown; text?: unknown; images?: unknown }
        | null = null;
      try {
        const text = await readBody(req, 16 * 1024 * 1024);
        body = text ? JSON.parse(text) : null;
      } catch (err) {
        sendJson(res, 400, { ok: false, error: err instanceof Error ? err.message : "bad json" });
        return;
      }
      const userText = typeof body?.text === "string" ? body.text.trim() : "";
      const rawImages = Array.isArray(body?.images) ? body!.images : [];
      const images = rawImages
        .filter(
          (x: unknown): x is { name: string; mime: string; dataBase64: string } =>
            !!x &&
            typeof (x as any).mime === "string" &&
            typeof (x as any).dataBase64 === "string",
        )
        .map((x) => ({ name: typeof x.name === "string" ? x.name : "image", mime: x.mime, dataBase64: x.dataBase64 }));
      if (!userText && images.length === 0) {
        sendJson(res, 400, { ok: false, error: "missing text or images" });
        return;
      }
      const sessionId =
        typeof body?.sessionId === "string" && body.sessionId.trim()
          ? body.sessionId.trim()
          : "channel:mobile:main";
      try {
        const { reply, userContent, userAt, assistantAt } = await chatRunner({
          sessionId,
          text: userText,
          images: images.length > 0 ? images : undefined,
        });
        sendJson(res, 200, { ok: true, reply, sessionId, userContent, userAt, assistantAt });
      } catch (err) {
        console.error(LOG, "chat 失败:", err);
        sendJson(res, 500, { ok: false, error: "chat failed" });
      }
      return;
    }
  }

  // 手机回复桌面主动消息。POST /proactive/reply  body={ text }
  // PC 用现有大脑生成回复，写入 proactive-chat 会话（手机随后 /sync/pull 拉到桌面镜像即含本轮）。
  // 该路径仅在手机在线时使用（手机侧门控），离线不可回复，避免记忆/历史冲突。
  {
    const reply = /^\/proactive\/reply\/?$/.exec(req.url || "");
    if (reply && req.method === "POST") {
      if (!checkSecret(req, secret)) {
        sendJson(res, 401, { ok: false, error: "invalid shared secret" });
        return;
      }
      if (!proactiveReplyRunner) {
        sendJson(res, 503, { ok: false, error: "proactive reply runner not ready" });
        return;
      }
      let body: { text?: unknown } | null = null;
      try {
        const text = await readBody(req);
        body = text ? JSON.parse(text) : null;
      } catch (err) {
        sendJson(res, 400, { ok: false, error: err instanceof Error ? err.message : "bad json" });
        return;
      }
      const userText = typeof body?.text === "string" ? body.text.trim() : "";
      if (!userText) {
        sendJson(res, 400, { ok: false, error: "missing text" });
        return;
      }
      try {
        const { reply: replyText, userAt, assistantAt } = await proactiveReplyRunner({ text: userText });
        sendJson(res, 200, { ok: true, reply: replyText, userAt, assistantAt });
      } catch (err) {
        console.error(LOG, "proactive/reply 失败:", err);
        // 忙时拒绝（PC 正在对话）返回 409，与“PC 离线/其他错误”区分：
        // 手机侧据此保持在线态并还原草稿，而非当作掉线隐藏输入框。
        if ((err as { code?: unknown }).code === "PC_BUSY") {
          sendJson(res, 409, { ok: false, busy: true, error: err instanceof Error ? err.message : "pc busy" });
        } else {
          sendJson(res, 500, { ok: false, error: err instanceof Error ? err.message : "proactive reply failed" });
        }
      }
      return;
    }
  }

  // 表情包列表：GET /stickers → { ok, stickers:[{id,description}] }
  {
    const m2 = /^\/stickers\/?$/.exec(req.url || "");
    if (m2 && req.method === "GET") {
      if (!checkSecret(req, secret)) { sendJson(res, 401, { ok: false, error: "invalid shared secret" }); return; }
      try {
        const items = getAllStickerConfig({})
          .filter((it) => it.enabled)
          .map((it) => ({ id: it.id, description: it.description }));
        sendJson(res, 200, { ok: true, stickers: items });
      } catch (err) {
        console.error(LOG, "/stickers 失败:", err);
        sendJson(res, 500, { ok: false, error: "stickers failed" });
      }
      return;
    }
  }

  // 表情包图片：GET /sticker/:id
  {
    const m2 = /^\/sticker\/([A-Za-z0-9_-]+)\/?$/.exec(req.url || "");
    if (m2 && req.method === "GET") {
      if (!checkSecret(req, secret)) { sendJson(res, 401, { ok: false, error: "invalid shared secret" }); return; }
      const fp = resolveStickerImagePath(decodeURIComponent(m2[1]));
      if (!fp || !fs.existsSync(fp)) { sendJson(res, 404, { ok: false, error: "sticker not found" }); return; }
      const ext = path.extname(fp).slice(1).toLowerCase();
      const mime = ext === "gif" ? "image/gif" : ext === "png" ? "image/png" : ext === "webp" ? "image/webp" : "image/jpeg";
      streamFile(res, fp, mime);
      return;
    }
  }

  // 图片 blob：GET /blob/:hash
  {
    const m2 = /^\/blob\/([0-9a-f]{64})\/?$/.exec(req.url || "");
    if (m2 && req.method === "GET") {
      if (!checkSecret(req, secret)) { sendJson(res, 401, { ok: false, error: "invalid shared secret" }); return; }
      const fp = resolveBlobPath(m2[1]);
      if (!fp) { sendJson(res, 404, { ok: false, error: "blob not found" }); return; }
      const ext = path.extname(fp).slice(1).toLowerCase();
      streamFile(res, fp, extToMime(ext));
      return;
    }
  }

  // 整轮删除：POST /history/delete-turn  body={ sessionId, at }
  // 删除 at 命中的条目，并按 role 连带删除配对（user→后一条 assistant；assistant→前一条 user）。
  {
    const m2 = /^\/history\/delete-turn\/?$/.exec(req.url || "");
    if (m2 && req.method === "POST") {
      if (!checkSecret(req, secret)) { sendJson(res, 401, { ok: false, error: "invalid shared secret" }); return; }
      let body: { sessionId?: unknown; at?: unknown } | null = null;
      try {
        const text = await readBody(req);
        body = text ? JSON.parse(text) : null;
      } catch (err) {
        sendJson(res, 400, { ok: false, error: err instanceof Error ? err.message : "bad json" });
        return;
      }
      const sessionId = typeof body?.sessionId === "string" ? body.sessionId.trim() : "";
      const at = typeof body?.at === "string" ? body.at : "";
      if (!sessionId || !at) { sendJson(res, 400, { ok: false, error: "missing sessionId or at" }); return; }
      try {
        const stem = stemForSession(sessionId);
        const entries = readHistoryByStem(stem);
        const idx = entries.findIndex((e) => e.at === at);
        if (idx < 0) { sendJson(res, 200, { ok: true, removed: 0 }); return; }
        const toRemove = new Set<number>([idx]);
        if (entries[idx].role === "user" && entries[idx + 1]?.role === "assistant") toRemove.add(idx + 1);
        else if (entries[idx].role === "assistant" && entries[idx - 1]?.role === "user") toRemove.add(idx - 1);
        const kept = entries.filter((_, i) => !toRemove.has(i));
        writeHistoryByStem(stem, kept);
        sendJson(res, 200, { ok: true, removed: toRemove.size });
      } catch (err) {
        console.error(LOG, "/history/delete-turn 失败:", err);
        sendJson(res, 500, { ok: false, error: "delete failed" });
      }
      return;
    }
  }

  sendJson(res, 404, { ok: false, error: "not found" });
}

export interface InboundServerHandle {
  port: number;
  close(): Promise<void>;
}

let server: http.Server | null = null;
let currentHandle: InboundServerHandle | null = null;

/** 启动 inbound-server（idempotent：如果已起且端口一致，直接返回现有 handle） */
export async function startInboundServer(): Promise<InboundServerHandle> {
  const settings = loadChannelsSettings();
  // 共享密钥：首次启动若为空则生成 32 字节随机
  let secret = settings.sharedSecret;
  if (!secret) {
    const random = randomBytes(32).toString("hex");
    secret = random;
    saveChannelsSettings({ sharedSecret: secret });
  }

  if (currentHandle && server) {
    return currentHandle;
  }

  // 启动策略：
  // 1) 优先用 settings.inboundPort（如果非 0）
  // 2) 被占 → fallback 到 0（OS 随机分）
  // 3) 仍被占 → 最多重试 3 次（每次都换 server 实例）
  const tryPorts: Array<number | "random"> = [];
  if (settings.inboundPort > 0) tryPorts.push(settings.inboundPort);
  tryPorts.push("random");

  // 绑定地址：默认仅回环（与历史行为一致）；仅当用户显式开启 inboundBindLan 时才绑 0.0.0.0，
  // 让局域网内的手机 App 能直连（仍强制 X-Cyrene-Channel-Secret 鉴权）。
  const bindHost = settings.inboundBindLan ? "0.0.0.0" : "127.0.0.1";

  let lastErr: unknown = null;
  let actualPort = 0;
  for (const target of tryPorts) {
    if (server) {
      // 关闭上次失败遗留的实例
      try {
        await new Promise<void>((r) => server!.close(() => r()));
      } catch {
        /* ignore */
      }
      server = null;
    }
    const port = target === "random" ? 0 : target;
    server = http.createServer((req, res) => {
      handleRequest(req, res, secret).catch((err) => {
        console.error(LOG, "unhandled:", err);
        try {
          sendJson(res, 500, { ok: false, error: "internal" });
        } catch {
          /* ignore */
        }
      });
    });
    try {
      await new Promise<void>((resolve, reject) => {
        const onError = (err: Error) => reject(err);
        server!.once("error", onError);
        server!.listen(port, bindHost, () => {
          server!.off("error", onError);
          resolve();
        });
      });
      const addr = server.address();
      actualPort = typeof addr === "object" && addr ? addr.port : 0;
      break;
    } catch (err) {
      lastErr = err;
      console.warn(LOG, `端口 ${port === 0 ? "(random)" : port} 占用, 尝试下一个`);
      continue;
    }
  }

  if (!server || actualPort === 0) {
    throw lastErr instanceof Error ? lastErr : new Error("inbound-server 启动失败");
  }

  const port = actualPort;

  // 把真实端口写回 settings（如果原来是 0 或撞了端口）
  if (settings.inboundPort !== port) {
    saveChannelsSettings({ inboundPort: port });
  }

  currentHandle = {
    port,
    close: () =>
      new Promise<void>((resolve) => {
        if (server) {
          server.close(() => {
            server = null;
            currentHandle = null;
            resolve();
          });
        } else {
          resolve();
        }
      }),
  };
  console.log(LOG, `启动于 http://${bindHost}:${port}`);
  return currentHandle;
}

/** 关闭（app 退出时调） */
export async function stopInboundServer(): Promise<void> {
  if (currentHandle) {
    await currentHandle.close();
  }
}

/** 给 runtime 计算一个 HMAC（用作 X-Cyrene-Channel-Secret 的 payload 签名场景，备用） */
export function signPayload(payload: string, secret: string): string {
  return createHmac("sha256", secret).update(payload).digest("hex");
}