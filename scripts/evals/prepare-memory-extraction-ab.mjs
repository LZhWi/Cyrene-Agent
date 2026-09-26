import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

const sessionPath = process.argv[2];
const outputDir = process.argv[3];
if (!sessionPath || !outputDir) throw new Error("用法: node prepare-memory-extraction-ab.mjs <会话文件> <隔离评测目录>");
if (fs.existsSync(path.join(outputDir, "corpus.json"))) throw new Error("评测语料已存在，拒绝覆盖");
const bytes = fs.readFileSync(sessionPath);
const sourceSha256 = createHash("sha256").update(bytes).digest("hex");
const session = JSON.parse(bytes.toString("utf8"));
const cases = [
  { id: "conditional-plan", endUserMessageIndex: 164, topic: "条件计划和长期承诺" },
  { id: "project-commitment", endUserMessageIndex: 760, topic: "项目进展与具体约定" },
  { id: "dated-travel", endUserMessageIndex: 1040, topic: "有日期锚点的行程与计划" },
].map(({ id, endUserMessageIndex, topic }) => {
  const pairs = [];
  for (let index = 0; index < session.messages.length - 1 && index <= endUserMessageIndex; index++) {
    const user = session.messages[index], assistant = session.messages[index + 1];
    if (user.role !== "user" || assistant.role !== "model") continue;
    if (!user.content?.trim() || !assistant.content?.trim()) continue;
    pairs.push({ sourceUserIndex: index, userMessageId: user.id, assistantMessageId: assistant.id,
      userAt: new Date(user.at).toISOString(), assistantAt: new Date(assistant.at).toISOString(),
      user: user.content, assistant: assistant.content,
      attachments: (user.attachments ?? []).map((item) => ({ kind: item.kind, name: item.name })) });
  }
  const turns = pairs.slice(-12);
  if (turns.length !== 12 || turns.at(-1).sourceUserIndex !== endUserMessageIndex) throw new Error(`${id}: 轮次窗口无效`);
  if (turns.some((turn) => turn.attachments.some((item) => item.kind === "image" || item.kind === "document")
    || /<think|<analysis/iu.test(turn.assistant))) throw new Error(`${id}: 窗口包含非文本附件或隐藏推理`);
  return { id, topic, conversationId: session.id, turns };
});
if (createHash("sha256").update(fs.readFileSync(sessionPath)).digest("hex") !== sourceSha256) {
  throw new Error("语料来源在读取期间改变");
}
fs.mkdirSync(outputDir, { recursive: true });
fs.writeFileSync(path.join(outputDir, "corpus.json"), JSON.stringify({ version: 1, sourceSessionId: session.id,
  sourceSha256, cases }, null, 2) + "\n", { encoding: "utf8", flag: "wx" });
console.log(JSON.stringify({ outputDir, sourceSha256, cases: cases.map((item) => ({ id: item.id,
  turns: item.turns.length, endUserMessageId: item.turns.at(-1).userMessageId })) }));
