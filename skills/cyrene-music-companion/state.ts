import type { MusicCandidate, PresentedCandidateSet, SelectionResolution } from "./contracts";

const DEFAULT_TTL_MS = 30 * 60_000;
const DEFAULT_MAX_CONVERSATIONS = 100;
const ORDINALS: Record<string, number> = {
  一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10,
};

function compact(value: string): string {
  return value.toLocaleLowerCase().replace(/[\s《》「」『』“”"'，。！？、,.!?：:；;（）()]/g, "");
}

function ordinalIndex(utterance: string, length: number): number | null {
  if (/最后一首|最后那首/.test(utterance)) return length - 1;
  const match = utterance.match(/第\s*([一二三四五六七八九十]|\d+)\s*首/);
  if (!match) return null;
  const oneBased = /^\d+$/.test(match[1]) ? Number(match[1]) : ORDINALS[match[1]];
  return Number.isInteger(oneBased) && oneBased >= 1 && oneBased <= length ? oneBased - 1 : null;
}

function uniqueOrAmbiguous(
  matches: MusicCandidate[],
  setId: string,
  reason: "name" | "artist",
): SelectionResolution | null {
  if (matches.length === 0) return null;
  if (matches.length > 1) return { kind: "ambiguous", candidates: matches };
  return { kind: "resolved", reason, setId, track: matches[0] };
}

export class CandidateStateStore {
  private readonly sets = new Map<string, PresentedCandidateSet>();

  constructor(
    private readonly now: () => number = Date.now,
    private readonly random: () => number = Math.random,
    private readonly ttlMs = DEFAULT_TTL_MS,
    private readonly maxConversations = DEFAULT_MAX_CONVERSATIONS,
  ) {}

  record(set: PresentedCandidateSet): void {
    if (!set.conversationId || !set.setId || set.tracks.length === 0) return;
    const stored: PresentedCandidateSet = {
      ...set,
      expiresAt: Math.min(set.expiresAt, this.now() + this.ttlMs),
      tracks: set.tracks.map((track) => ({ ...track, artists: [...track.artists] })),
    };
    this.sets.delete(set.conversationId);
    this.sets.set(set.conversationId, stored);
    while (this.sets.size > this.maxConversations) {
      const oldest = this.sets.keys().next().value as string | undefined;
      if (!oldest) break;
      this.sets.delete(oldest);
    }
  }

  resolve(conversationId: string, utterance: string): SelectionResolution {
    const set = this.sets.get(conversationId);
    if (!set) return { kind: "not_found" };
    if (set.expiresAt <= this.now()) {
      this.sets.delete(conversationId);
      return { kind: "expired" };
    }
    const text = utterance.trim();
    if (!text) return { kind: "not_found" };

    if (/你(来)?挑(一首)?|你选(一首)?|随便(放|播|来)(一首)?|都可以|交给你/.test(text)) {
      const index = Math.min(set.tracks.length - 1, Math.floor(this.random() * set.tracks.length));
      return { kind: "resolved", reason: "delegate", setId: set.setId, track: set.tracks[index] };
    }

    const ordinal = ordinalIndex(text, set.tracks.length);
    if (ordinal !== null) {
      return { kind: "resolved", reason: "ordinal", setId: set.setId, track: set.tracks[ordinal] };
    }

    const normalized = compact(text);
    const byName = uniqueOrAmbiguous(
      set.tracks.filter((track) => normalized.includes(compact(track.name))),
      set.setId,
      "name",
    );
    if (byName) return byName;

    const byArtist = uniqueOrAmbiguous(
      set.tracks.filter((track) => track.artists.some((artist) => normalized.includes(compact(artist)))),
      set.setId,
      "artist",
    );
    return byArtist ?? { kind: "not_found" };
  }

  clear(conversationId?: string): void {
    if (conversationId) this.sets.delete(conversationId);
    else this.sets.clear();
  }
}
