// @vitest-environment jsdom
import React, { act, createElement } from "react";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "./App";
import MusicPlayer from "./components/MusicPlayer";
import type { MusicPlayerProps } from "./types";
const playerCss = readFileSync(resolve(__dirname, "player.css"), "utf8");

describe("music window interactions", () => {
  let host: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    vi.stubGlobal("React", React);
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.stubGlobal("music", undefined);
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
  });

  it("places no-drag window controls after the empty-state drag region", async () => {
    await act(async () => root.render(createElement(App)));
    const empty = host.querySelector(".mp-not-ready")!;
    const chrome = host.querySelector(".mp-window-chrome")!;
    expect(empty).not.toBeNull();
    expect(chrome).not.toBeNull();
    expect(empty.compareDocumentPosition(chrome) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);
    expect(chrome.querySelector('button[title="关闭"]')).not.toBeNull();
    expect(playerCss).toMatch(/\.mp-not-ready\s*\{[^}]*-webkit-app-region:\s*drag;/);
    expect(playerCss).toMatch(/\.mp-window-chrome\s*\{[^}]*-webkit-app-region:\s*no-drag;/);
  });

  it("scrolls overflowing playlists with the mouse wheel without changing selection or playback", async () => {
    const props: MusicPlayerProps = {
      state: { currentTrack: null, isPlaying: false, positionMs: 0, durationMs: 0, volume: 70,
        isMuted: false, queue: [], queueIndex: -1, playbackMode: "off", isLoading: false },
      actions: { playTrack: vi.fn(), togglePlayPause: vi.fn(), next: vi.fn(), prev: vi.fn(), seek: vi.fn(),
        setVolume: vi.fn(), toggleMute: vi.fn(), addToQueue: vi.fn(), removeFromQueue: vi.fn(),
        loadPlaylist: vi.fn(), cycleMode: vi.fn(), toggleFavorite: vi.fn() },
      playlists: Array.from({ length: 12 }, (_, i) => ({ id: String(i), originalId: String(i), name: `歌单${i}`, tracks: [] })),
      activePlaylistId: "0", onSelectPlaylist: vi.fn(), modeSet: "online", searchResults: [], isSearching: false, onSearch: vi.fn(),
    };
    await act(async () => root.render(createElement(MusicPlayer, props)));
    const strip = host.querySelector<HTMLElement>(".mp-playlists")!;
    Object.defineProperties(strip, { scrollWidth: { value: 1200 }, clientWidth: { value: 400 } });
    await act(async () => { strip.dispatchEvent(new WheelEvent("wheel", { bubbles: true, deltaY: 120 })); });
    expect(strip.scrollLeft).toBe(120);
    await act(async () => { strip.dispatchEvent(new WheelEvent("wheel", { bubbles: true, deltaX: 80, deltaY: 10 })); });
    expect(strip.scrollLeft).toBe(120);
    expect(props.onSelectPlaylist).not.toHaveBeenCalled();
    expect(props.actions.playTrack).not.toHaveBeenCalled();
    expect(playerCss).toMatch(/\.mp-header::after\s*\{[^}]*flex:\s*1 0 48px;/);
    await act(async () => strip.querySelectorAll<HTMLButtonElement>("button")[11].click());
    expect(props.onSelectPlaylist).toHaveBeenCalledWith(props.playlists[11]);
  });
});
