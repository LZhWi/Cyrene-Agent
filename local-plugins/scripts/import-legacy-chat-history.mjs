import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

function parseArgs(argv) {
  const args = { apply: false, verify: false };
  for (let i = 0; i < argv.length; i++) {
    const value = argv[i];
    if (value === "--apply") args.apply = true;
    else if (value === "--verify") args.verify = true;
    else if (value === "--source") args.source = argv[++i];
    else if (value === "--target") args.target = argv[++i];
    else if (value === "--backup-root") args.backupRoot = argv[++i];
    else if (value === "--report-root") args.reportRoot = argv[++i];
    else throw new Error(`未知参数：${value}`);
  }
  for (const name of ["source", "target"]) {
    if (!args[name]) throw new Error(`缺少 --${name}`);
  }
  return args;
}

function comparableMessage(message) {
  const value = clone(message);
  if (Array.isArray(value.attachments)) {
    value.attachments = value.attachments.map(({ filePath: _filePath, previewUrl: _previewUrl, status: _status, ...rest }) => rest);
  }
  return value;
}

export function verifyChatHistory(options) {
  const sourceData = readSource(options.source);
  const targetDir = path.resolve(options.target);
  const targetIndex = readJson(path.join(targetDir, "index.json"));
  if (!Array.isArray(targetIndex)) throw new Error("目标索引不是数组");
  const counters = { sessions: 0, messages: 0, copied: 0, missing: 0 };
  for (const item of sourceData.sessions) {
    const meta = targetIndex.find((candidate) => candidate?.id === item.session.id);
    if (!meta || meta.mode !== "chat" || meta.messageCount !== item.session.messages.length) {
      throw new Error(`目标索引对账失败：${item.session.id}`);
    }
    const targetSession = readJson(path.join(targetDir, "sessions", `${item.session.id}.json`));
    validateSession(targetSession, item.session.id);
    if (targetSession.mode !== "chat" || targetSession.messages.length !== item.session.messages.length) {
      throw new Error(`目标会话模式或消息数不符：${item.session.id}`);
    }
    for (let i = 0; i < item.session.messages.length; i++) {
      const sourceMessage = item.session.messages[i];
      const targetMessage = targetSession.messages[i];
      if (JSON.stringify(comparableMessage(sourceMessage)) !== JSON.stringify(comparableMessage(targetMessage))) {
        throw new Error(`消息非路径字段不一致：${item.session.id}/${i}`);
      }
      counters.messages++;
      for (let j = 0; j < (sourceMessage.attachments?.length ?? 0); j++) {
        const sourceAttachment = sourceMessage.attachments[j];
        const targetAttachment = targetMessage.attachments[j];
        const resolved = path.resolve(String(targetAttachment.filePath ?? ""));
        const assetRoot = path.resolve(targetDir, "imported-assets") + path.sep;
        if (!resolved.startsWith(assetRoot)) throw new Error("目标附件仍引用隔离目录外路径");
        const sourceStat = fs.lstatSync(String(sourceAttachment.filePath ?? ""), { throwIfNoEntry: false });
        if (sourceStat?.isFile() && !sourceStat.isSymbolicLink()) {
          if (!fs.lstatSync(resolved, { throwIfNoEntry: false })?.isFile()
            || fileHash(resolved) !== fileHash(sourceAttachment.filePath)) throw new Error("目标附件哈希不一致");
          counters.copied++;
        } else {
          if (targetAttachment.status !== "error" || fs.existsSync(resolved)) throw new Error("缺失附件隔离状态不正确");
          counters.missing++;
        }
      }
    }
    counters.sessions++;
  }
  return { verified: true, sourceHash: sourceData.sourceHash, counters, targetSessions: targetIndex.length };
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function sha256(input) {
  return crypto.createHash("sha256").update(input).digest("hex");
}

function fileHash(file) {
  return sha256(fs.readFileSync(file));
}

function assertPlainFile(file, label) {
  const stat = fs.lstatSync(file, { throwIfNoEntry: false });
  if (!stat?.isFile() || stat.isSymbolicLink()) throw new Error(`${label}不是普通文件：${file}`);
}

function safeId(value, label) {
  if (typeof value !== "string" || !/^[A-Za-z0-9._-]{1,200}$/.test(value)) {
    throw new Error(`${label}无效`);
  }
  return value;
}

function atomicWriteJson(file, value) {
  const temp = `${file}.tmp-${crypto.randomUUID()}`;
  fs.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx" });
  fs.renameSync(temp, file);
}

function validateSession(session, expectedId) {
  if (!session || typeof session !== "object" || session.schemaVersion !== 1
    || safeId(session.id, "会话 ID") !== expectedId || typeof session.title !== "string"
    || !Number.isFinite(session.createdAt) || !Number.isFinite(session.updatedAt)
    || !Array.isArray(session.messages)) throw new Error(`会话结构无效：${expectedId}`);
  const ids = new Set();
  for (const message of session.messages) {
    if (!message || !["user", "model"].includes(message.role) || typeof message.content !== "string"
      || !Number.isFinite(message.at)) throw new Error(`消息结构无效：${expectedId}`);
    const id = safeId(message.id, "消息 ID");
    if (ids.has(id)) throw new Error(`会话内消息 ID 重复：${expectedId}`);
    ids.add(id);
    if (message.attachments !== undefined && !Array.isArray(message.attachments)) {
      throw new Error(`附件结构无效：${expectedId}`);
    }
  }
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function readSource(sourceDir) {
  const source = path.resolve(sourceDir);
  const indexPath = path.join(source, "index.json");
  const sessionsDir = path.join(source, "sessions");
  assertPlainFile(indexPath, "源索引");
  if (!fs.lstatSync(sessionsDir, { throwIfNoEntry: false })?.isDirectory()) {
    throw new Error("源 sessions 目录不存在");
  }
  const indexRaw = fs.readFileSync(indexPath);
  const index = JSON.parse(indexRaw.toString("utf8"));
  if (!Array.isArray(index)) throw new Error("源索引不是数组");
  const seen = new Set();
  const sessions = [];
  const hash = crypto.createHash("sha256").update(indexRaw);
  for (const meta of index) {
    const id = safeId(meta?.id, "索引会话 ID");
    if (seen.has(id)) throw new Error(`源索引会话 ID 重复：${id}`);
    seen.add(id);
    const file = path.join(sessionsDir, `${id}.json`);
    assertPlainFile(file, "源会话");
    const raw = fs.readFileSync(file);
    hash.update(raw);
    const session = JSON.parse(raw.toString("utf8"));
    validateSession(session, id);
    sessions.push({ meta, session, fileHash: sha256(raw) });
  }
  return { source, indexPath, sessions, sourceHash: hash.digest("hex") };
}

function copyAttachment(attachment, destination, finalPath, counters) {
  const sourcePath = typeof attachment.filePath === "string" ? attachment.filePath : "";
  const stat = sourcePath ? fs.lstatSync(sourcePath, { throwIfNoEntry: false }) : null;
  if (!stat?.isFile() || stat.isSymbolicLink()) {
    counters.missing++;
    attachment.filePath = finalPath;
    delete attachment.previewUrl;
    attachment.status = "error";
    return;
  }
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.copyFileSync(sourcePath, destination, fs.constants.COPYFILE_EXCL);
  if (fileHash(sourcePath) !== fileHash(destination)) throw new Error("附件复制校验失败");
  attachment.filePath = finalPath;
  attachment.previewUrl = pathToFileURL(finalPath).href;
  counters.copied++;
  counters.bytes += stat.size;
}

function buildCandidate(sourceData, targetDir, stageDir) {
  if (fs.existsSync(targetDir)) fs.cpSync(targetDir, stageDir, { recursive: true, errorOnExist: true });
  else fs.mkdirSync(stageDir, { recursive: true });
  const sessionsDir = path.join(stageDir, "sessions");
  fs.mkdirSync(sessionsDir, { recursive: true });
  const targetIndexPath = path.join(stageDir, "index.json");
  const targetIndex = fs.existsSync(targetIndexPath) ? readJson(targetIndexPath) : [];
  if (!Array.isArray(targetIndex)) throw new Error("目标索引不是数组");
  const targetIds = new Set(targetIndex.map((item) => safeId(item?.id, "目标索引会话 ID")));
  const counters = { sessions: 0, messages: 0, user: 0, model: 0, copied: 0, missing: 0, bytes: 0 };
  const importedMeta = [];
  for (const item of sourceData.sessions) {
    if (targetIds.has(item.session.id) || fs.existsSync(path.join(sessionsDir, `${item.session.id}.json`))) {
      throw new Error(`目标已存在同 ID 会话，拒绝覆盖：${item.session.id}`);
    }
    const session = clone(item.session);
    session.mode = "chat";
    delete session.workspaceBinding;
    for (const message of session.messages) {
      counters[message.role]++;
      counters.messages++;
      for (let i = 0; i < (message.attachments?.length ?? 0); i++) {
        const attachment = message.attachments[i];
        const extension = path.extname(String(attachment.filePath ?? "")).slice(0, 20);
        const relative = path.join("imported-assets", session.id, message.id, `${i}${extension}`);
        copyAttachment(attachment, path.join(stageDir, relative), path.join(targetDir, relative), counters);
      }
    }
    validateSession(session, session.id);
    atomicWriteJson(path.join(sessionsDir, `${session.id}.json`), session);
    importedMeta.push({
      id: session.id,
      title: session.title,
      identityId: session.identityId ?? null,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
      messageCount: session.messages.length,
      ...(session.purpose ? { purpose: session.purpose } : {}),
      mode: "chat",
      pinned: Boolean(session.pinned),
    });
    counters.sessions++;
  }
  const merged = [...targetIndex, ...importedMeta].sort((a, b) => b.updatedAt - a.updatedAt);
  atomicWriteJson(targetIndexPath, merged);
  const check = readJson(targetIndexPath);
  if (check.length !== merged.length || importedMeta.some((meta) =>
    !check.some((item) => item.id === meta.id && item.mode === "chat" && item.messageCount === meta.messageCount))) {
    throw new Error("候选索引回读校验失败");
  }
  return { counters, targetSessionsBefore: targetIndex.length, targetSessionsAfter: merged.length };
}

export function migrateChatHistory(options) {
  const sourceData = readSource(options.source);
  const targetDir = path.resolve(options.target);
  const parent = path.dirname(targetDir);
  fs.mkdirSync(parent, { recursive: true });
  const stageDir = path.join(parent, `.chat-import-stage-${crypto.randomUUID()}`);
  let result;
  try {
    result = buildCandidate(sourceData, targetDir, stageDir);
    if (!options.apply) return { applied: false, sourceHash: sourceData.sourceHash, ...result };
    if (!options.backupRoot || !options.reportRoot) throw new Error("正式导入需要 --backup-root 和 --report-root");
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const runId = `${stamp}-${crypto.randomUUID()}`;
    const backupDir = path.resolve(options.backupRoot, runId, "cyrene-chats");
    fs.mkdirSync(path.dirname(backupDir), { recursive: true });
    if (fs.existsSync(targetDir)) fs.renameSync(targetDir, backupDir);
    try {
      fs.renameSync(stageDir, targetDir);
    } catch (error) {
      if (fs.existsSync(backupDir) && !fs.existsSync(targetDir)) fs.renameSync(backupDir, targetDir);
      throw error;
    }
    const report = {
      version: 1,
      runId,
      createdAt: Date.now(),
      sourceHash: sourceData.sourceHash,
      backupDir: fs.existsSync(backupDir) ? backupDir : null,
      ...result,
    };
    fs.mkdirSync(options.reportRoot, { recursive: true });
    atomicWriteJson(path.join(options.reportRoot, `${runId}-chat-history.json`), report);
    return { applied: true, ...report };
  } finally {
    if (fs.existsSync(stageDir)) fs.rmSync(stageDir, { recursive: true, force: true });
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  try {
    const args = parseArgs(process.argv.slice(2));
    if (args.verify && args.apply) throw new Error("--verify 与 --apply 不能同时使用");
    const result = args.verify ? verifyChatHistory(args) : migrateChatHistory(args);
    console.log(JSON.stringify(result));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
