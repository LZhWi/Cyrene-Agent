/**
 * 设置窗口（settings）的 i18n 入口。
 *
 * - 该目录专属于 settings 窗口：未来改 settings 文案只翻
 *   ./zh-CN.json，不必翻其他窗口。
 * - 复用 src/renderer/i18n-runtime/ 的通用 i18next 工具，避免重复 init 代码。
 */
import { initWindowI18n } from "../../i18n-runtime";
import zhCN from "./zh-CN.json";
import en from "./en.json";
import chatZhCN from "../../react/i18n/zh-CN.json";
import chatEn from "../../react/i18n/en.json";

initWindowI18n({
  resources: {
    en: { translation: { ...chatEn, ...en } },
    "zh-CN": { translation: { ...chatZhCN, ...zhCN } },
  },
  fallbackLng: "zh-CN",
  lng: "zh-CN",
});

export { t, useTranslation, setLocale, subscribeLocaleChanged, applyTranslations } from "../../i18n-runtime";
