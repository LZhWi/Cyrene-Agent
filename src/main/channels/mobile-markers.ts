// 手机端「内联标记」与 LLM 可读描述之间的转换。
// 标记形态：[sticker:<id>] / [image:<hash>]。history-log 存标记，喂 LLM 时转描述。
import { BUILT_IN_STICKER_DESCRIPTIONS } from "../sticker-descriptions";
import { loadUserStickerManifest } from "../sticker-storage";

const STICKER_RE = /\[sticker:([A-Za-z0-9_-]+)\]/g;
const IMAGE_RE = /\[image:([A-Za-z0-9_-]+)\]/g;

export function formatStickerMarker(id: string): string {
  return `[sticker:${id}]`;
}

export function formatImageMarker(hash: string): string {
  return `[image:${hash}]`;
}

/** 取一个 sticker id 的中文描述（内置 phrases / 用户 manifest phrases / 兜底空）。 */
export function getStickerDescription(id: string): string {
  const builtIn = BUILT_IN_STICKER_DESCRIPTIONS[id];
  if (builtIn && builtIn.phrases.length > 0) return builtIn.phrases.join("，");
  try {
    const meta = loadUserStickerManifest()[id];
    if (meta) return meta.phrases.length > 0 ? meta.phrases.join("，") : meta.description;
  } catch {
    /* ignore */
  }
  return "";
}

/** 从模型输出里剥离它「模仿」describeMarkersForLlm 写出的表情包/图片舞台指示。
 *  describeMarkersForLlm 会把标记转成「（我发送了表情包：…）/（用户发送表情包：…）」等
 *  带主语的描述喂进上下文；模型可能照抄自己过去这类输出。真正的表情包由嵌入匹配追加
 *  [sticker:id]、图片走真视觉，模型都不该把这段描述写进正文。
 *  这里覆盖「(我/你/用户/对方/她) 发送(了) 表情包/图片」的括号舞台指示（全/半角括号与冒号），
 *  但要求带「发送」动词，避免误删「这个表情包好可爱」之类正常表达。 */
export function stripStickerStageDirections(content: string): string {
  return content
    .replace(/[（(]\s*(?:我|你|用户|对方|她)?\s*发送?了?\s*表情包(?:\s*[:：][^）)]*)?\s*[）)]/g, "")
    .replace(/[（(]\s*(?:我|你|用户|对方|她)?\s*发送?了?\s*图片\s*[）)]/g, "")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

/** 把内容里的 [sticker:id]/[image:hash] 转成 LLM 可读文字。
 *  对齐 PC 的「带主语」纪律：根据消息角色标明是谁发的，
 *  避免无主语的「（发送表情包：…）」被模型当成自己可执行的动作而照抄。 */
export function describeMarkersForLlm(content: string, role: "user" | "assistant" = "user"): string {
  const stickerSubject = role === "assistant" ? "我发送了表情包" : "用户发送表情包";
  return content
    .replace(STICKER_RE, (_m, id: string) => {
      const desc = getStickerDescription(id);
      return desc ? `（${stickerSubject}：${desc}）` : `（${stickerSubject}）`;
    })
    .replace(IMAGE_RE, role === "assistant" ? "（我发送了图片）" : "（用户发送了图片）");
}
