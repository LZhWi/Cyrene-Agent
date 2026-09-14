export interface OfflineAudioSegment {
  startSample: number;
  endSample: number;
}

export interface OfflineAudioSegmentationOptions {
  sampleRate?: number;
  minSeconds?: number;
  targetSeconds?: number;
  maxSeconds?: number;
  silenceThreshold?: number;
  minSilenceMs?: number;
  searchRadiusSeconds?: number;
}

function rms(samples: Int16Array, start: number, end: number): number {
  let sum = 0;
  for (let index = start; index < end; index += 1) {
    const normalized = samples[index] / 32768;
    sum += normalized * normalized;
  }
  return end > start ? Math.sqrt(sum / (end - start)) : 0;
}

export function segmentPcmBySilence(
  samples: Int16Array,
  options: OfflineAudioSegmentationOptions = {},
): OfflineAudioSegment[] {
  const sampleRate = options.sampleRate ?? 16_000;
  const minSamples = Math.round((options.minSeconds ?? 20) * sampleRate);
  const targetSamples = Math.round((options.targetSeconds ?? 45) * sampleRate);
  const maxSamples = Math.round((options.maxSeconds ?? 60) * sampleRate);
  const searchRadius = Math.round((options.searchRadiusSeconds ?? 10) * sampleRate);
  const silenceThreshold = options.silenceThreshold ?? 0.01;
  const analysisWindow = Math.max(1, Math.round(sampleRate * 0.02));
  const requiredSilentWindows = Math.max(1, Math.round((options.minSilenceMs ?? 300) / 20));
  if (minSamples <= 0 || targetSamples < minSamples || maxSamples < targetSamples) {
    throw new Error("音频分段参数必须满足 0 < minSeconds <= targetSeconds <= maxSeconds");
  }

  const segments: OfflineAudioSegment[] = [];
  let startSample = 0;
  while (startSample < samples.length) {
    const remaining = samples.length - startSample;
    if (remaining <= maxSamples) {
      segments.push({ startSample, endSample: samples.length });
      break;
    }

    const target = startSample + targetSamples;
    const searchStart = Math.max(startSample + minSamples, target - searchRadius);
    const searchEnd = Math.min(startSample + maxSamples, target + searchRadius);
    let runStart = -1;
    let runWindows = 0;
    let bestCut = -1;
    let bestDistance = Number.POSITIVE_INFINITY;

    for (let cursor = searchStart; cursor < searchEnd; cursor += analysisWindow) {
      const end = Math.min(cursor + analysisWindow, searchEnd);
      if (rms(samples, cursor, end) <= silenceThreshold) {
        if (runStart < 0) runStart = cursor;
        runWindows += 1;
      } else {
        if (runWindows >= requiredSilentWindows) {
          const cut = Math.round((runStart + cursor) / 2);
          const distance = Math.abs(cut - target);
          if (distance < bestDistance) {
            bestCut = cut;
            bestDistance = distance;
          }
        }
        runStart = -1;
        runWindows = 0;
      }
    }
    if (runWindows >= requiredSilentWindows) {
      const cut = Math.round((runStart + searchEnd) / 2);
      const distance = Math.abs(cut - target);
      if (distance < bestDistance) bestCut = cut;
    }

    const endSample = bestCut > startSample ? bestCut : Math.min(startSample + maxSamples, samples.length);
    segments.push({ startSample, endSample });
    startSample = endSample;
  }
  return segments;
}

export function formatAudioTimestamp(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  return [hours, minutes, secs].map((value) => String(value).padStart(2, "0")).join(":");
}
