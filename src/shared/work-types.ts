export type WorkMessageRole = "user" | "assistant" | "system";

export interface WorkAttachment {
  name: string;
  kind: "document" | "image" | "unsupported";
  status: "done" | "error";
}

export interface WorkRunAttachment extends WorkAttachment {
  content?: string;
  reason?: string;
}

export interface WorkMessage {
  id: string;
  role: WorkMessageRole;
  content: string;
  createdAt: number;
  attachments?: WorkAttachment[];
}

export type WorkPlanStepStatus = "pending" | "running" | "completed" | "failed" | "skipped";

export interface WorkPlanStep {
  id: string;
  objective: string;
  status: WorkPlanStepStatus;
  toolCallCount: number;
  error?: string;
}

export interface WorkPlan {
  id: string;
  goal: string;
  mode: "direct" | "plan";
  status: "running" | "awaiting_user" | "completed" | "failed" | "cancelled";
  steps: WorkPlanStep[];
  createdAt: number;
  updatedAt: number;
}

export interface WorkArtifact {
  id: string;
  name: string;
  path: string;
  createdAt: number;
}

export interface WorkSession {
  schemaVersion: 1;
  id: string;
  title: string;
  messages: WorkMessage[];
  plan?: WorkPlan;
  artifacts: WorkArtifact[];
  status: "idle" | "running" | "awaiting_user" | "completed" | "failed" | "cancelled";
  createdAt: number;
  updatedAt: number;
}

export interface WorkSessionMeta {
  id: string;
  title: string;
  status: WorkSession["status"];
  messageCount: number;
  createdAt: number;
  updatedAt: number;
}

export interface WorkModelSelection {
  provider: string;
  model: string;
}

export interface WorkProviderProfile {
  baseUrl: string;
  model: string;
  apiKey: string;
  displayName?: string;
  explicitTransport?: "openai" | "anthropic" | "auto";
  reasoning?: import("./reasoning").ReasoningPreference;
}

export interface WorkVisionModelConfig {
  syncWithMain: boolean;
  baseUrl: string;
  apiKey: string;
  model: string;
}

export interface WorkModelSettings extends WorkProviderProfile {
  schemaVersion: 2;
  provider: string;
  perProvider: Record<string, WorkProviderProfile>;
  vision?: WorkVisionModelConfig;
}

export type WorkRunEvent =
  | { type: "status"; status: WorkSession["status"]; text: string }
  | { type: "plan"; plan: WorkPlan }
  | { type: "tool_start"; toolId: string; label: string }
  | { type: "tool_end"; toolId: string; ok: boolean; summary: string }
  | { type: "message"; message: WorkMessage }
  | { type: "error"; message: string }
  | { type: "done"; sessionId: string };
