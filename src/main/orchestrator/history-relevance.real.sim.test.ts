import * as fs from "fs";
import * as path from "path";
import { createHash } from "crypto";
import { describe, expect, it } from "vitest";
import { filterHistoryHitsByRelevance, HISTORY_MIN_RRF_SCORE } from "./history-tools";

const enabled = process.env.CYRENE_REAL_HISTORY_RELEVANCE_EVAL === "1";
const userDataDir = process.env.CYRENE_REAL_USER_DATA_DIR ?? "";

describe.skipIf(!enabled)("real-data isolated history relevance", () => {
  it("removes single-channel RRF tails while retaining the real top retrieval bands", () => {
    const logPath = path.join(userDataDir, "rag-data", "history-retrieval-v2-shadow.jsonl");
    const before = createHash("sha256").update(fs.readFileSync(logPath)).digest("hex");
    const records = fs.readFileSync(logPath, "utf8").trim().split(/\r?\n/).map((line) => JSON.parse(line) as {
      candidates?: Array<{ score?: number; createdAt?: number; preview?: string }>;
    });
    const rows = records.flatMap((record) => (record.candidates ?? []).flatMap((candidate) => (
      typeof candidate.score === "number"
        ? [{ text: candidate.preview ?? "", score: candidate.score, createdAt: candidate.createdAt ?? 0 }]
        : []
    )));
    expect(rows.length).toBeGreaterThan(20);
    expect(rows.some((item) => item.score < HISTORY_MIN_RRF_SCORE)).toBe(true);
    expect(rows.some((item) => item.score >= HISTORY_MIN_RRF_SCORE)).toBe(true);
    const retained = filterHistoryHitsByRelevance(rows, "rrf");
    expect(retained.every((item) => item.score >= HISTORY_MIN_RRF_SCORE)).toBe(true);
    for (const record of records) {
      const topFive = (record.candidates ?? []).slice(0, 5);
      expect(topFive.every((item) => typeof item.score === "number" && item.score >= HISTORY_MIN_RRF_SCORE)).toBe(true);
    }
    expect(createHash("sha256").update(fs.readFileSync(logPath)).digest("hex")).toBe(before);
  });
});
