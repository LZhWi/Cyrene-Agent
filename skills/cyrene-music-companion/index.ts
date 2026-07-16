import manifest from "./manifest.json";
import { CandidateStateStore } from "./state";
import type { MusicCompanionRuntime } from "./contracts";

export interface MusicCompanionOptions {
  now?: () => number;
  random?: () => number;
  ttlMs?: number;
  maxConversations?: number;
}

export function createMusicCompanionRuntime(options: MusicCompanionOptions = {}): MusicCompanionRuntime {
  const state = new CandidateStateStore(
    options.now,
    options.random,
    options.ttlMs,
    options.maxConversations,
  );
  return {
    shouldInject: (capabilities) => {
      if (!capabilities.skillEnabled || !capabilities.backendAvailable) return false;
      const enabled = new Set(capabilities.enabledTools);
      return manifest.dependencies.every((toolId) => enabled.has(toolId));
    },
    recordPresented: (set) => state.record(set),
    resolveSelection: (conversationId, utterance) => state.resolve(conversationId, utterance),
    clear: (conversationId) => state.clear(conversationId),
  };
}

export type {
  MusicCandidate,
  MusicCapabilityState,
  MusicCompanionRuntime,
  PresentedCandidateSet,
  SelectionResolution,
} from "./contracts";
