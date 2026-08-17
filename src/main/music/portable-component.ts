import { access, readFile } from "node:fs/promises";
import path from "node:path";

export interface MusicComponentLaunch {
  command: string;
  args: string[];
  cwd: string;
  version: string;
}

interface MusicComponentManifest {
  id: string;
  version: string;
  platform: string;
  arch: string;
  entry: string;
  protocolVersion: number;
}

function invalid(): Error {
  return new Error("E_MUSIC_COMPONENT_INVALID");
}

export async function resolvePortableMusicComponent(
  componentDir: string,
  environment: { platform: NodeJS.Platform; arch: string } = {
    platform: process.platform,
    arch: process.arch,
  },
): Promise<MusicComponentLaunch> {
  const manifestPath = path.join(componentDir, "manifest.json");
  let manifest: MusicComponentManifest;
  try {
    manifest = JSON.parse(await readFile(manifestPath, "utf8")) as MusicComponentManifest;
  } catch {
    throw new Error("E_MUSIC_COMPONENT_NOT_INSTALLED");
  }

  if (
    manifest.id !== "cyrene-music"
    || typeof manifest.version !== "string"
    || !manifest.version.trim()
    || typeof manifest.entry !== "string"
    || !manifest.entry.trim()
    || manifest.protocolVersion !== 1
  ) {
    throw invalid();
  }
  if (manifest.platform !== environment.platform || manifest.arch !== environment.arch) {
    throw new Error("E_MUSIC_COMPONENT_INCOMPATIBLE");
  }

  const normalizedRoot = path.resolve(componentDir);
  const command = path.resolve(normalizedRoot, manifest.entry);
  const relative = path.relative(normalizedRoot, command);
  if (relative.startsWith("..") || path.isAbsolute(relative)) throw invalid();
  try {
    await access(command);
  } catch {
    throw invalid();
  }

  return {
    command,
    args: [],
    cwd: normalizedRoot,
    version: manifest.version,
  };
}
