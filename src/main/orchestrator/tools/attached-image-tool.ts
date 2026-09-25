import * as path from "path";
import { validateCaptionImagePath, type ValidCaptionImage } from "../../chat/image-caption";
import { loadVisionConfig } from "../../settings/model-settings";
import { captionImageWithRetryAndFallback, type VisionConfig, type VisionImage } from "../vision-captioner";
import { toolRegistry, type ToolDefinition } from "./registry/tool-registry";

interface AttachedImageToolDeps {
  validateImage(filePath: unknown): ValidCaptionImage;
  loadVisionConfig(): VisionConfig | null;
  analyze(image: VisionImage, focus: string, config: VisionConfig, signal?: AbortSignal): Promise<string>;
}

const defaultDeps: AttachedImageToolDeps = {
  validateImage: validateCaptionImagePath,
  loadVisionConfig,
  analyze: (image, focus, config, signal) => captionImageWithRetryAndFallback(image, focus, config, signal),
};

export function createAttachedImageTool(deps: AttachedImageToolDeps = defaultDeps): ToolDefinition {
  return {
    id: "ask_attached_image",
    name: "追问用户图片",
    description: "用户本轮发送了图片且已有通用视觉描述时，用 focus 指定要进一步看清的细节；只能查看本轮附件。",
    catalogHint: "针对用户本轮图片追问一个具体视觉细节",
    enabled: true,
    risk: "safe",
    modes: ["chat"],
    chatBuiltin: true,
    effectKind: "read",
    isConcurrencySafe: () => true,
    needsContext: true,
    inputSchema: {
      type: "object",
      properties: {
        focus: {
          type: "string",
          description: "必填。希望视觉模型进一步查看的具体方面，使用开放式问题。",
        },
        name: {
          type: "string",
          description: "可选。多图时按文件名选择；缺省查看最后一张。",
        },
      },
      required: ["focus"],
    },
    execute: async (args, context) => {
      const focus = typeof args.focus === "string" ? args.focus.trim() : "";
      if (!focus) return "[错误] 缺少 focus 参数。";

      const images = context?.imageAttachments ?? [];
      if (images.length === 0) return "[错误] 用户本轮没有发送可追问的图片。";

      const requestedName = typeof args.name === "string" ? args.name.trim().toLowerCase() : "";
      const selected = requestedName
        ? images.find((image) => image.name.toLowerCase().includes(requestedName)
          || path.basename(image.filePath).toLowerCase().includes(requestedName))
        : images[images.length - 1];
      if (!selected) return "[错误] 没有找到指定的本轮图片。";

      const validated = deps.validateImage(selected.filePath);
      if (!validated.ok) return "[错误] 图片读取失败：" + validated.error;
      const config = context && Object.prototype.hasOwnProperty.call(context, "visionConfig")
        ? context.visionConfig
        : deps.loadVisionConfig();
      if (!config) return "[错误·配置] 未启用视觉能力。请先在设置中配置视觉模型。";

      return deps.analyze(
        { base64: validated.buffer.toString("base64"), mime: validated.mime },
        focus,
        config,
        context?.signal,
      );
    },
  };
}

export function registerAttachedImageTool(): void {
  toolRegistry.register(createAttachedImageTool());
}
