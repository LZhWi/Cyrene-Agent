export type ImageSendStrategy = { mode: "direct" } | { mode: "caption" };

export interface ImageSendStrategyConfig {
  /** 聊天图片发送方式。true 时图片直发主模型（direct），用户手动控制。 */
  multimodal: boolean;
  vision?: {
    baseUrl: string;
    model: string;
    apiKey: string;
  } | null;
}

/**
 * 裁决图片发送策略。用户的多模态开关是唯一裁决者：
 * - multimodal=true  -> direct（图片随 message 直发主模型）
 * - multimodal=false -> caption（走用户选择的视觉任务后端分析，或无法看图）
 */
export function decideImageSendStrategy(config: ImageSendStrategyConfig): ImageSendStrategy {
  if (config.multimodal) return { mode: "direct" };
  return { mode: "caption" };
}
