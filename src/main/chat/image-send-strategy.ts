import { getCapabilityOrOpenAI } from "../orchestrator/vendors/capabilities";
import { resolveTransport } from "../orchestrator/vendors/transport-detector";
import type { Transport } from "../orchestrator/vendors/types";

export type ImageSendStrategy = { mode: "direct" } | { mode: "caption" };

export interface ImageSendStrategyConfig {
  provider: string;
  baseUrl: string;
  model: string;
  apiKey: string;
  explicitTransport?: Transport | "auto";
  vision?: {
    baseUrl: string;
    model: string;
    apiKey: string;
  } | null;
}

function normalizeBaseUrl(value: string): string {
  return value.trim().replace(/\/+$/, "");
}

function isSameMainAndVisionConfig(config: ImageSendStrategyConfig): boolean {
  const vision = config.vision;
  if (!vision) return false;
  return (
    normalizeBaseUrl(config.baseUrl) === normalizeBaseUrl(vision.baseUrl)
    && config.model.trim() === vision.model.trim()
    && config.apiKey.trim() === vision.apiKey.trim()
  );
}

export function decideImageSendStrategy(config: ImageSendStrategyConfig): ImageSendStrategy {
  const transport = resolveTransport({
    baseUrl: config.baseUrl,
    explicitTransport: config.explicitTransport,
    provider: config.provider,
  });
  if (transport !== "openai") return { mode: "caption" };

  const capability = getCapabilityOrOpenAI(config.provider);
  if (capability.supportsVision || isSameMainAndVisionConfig(config)) {
    return { mode: "direct" };
  }

  return { mode: "caption" };
}
