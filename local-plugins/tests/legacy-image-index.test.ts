import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { migrateLegacyImageIndex } from "../plugins/companion-memory/src/legacy-image-index";
import type { ChatSession } from "../../src/shared/chat-types";

function fixture() {
  const session = { id: "s", messages: [{ id: "m", role: "user", attachments: [{ kind: "image", name: "photo", filePath: "original.png" }] }] } as ChatSession;
  const target = structuredClone(session); target.messages[0].attachments![0].filePath = "isolated.png";
  const row = { source: "chat_image", text: "图片 photo。画面内容：description", embedding: Array(64).fill(0.1), createdAt: 1,
    metadata: { sessionId: "s", turnId: "m", summary: "summary", imageKey: createHash("sha256").update("0\0original.png").digest("hex") } };
  return { session, target, row };
}
describe("legacy image index migration", () => {
  it("binds original identities after path remapping and is idempotent", () => {
    const { session, target, row } = fixture();
    const index = { version: 1 as const, entries: {} };
    const result = migrateLegacyImageIndex([session], [target], [row], index);
    expect(result.added).toBe(1); expect(result.sessions[0].messages[0].attachments![0].filePath).toBe("isolated.png");
    expect(result.index.entries["host-image:s:m:0"].embedding).toEqual(row.embedding);
    expect(migrateLegacyImageIndex([session], result.sessions, [row], result.index).added).toBe(0);
    expect(index.entries).toEqual({}); expect(target.messages[0].attachments![0]).not.toHaveProperty("visualIndexSummary");
  });
  it("preserves changed target descriptions", () => {
    const { session, target, row } = fixture();
    Object.assign(target.messages[0].attachments![0], { visualIndexCaption: "target description" });
    const result = migrateLegacyImageIndex([session], [target], [row], { version: 1, entries: {} });
    expect(result.conflicts).toHaveLength(1); expect(result.added).toBe(0); expect(result.sessions).toEqual([target]);
    const replaced = migrateLegacyImageIndex([session], [target], [row], { version: 1, entries: {} }, { preferSource: true });
    expect(replaced.conflicts).toEqual([]);
    expect(replaced.sessions[0].messages[0].attachments![0]).toMatchObject({ visualIndexCaption: "description", visualIndexSummary: "summary" });
    expect(replaced.index.entries["host-image:s:m:0"].embedding).toEqual(row.embedding);
  });
  it("rejects duplicate sources and incompatible vector dimensions without altering inputs", () => {
    const { session, target, row } = fixture();
    expect(() => migrateLegacyImageIndex([session], [target], [row, row], { version: 1, entries: {} })).toThrow("重复");
    expect(() => migrateLegacyImageIndex([session], [target], [row], { version: 1, entries: { old: { text: "old", embedding: Array(128).fill(0.2) } } })).toThrow("维度");
    expect(target.messages[0].attachments![0]).not.toHaveProperty("visualIndexSummary");
  });
});
