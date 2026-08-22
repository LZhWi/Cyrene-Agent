import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, describe, expect, it } from "vitest";
import { appendRotatingLogSync } from "./rotating-log";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("rotating log", () => {
  it("appends below the cap", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "cyrene-log-"));
    roots.push(root);
    const file = path.join(root, "app.log");
    appendRotatingLogSync(file, "first\n", 20);
    appendRotatingLogSync(file, "second\n", 20);
    expect(fs.readFileSync(file, "utf8")).toBe("first\nsecond\n");
    expect(fs.existsSync(`${file}.1`)).toBe(false);
  });

  it("keeps one recoverable previous generation when the cap is crossed", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "cyrene-log-"));
    roots.push(root);
    const file = path.join(root, "app.log");
    appendRotatingLogSync(file, "12345678", 10);
    appendRotatingLogSync(file, "abcd", 10);
    expect(fs.readFileSync(file, "utf8")).toBe("abcd");
    expect(fs.readFileSync(`${file}.1`, "utf8")).toBe("12345678");
  });
});
