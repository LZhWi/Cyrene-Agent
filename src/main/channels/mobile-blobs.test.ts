import { describe, it, expect, vi, beforeEach } from "vitest";
import * as os from "os";
import * as path from "path";
import * as fs from "fs";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cyrene-blobs-"));
vi.mock("../runtime/runtime-paths", () => ({ getUserDataDir: () => tmp }));

import { saveBlob, resolveBlobPath, mimeToExt, extToMime } from "./mobile-blobs";

describe("mobile-blobs", () => {
  it("saves content-addressed and is idempotent", () => {
    const buf = Buffer.from("hello-image-bytes");
    const a = saveBlob(buf, "image/png");
    const b = saveBlob(buf, "image/png");
    expect(a.hash).toBe(b.hash);
    expect(a.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(fs.existsSync(resolveBlobPath(a.hash)!)).toBe(true);
  });

  it("maps mime<->ext", () => {
    expect(mimeToExt("image/jpeg")).toBe("jpg");
    expect(extToMime("png")).toBe("image/png");
  });

  it("rejects path traversal in hash", () => {
    expect(resolveBlobPath("../evil")).toBeNull();
  });
});
