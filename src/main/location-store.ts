import { app } from "electron";
import * as fs from "fs";
import * as path from "path";

export interface LocationSnapshot {
  latitude: number;
  longitude: number;
  accuracy: number;
  obtainedAt: number;
}

export const LOCATION_MAX_AGE_MS = 6 * 60 * 60 * 1000;

function locationPath(): string {
  return path.join(app.getPath("userData"), "location-cache.json");
}

export function normalizeLocation(input: unknown, now = Date.now()): LocationSnapshot | null {
  if (!input || typeof input !== "object") return null;
  const value = input as Partial<LocationSnapshot>;
  const latitude = Number(value.latitude);
  const longitude = Number(value.longitude);
  const accuracy = Number(value.accuracy);
  const obtainedAt = Number(value.obtainedAt ?? now);
  if (!Number.isFinite(latitude) || latitude < -90 || latitude > 90) return null;
  if (!Number.isFinite(longitude) || longitude < -180 || longitude > 180) return null;
  if (!Number.isFinite(accuracy) || accuracy < 0) return null;
  if (!Number.isFinite(obtainedAt) || obtainedAt <= 0 || obtainedAt > now + 60_000) return null;
  // City-level weather does not need a precise address. Keep only roughly 1 km precision on disk.
  return {
    latitude: Math.round(latitude * 100) / 100,
    longitude: Math.round(longitude * 100) / 100,
    accuracy: Math.max(accuracy, 1000),
    obtainedAt,
  };
}

export function saveLocation(input: unknown): LocationSnapshot | null {
  const location = normalizeLocation(input);
  if (!location) return null;
  const filePath = locationPath();
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(location), "utf8");
  return location;
}

export function loadLocation(maxAgeMs = LOCATION_MAX_AGE_MS, now = Date.now()): LocationSnapshot | null {
  try {
    const filePath = locationPath();
    if (!fs.existsSync(filePath)) return null;
    const location = normalizeLocation(JSON.parse(fs.readFileSync(filePath, "utf8")), now);
    if (!location || now - location.obtainedAt > maxAgeMs) return null;
    return location;
  } catch {
    return null;
  }
}

export function clearLocation(): void {
  const filePath = locationPath();
  if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
}
