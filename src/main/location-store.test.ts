import { describe, expect, it } from "vitest";
import { normalizeLocation } from "./location-store";

describe("normalizeLocation", () => {
  it("accepts valid desktop geolocation data", () => {
    expect(normalizeLocation({ latitude: 30.27, longitude: 120.15, accuracy: 8000, obtainedAt: 1000 }, 2000))
      .toEqual({ latitude: 30.27, longitude: 120.15, accuracy: 8000, obtainedAt: 1000 });
  });

  it("stores only city-level precision", () => {
    expect(normalizeLocation({ latitude: 30.27491, longitude: 120.15515, accuracy: 20, obtainedAt: 1000 }, 2000))
      .toEqual({ latitude: 30.27, longitude: 120.16, accuracy: 1000, obtainedAt: 1000 });
  });

  it("rejects invalid coordinates and future timestamps", () => {
    expect(normalizeLocation({ latitude: 91, longitude: 120, accuracy: 10 }, 1000)).toBeNull();
    expect(normalizeLocation({ latitude: 30, longitude: 181, accuracy: 10 }, 1000)).toBeNull();
    expect(normalizeLocation({ latitude: 30, longitude: 120, accuracy: 10, obtainedAt: 62_000 }, 1000)).toBeNull();
  });
});
