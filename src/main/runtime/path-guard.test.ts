import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { assertSafeFileStem, resolvePathInside } from "./path-guard";

describe("path guard", () => {
  it.each(["..", ".", "../outside", "a/b", "a\\b", " CON", "CON", "NUL.txt", "id ", ""])(
    "rejects an unsafe external file stem: %j",
    (value) => expect(() => assertSafeFileStem(value, "session id")).toThrow(/E_INVALID_FILE_STEM/),
  );

  it("accepts generated and channel-style stems", () => {
    expect(assertSafeFileStem("550e8400-e29b-41d4-a716-446655440000")).toBe("550e8400-e29b-41d4-a716-446655440000");
    expect(assertSafeFileStem("channel_wechat_e72a9d")).toBe("channel_wechat_e72a9d");
  });

  it("keeps a missing leaf under the configured root and rejects lexical traversal", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "cyrene-path-guard-"));
    expect(resolvePathInside(root, "sessions", "id.json")).toBe(path.resolve(root, "sessions", "id.json"));
    expect(() => resolvePathInside(root, "..", "outside.json")).toThrow(/E_PATH_OUTSIDE_ROOT/);
  });
});
