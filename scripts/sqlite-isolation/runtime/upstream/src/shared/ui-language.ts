/**
 * 界面语言（UI Language）取值与归一化。
 *
 * 只有翻译补齐的语种才进白名单；其余值（含历史配置里的 ja / ko）一律回落中文。
 * 主进程的 GeneralSettings 与渲染端的语言切换共用这份定义，避免两处口径不一致。
 */

export const UI_LANGUAGES = ["zh-CN", "en", "ja-JP"] as const;

export type UiLanguage = (typeof UI_LANGUAGES)[number];

export const UI_LANGUAGE_FALLBACK: UiLanguage = "zh-CN";

export function normalizeUiLanguage(value: unknown): UiLanguage {
  return UI_LANGUAGES.includes(value as UiLanguage) ? value as UiLanguage : UI_LANGUAGE_FALLBACK;
}