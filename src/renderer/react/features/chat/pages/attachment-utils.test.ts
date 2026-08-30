import { describe, expect, it } from "vitest";
import { arrayBufferToBase64, containsFiles } from "./attachment-utils";

describe("chat attachment utilities", () => {
  it("encodes an array buffer as base64", () => {
    expect(arrayBufferToBase64(new Uint8Array([67, 121, 114, 101, 110, 101]).buffer)).toBe("Q3lyZW5l");
  });

  it("detects file drag payloads", () => {
    expect(containsFiles({ types: ["text/plain", "Files"] })).toBe(true);
    expect(containsFiles({ types: ["text/plain"] })).toBe(false);
  });
});
