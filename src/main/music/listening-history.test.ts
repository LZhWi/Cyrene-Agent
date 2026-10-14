import { describe, expect, it } from "vitest";
import { createListeningHistory } from "./listening-history";
import type { ChatSession } from "../../shared/chat-types";
import type { PlaybackState } from "../../shared/music-types";

describe("listening history", () => {
  it("records advancing playback, groups tracks, freezes destination and respects deletion", () => {
    const session: ChatSession = { id: "chat", title: "Chat", mode: "chat", identityId: null, schemaVersion: 1, createdAt: 1, updatedAt: 1, messages: [] };
    let active = "chat", writes = 0;
    const record = createListeningHistory({ activeSessionId: () => active, getSession: id => id === "chat" ? session : null,
      save: (_id, message) => { writes++; session.messages = [structuredClone(message)]; } });
    const state: PlaybackState = { connected: true, loaded: true, paused: false, position: 1, duration: 100, volume: 50,
      track: { encryptedId: "a", name: "A", artists: ["Artist"] } };
    record({ ...state, paused: true }); record(state);
    expect(writes).toBe(0);
    record({ ...state, position: 2 }); record({ ...state, position: 3 });
    expect(writes).toBe(1);
    active = "work";
    const next = { ...state, track: { ...state.track!, encryptedId: "b", name: "B" } };
    record(next); record({ ...next, position: 2 });
    expect(session.messages[0].musicEvent?.tracks.map(t => t.name)).toEqual(["A", "B"]);
    session.messages = [];
    const third = { ...state, track: { ...state.track!, encryptedId: "c" } };
    record(third); record({ ...third, position: 2 });
    expect(writes).toBe(2);
    record({ ...state, loaded: false }); record(state); record({ ...state, position: 2 });
    expect(writes).toBe(2);
  });
});
