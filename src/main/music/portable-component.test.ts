import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { rm } from "node:fs/promises";

import { resolvePortableMusicComponent } from "./portable-component";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function componentRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "cyrene-music-component-"));
  roots.push(root);
  return root;
}

describe("resolvePortableMusicComponent", () => {
  it("resolves a valid portable component entry", async () => {
    const root = await componentRoot();
    await writeFile(path.join(root, "cyrene-music.exe"), "portable");
    await writeFile(path.join(root, "manifest.json"), JSON.stringify({
      id: "cyrene-music",
      version: "1.0.0",
      platform: "win32",
      arch: "x64",
      entry: "cyrene-music.exe",
      protocolVersion: 1,
    }));

    await expect(resolvePortableMusicComponent(root, { platform: "win32", arch: "x64" }))
      .resolves.toEqual({
        command: path.join(root, "cyrene-music.exe"),
        args: [],
        cwd: root,
        version: "1.0.0",
      });
  });

  it("reports a missing component without leaking a filesystem error", async () => {
    const root = await componentRoot();
    await expect(resolvePortableMusicComponent(root, { platform: "win32", arch: "x64" }))
      .rejects.toThrow("E_MUSIC_COMPONENT_NOT_INSTALLED");
  });

  it("rejects an entry that escapes the component directory", async () => {
    const root = await componentRoot();
    await mkdir(path.join(root, "nested"));
    await writeFile(path.join(root, "manifest.json"), JSON.stringify({
      id: "cyrene-music",
      version: "1.0.0",
      platform: "win32",
      arch: "x64",
      entry: "../outside.exe",
      protocolVersion: 1,
    }));

    await expect(resolvePortableMusicComponent(root, { platform: "win32", arch: "x64" }))
      .rejects.toThrow("E_MUSIC_COMPONENT_INVALID");
  });

  it("rejects a component built for another architecture", async () => {
    const root = await componentRoot();
    await writeFile(path.join(root, "cyrene-music.exe"), "portable");
    await writeFile(path.join(root, "manifest.json"), JSON.stringify({
      id: "cyrene-music",
      version: "1.0.0",
      platform: "win32",
      arch: "arm64",
      entry: "cyrene-music.exe",
      protocolVersion: 1,
    }));

    await expect(resolvePortableMusicComponent(root, { platform: "win32", arch: "x64" }))
      .rejects.toThrow("E_MUSIC_COMPONENT_INCOMPATIBLE");
  });
});
