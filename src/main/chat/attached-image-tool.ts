// ask_attached_image 工具 — 用户发图流程与屏幕观察流程对齐的一环。
// 通用描述注入（agent-input 的【图片视觉信息】）≈ 周期观测注入；本工具 ≈ 屏幕观察的
// focus 旁路：LLM 填 focus 决定 VLM 重点关注图片的哪些方面，照原图回答、不写任何缓存。
// 仅 caption 模式有登记（direct 模式主模型直接看原图，无需 VLM 追问）。

import * as path from "path";
import { toolRegistry, type ToolDefinition } from "../orchestrator/tool-registry";
import type { VisionConfig } from "../orchestrator/vision-captioner";
import { analyzeScreenFocused } from "../screen-monitor/vlm-analyzer";
import { getTurnAttachedImages, validateCaptionImagePath } from "./image-caption";

const LOG_PREFIX = "[AttachedImage]";

// 视觉模型配置获取器（懒加载规避循环依赖，index.ts 启动时注入，与 screen-monitor-tool 同款）
let visionConfigGetter: (() => VisionConfig | null) | null = null;

/** index.ts 启动时调用，注入视觉模型配置获取器。 */
export function setAttachedImageConfigGetter(getter: () => VisionConfig | null): void {
  visionConfigGetter = getter;
}

/** 注册 ask_attached_image 工具到 tool-registry。 */
export function registerAttachedImageTool(): void {
  const tool: ToolDefinition = {
    id: "ask_attached_image",
    name: "追问用户图片",
    description: "用户刚发送了图片（已提供通用视觉信息）。需要了解图片某个方面的细节时调用，用 focus 指定想看清的内容（开放式问法），视觉模型会照图片回答；看不到时会如实说看不出来。",
    enabled: true,
    risk: "safe",
    inputSchema: {
      type: "object",
      properties: {
        focus: {
          type: "string",
          description: "必填。关于用户所发图片内容的开放式问题（用「是什么样/内容是什么」式问法，避免「是不是…」的是非问句）。",
        },
        name: {
          type: "string",
          description: "可选。要追问的图片文件名（用户发了多张图时按文件名匹配）；默认看最后一张。",
        },
      },
      required: ["focus"],
    },
    execute: async (args) => {
      const focus = typeof args?.focus === "string" ? args.focus.trim() : "";
      if (!focus) return "[错误] 缺少 focus 参数。";
      const images = getTurnAttachedImages();
      if (images.length === 0) return "[错误] 用户当轮没有发送可追问的图片。";
      const name = typeof args?.name === "string" ? args.name.trim() : "";
      const filePath = (name && images.find((p) => path.basename(p).includes(name))) || images[images.length - 1];
      const validated = validateCaptionImagePath(filePath);
      if (!validated.ok) return "[错误] 图片读取失败：" + validated.error;
      const config = visionConfigGetter?.();
      if (!config) return "[错误] 未配置视觉模型，无法分析图片。请在设置里配置视觉模型。";
      const answer = await analyzeScreenFocused(
        { base64: validated.buffer.toString("base64"), mime: validated.mime, width: 0, height: 0 },
        config,
        focus,
        "图片",
      );
      console.log(LOG_PREFIX, "聚焦追问完成:", answer.slice(0, 80));
      return answer;
    },
  };

  toolRegistry.register(tool);
  console.log(LOG_PREFIX, "已注册工具: ask_attached_image");
}
