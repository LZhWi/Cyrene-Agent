import type { LyricLine, Playlist, Track } from "./types";

function makeLyrics(seed: string[]): LyricLine[] {
  const lines: LyricLine[] = [{ timeMs: 0, text: "纯音乐 / 歌词加载示例" }];
  let t = 8000;
  for (const text of seed) {
    lines.push({ timeMs: t, text });
    t += 6000;
  }
  return lines;
}

const sampleLyrics = makeLyrics([
  "夜色慢慢铺开在城市上空",
  "霓虹把影子拉得很长",
  "耳机里循环着同一段旋律",
  "像有人在耳边轻声唱",
  "风吹过站台 带走末班车的光",
  "我把心事折成纸飞机放",
  "如果明天还会记得今天",
  "就把这一刻 轻轻收藏",
  "灯火一盏一盏熄灭",
  "而歌还没有唱完",
  "就让节奏陪我走过",
  "这条安静的街 一直到天亮",
]);

function cover(seed: string): string {
  return `https://picsum.photos/seed/${seed}/400/400`;
}

function hex(seed: number): string {
  return seed.toString(16).padStart(32, "0");
}

export const MOCK_TRACKS: Track[] = [
  {
    encryptedId: hex(101),
    originalId: "347230",
    name: "夜航星",
    artists: ["不才"],
    album: "夜航星",
    coverImgUrl: cover("cyrene-night-flight"),
    durationMs: 264000,
    visible: true,
    isFavorite: true,
    lyrics: sampleLyrics,
  },
  {
    encryptedId: hex(102),
    originalId: "441116",
    name: "溯 Reverse",
    artists: ["马吟吟"],
    album: "溯",
    coverImgUrl: cover("cyrene-reverse"),
    durationMs: 231000,
    visible: true,
    lyrics: sampleLyrics,
  },
  {
    encryptedId: hex(103),
    originalId: "525063",
    name: "所念皆星河",
    artists: ["CMJ"],
    album: "所念皆星河",
    coverImgUrl: cover("cyrene-galaxy"),
    durationMs: 198000,
    visible: true,
    lyrics: sampleLyrics,
  },
  {
    encryptedId: hex(104),
    originalId: "298101",
    name: "城南花已开",
    artists: ["三亩地"],
    album: "城南花已开",
    coverImgUrl: cover("cyrene-south-city"),
    durationMs: 245000,
    visible: true,
    isFavorite: true,
    lyrics: sampleLyrics,
  },
  {
    encryptedId: hex(105),
    originalId: "662123",
    name: "日光 (Sunny)",
    artists: ["pikasonic"],
    album: "日光",
    coverImgUrl: cover("cyrene-sunny"),
    durationMs: 187000,
    visible: true,
    lyrics: sampleLyrics,
  },
  {
    encryptedId: hex(106),
    originalId: "770144",
    name: "Windy Hill",
    artists: ["羽肿"],
    album: "Windy Hill",
    coverImgUrl: cover("cyrene-windy-hill"),
    durationMs: 302000,
    visible: true,
    lyrics: sampleLyrics,
  },
  {
    encryptedId: hex(107),
    originalId: "550311",
    name: "晚风",
    artists: ["白日密语"],
    album: "晚风",
    coverImgUrl: cover("cyrene-commute"),
    durationMs: 213000,
    visible: true,
    lyrics: sampleLyrics,
  },
  {
    encryptedId: hex(108),
    originalId: "880211",
    name: "星港",
    artists: ["M2U"],
    album: "星港",
    durationMs: 176000,
    visible: true,
    lyrics: sampleLyrics,
  },
  {
    encryptedId: hex(109),
    originalId: "990501",
    name: "雾都夜话",
    artists: ["房东的猫", "Jam"],
    album: "雾都夜话",
    coverImgUrl: cover("cyrene-fog-city"),
    durationMs: 256000,
    visible: false,
    lyrics: sampleLyrics,
  },
  {
    encryptedId: hex(110),
    originalId: "120550",
    name: "山海之外",
    artists: ["夏日入侵企画"],
    album: "山海之外",
    coverImgUrl: cover("cyrene-beyond"),
    durationMs: 224000,
    visible: true,
    lyrics: sampleLyrics,
  },
];

function pick(ids: string[]): Track[] {
  return MOCK_TRACKS.filter((t) => ids.includes(t.originalId));
}

function makePlaylist(
  originalId: string,
  name: string,
  ids: string[],
  coverSeed: string,
): Playlist {
  const tracks = pick(ids);
  return {
    originalId,
    name,
    coverImgUrl: cover(coverSeed),
    trackCount: tracks.length,
    tracks,
  };
}

export const MOCK_PLAYLISTS: Playlist[] = [
  makePlaylist(
    "pl-all",
    "全部歌曲",
    MOCK_TRACKS.map((t) => t.originalId),
    "cyrene-pl-all",
  ),
  makePlaylist(
    "pl-fav",
    "我喜欢的音乐",
    ["347230", "298101"],
    "cyrene-pl-fav",
  ),
  makePlaylist(
    "pl-chill",
    "深夜学习",
    ["525063", "298101", "770144"],
    "cyrene-pl-chill",
  ),
  makePlaylist(
    "pl-drive",
    "通勤路上",
    ["550311", "990501", "441116"],
    "cyrene-pl-drive",
  ),
  makePlaylist(
    "pl-energy",
    "运动醒脑",
    ["662123", "120550", "880211"],
    "cyrene-pl-energy",
  ),
];

export function searchMockTracks(query: string): Track[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  return MOCK_TRACKS.filter(
    (t) =>
      t.name.toLowerCase().includes(q) ||
      (t.album ?? "").toLowerCase().includes(q) ||
      t.artists.some((a) => a.toLowerCase().includes(q)),
  );
}
