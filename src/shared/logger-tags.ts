/**
 * Canonical tag names used by the logger.
 *
 * Tags are 16-character columns. If a new tag exceeds that, it gets truncated
 * in log output, so keep names short.
 */
export const LogTag = {
  Runtime: "Runtime",
  Electron: "Electron",
  BuiltinTools: "BuiltinTools",
  FsTools: "FsTools",
  LifeTools: "LifeTools",
  Skills: "Skills",
  SkillTools: "SkillTools",
  GameBot: "GameBot",
  MCP: "MCP",
  Permission: "Permission",
  Cyrene: "Cyrene",
  Worldbook: "Worldbook",
  EntityGraph: "EntityGraph",
  RAG: "RAG",
  Reranker: "Reranker",
  InboundServer: "InboundServer",
  Channels: "Channels",
  AgUiBridge: "AgUiBridge",
  Call: "Call",
  ASR: "ASR",
  TTS: "TTS",
  Proactive: "Proactive",
  Music: "Music",
  Work: "Work",
  SocialContext: "SocialContext",
  Memory: "Memory",
  Scheduler: "Scheduler",
  Opener: "Opener",
  Orchestrator: "Orchestrator",
} as const;

export type LogTagKey = keyof typeof LogTag;
