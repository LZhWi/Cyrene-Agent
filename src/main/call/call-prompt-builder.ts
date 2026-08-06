import type { SceneIndex } from "../scene-embedder";
import { buildAlwaysOnContext, buildMemoryInjection } from "../orchestrator";
import { getSceneEmbeddingProvider } from "../rag/embedding";
import { buildToneInjection } from "../orchestrator/tone-injector";
import { buildSkillCatalog, skillRegistry } from "../skills";
import { resolveSlashActivation } from "../skills/slash-activation";
import { resolveChatContextTimezone } from "../chat-time-context";
import { getDateLocale } from "../locale-context";
import { loadPromptFile } from "../prompts/prompt-loader";
import { loadUserProfile } from "../settings-store";

export interface CallPromptBuilderContext {
  /** 场景嵌入索引，由主进程在后台刷新，可能为 null。 */
  sceneEmbeddingIndex: SceneIndex | null;
}

/**
 * 构建通话（Call）模式专用 system prompt。
 * 包含时间日期、常驻上下文、记忆注入、phone 人设文件、skill 约束、语气注入。
 * 注意：本函数会修改传入的 messages 数组以处理 /命令命中但未启用的情况。
 */
export async function buildCallSystemPrompt(
  ctx: CallPromptBuilderContext,
  userText: string,
  messages: Array<{ role: "user"; content: string }>,
): Promise<string> {
  // ① 时间日期（用用户时区，禁止直接喂未校验的 profile.timezone 给 Intl）
  const now = new Date();
  const userTz = resolveChatContextTimezone(loadUserProfile().timezone);
  const timeStr = `当前时间：${now.toLocaleDateString(getDateLocale(), { timeZone: userTz })} ${now.toLocaleTimeString(getDateLocale(), { hour: "2-digit", minute: "2-digit", timeZone: userTz })}`;

  // ② 常驻上下文（世界书 + L0/L1 画像）
  let alwaysOnContext = "";
  try { alwaysOnContext = await buildAlwaysOnContext(userText, messages); } catch { /* ignore */ }

  // ③ 记忆注入
  let memoryInjection = "";
  try { memoryInjection = await buildMemoryInjection(userText); } catch { /* ignore */ }

  // ④ 通话专用人设 prompt
  const phoneParts: string[] = [];
  const phoneSystem = loadPromptFile("phone_system.md");
  if (phoneSystem) phoneParts.push(phoneSystem);
  const phoneIdentity = loadPromptFile("phone_identity.md");
  if (phoneIdentity) phoneParts.push(phoneIdentity);
  const soul = loadPromptFile("soul.md");
  if (soul) phoneParts.push(soul);
  const canon = loadPromptFile("canon_quotes.md");
  if (canon) phoneParts.push(canon);
  const phoneStyle = loadPromptFile("phone_style.md");
  if (phoneStyle) phoneParts.push(phoneStyle);
  const phonePrompt = phoneParts.join("\n\n---\n\n");

  // ⑤ Skill 约束（resolveSlashActivation 会原地修改 messages）
  const skillCatalog = buildSkillCatalog(skillRegistry.getEnabled());
  const skillActivation = resolveSlashActivation(messages);

  // ⑥ 语气注入
  let toneInjection = "";
  const sceneProvider = getSceneEmbeddingProvider();
  if (sceneProvider && ctx.sceneEmbeddingIndex) {
    try {
      toneInjection = await buildToneInjection(userText, messages, sceneProvider, ctx.sceneEmbeddingIndex);
    } catch { /* ignore */ }
  }

  return timeStr + "\n\n" +
    (alwaysOnContext ? alwaysOnContext + "\n\n" : "") +
    (memoryInjection ? memoryInjection + "\n\n" : "") +
    phonePrompt +
    (skillCatalog ? "\n\n---\n\n" + skillCatalog : "") +
    skillActivation +
    toneInjection;
}
