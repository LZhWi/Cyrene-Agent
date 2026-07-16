export interface MusicCandidate {
  trackId: string;
  name: string;
  artists: string[];
  album?: string;
  coverUrl?: string;
}

export interface PresentedCandidateSet {
  conversationId: string;
  setId: string;
  expiresAt: number;
  tracks: MusicCandidate[];
}

export interface MusicCapabilityState {
  skillEnabled: boolean;
  backendAvailable: boolean;
  enabledTools: string[];
}

export type SelectionResolution =
  | { kind: "resolved"; reason: "ordinal" | "name" | "artist" | "delegate"; setId: string; track: MusicCandidate }
  | { kind: "ambiguous"; candidates: MusicCandidate[] }
  | { kind: "not_found" }
  | { kind: "expired" };

export interface MusicCompanionRuntime {
  shouldInject(capabilities: MusicCapabilityState): boolean;
  recordPresented(set: PresentedCandidateSet): void;
  resolveSelection(conversationId: string, utterance: string): SelectionResolution;
  clear(conversationId?: string): void;
}
