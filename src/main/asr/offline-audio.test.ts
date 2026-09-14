import { describe, expect, it } from "vitest";
import { formatAudioTimestamp, segmentPcmBySilence } from "./offline-audio";

function syntheticPcm(sampleRate: number, seconds: number, amplitude = 5_000): Int16Array {
  const samples = new Int16Array(sampleRate * seconds);
  samples.fill(amplitude);
  return samples;
}

describe("offline audio segmentation", () => {
  it("cuts near a sustained silence around the target duration", () => {
    const sampleRate = 1_000;
    const samples = syntheticPcm(sampleRate, 100);
    samples.fill(0, 42 * sampleRate, 43 * sampleRate);
    const segments = segmentPcmBySilence(samples, {
      sampleRate,
      minSeconds: 20,
      targetSeconds: 45,
      maxSeconds: 60,
      minSilenceMs: 300,
    });
    expect(segments[0].endSample / sampleRate).toBeCloseTo(42.5, 1);
    expect(segments.at(-1)?.endSample).toBe(samples.length);
  });

  it("uses the hard maximum when no silence is available", () => {
    const sampleRate = 1_000;
    const samples = syntheticPcm(sampleRate, 130);
    const segments = segmentPcmBySilence(samples, {
      sampleRate,
      minSeconds: 20,
      targetSeconds: 45,
      maxSeconds: 60,
    });
    expect(segments.map((segment) => (segment.endSample - segment.startSample) / sampleRate))
      .toEqual([60, 60, 10]);
  });

  it("formats stable transcript timestamps", () => {
    expect(formatAudioTimestamp(3661.9)).toBe("01:01:01");
  });
});
