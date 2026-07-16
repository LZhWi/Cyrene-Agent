interface Candidate {
  trackId: string;
  name: string;
  artists: string[];
  album?: string;
  coverUrl?: string;
}

interface PresentedSet {
  conversationId: string;
  setId: string;
  expiresAt: number;
  tracks: Candidate[];
}

interface CapabilityState {
  skillEnabled: boolean;
  backendAvailable: boolean;
  enabledTools: string[];
}

type Resolution =
  | { kind: "resolved"; reason: string; setId: string; track: Candidate }
  | { kind: "ambiguous"; candidates: Candidate[] }
  | { kind: "not_found" }
  | { kind: "expired" };

export interface MusicCompanionRuntimeLike {
  shouldInject(capabilities: CapabilityState): boolean;
  recordPresented(set: PresentedSet): void;
  resolveSelection(conversationId: string, utterance: string): Resolution;
  clear(conversationId?: string): void;
}

let runtime: MusicCompanionRuntimeLike | null = null;
let capabilityProbe: (() => CapabilityState) | null = null;

export function configureMusicCompanionHost(
  nextRuntime: MusicCompanionRuntimeLike,
  nextCapabilityProbe: () => CapabilityState,
): void {
  runtime = nextRuntime;
  capabilityProbe = nextCapabilityProbe;
}

export function loadMusicCompanionHost(
  compiledEntryPath: string,
  nextCapabilityProbe: () => CapabilityState,
): void {
  // The compound Skill is compiled separately so its source remains inside
  // skills/cyrene-music-companion rather than being copied into MusicService.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const module = require(compiledEntryPath) as { createMusicCompanionRuntime?: () => MusicCompanionRuntimeLike };
  if (typeof module.createMusicCompanionRuntime !== "function") {
    throw new Error("E_MUSIC_COMPANION_ENTRY_INVALID");
  }
  configureMusicCompanionHost(module.createMusicCompanionRuntime(), nextCapabilityProbe);
}

export function clearMusicCompanionHost(): void {
  runtime?.clear();
  runtime = null;
  capabilityProbe = null;
}

export function isMusicCompanionAvailable(): boolean {
  if (!runtime || !capabilityProbe) return false;
  return runtime.shouldInject(capabilityProbe());
}

export function recordMusicCompanionPresentation(set: PresentedSet): void {
  runtime?.recordPresented(set);
}

export function buildMusicCompanionContext(conversationId: string, utterance: string): string {
  if (!runtime || !isMusicCompanionAvailable()) return "";
  const result = runtime.resolveSelection(conversationId, utterance);
  if (result.kind === "resolved") {
    return [
      "[近期音乐候选的确定性解析]",
      `用户已明确授权播放候选：${result.track.name} - ${result.track.artists.join("/")}，trackId=${result.track.trackId}。`,
      `解析依据：${result.reason}，setId=${result.setId}。`,
      "只允许使用上述真实 trackId 调用 music_play_track；不要重新猜测或搜索替换。",
    ].join("\n");
  }
  if (result.kind === "ambiguous") {
    return "[近期音乐候选解析] 用户的选择存在歧义，不要播放。请根据这些真实候选询问版本："
      + result.candidates.map((track) => `${track.name}-${track.artists.join("/")}`).join("；");
  }
  if (result.kind === "expired") {
    return "[近期音乐候选解析] 候选集合已过期，不要播放旧 ID；请告知用户并重新获取推荐或搜索。";
  }
  return "";
}
