import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

interface MotionCurve {
  Target: string;
  Id: string;
  Segments: number[];
}

interface MotionJson {
  Curves: MotionCurve[];
}

interface ModelJson {
  FileReferences: {
    Motions: Record<string, { File?: string }[]>;
  };
}

function readMotion(file: string): MotionJson {
  return JSON.parse(readFileSync(resolve("assets/models/cyrene", file), "utf8")) as MotionJson;
}

function curveValues(segments: number[]): number[] {
  const values = [segments[1]];
  let cursor = 2;
  while (cursor < segments.length) {
    const type = segments[cursor++];
    const pointCount = type === 1 ? 3 : 1;
    for (let point = 0; point < pointCount; point += 1) {
      cursor += 1;
      values.push(segments[cursor++]);
    }
  }
  return values;
}

describe("Cyrene idle motion assets", () => {
  it("keeps hash characters URL-encoded before the model loader preloads motions", () => {
    for (const root of ["assets/models/cyrene", "src/renderer/public/models/cyrene"]) {
      const model = JSON.parse(readFileSync(resolve(root, "Cyrene.model3.json"), "utf8")) as ModelJson;
      const files = Object.values(model.FileReferences.Motions)
        .flat()
        .map((motion) => motion.File)
        .filter((file): file is string => Boolean(file));
      expect(files.some((file) => file.includes("#")), root).toBe(false);
      expect(files.filter((file) => file.includes("%23")).length, root).toBe(7);
    }
  });

  it("the neutral motion covers every parameter changed by all Tick3 motions", () => {
    const reset = readMotion("motions/动作#6_0.motion3.json");
    const resetIds = new Set(reset.Curves.filter((curve) => curve.Target === "Parameter").map((curve) => curve.Id));
    const idleFiles = [
      "motions/动作#6_1.motion3.json",
      "motions/动作#6_2.motion3.json",
      "motions/动作#6_3.motion3.json",
      "motions/Tick3_3.motion3.json",
    ];

    for (const file of idleFiles) {
      const motion = readMotion(file);
      expect(motion.Curves.every((curve) => curve.Target === "Parameter"), file).toBe(true);
      const missing = motion.Curves.map((curve) => curve.Id).filter((id) => !resetIds.has(id));
      expect(missing, file).toEqual([]);
    }
  });

  it("keeps every reset curve at its neutral value for the whole reset motion", () => {
    const reset = readMotion("motions/动作#6_0.motion3.json");
    const neutralOne = new Set(["ParamEyeLOpen", "ParamEyeROpen", "ParamMouthForm"]);

    for (const curve of reset.Curves) {
      const expected = neutralOne.has(curve.Id) ? 1 : 0;
      expect([...new Set(curveValues(curve.Segments))], curve.Id).toEqual([expected]);
    }
  });
});
