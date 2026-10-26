// Isolated migration experiment only. Never accepted by the renderer patch gate.
export const LIFE_LEGACY_KEYS = ["attachments", "modelContext", "weatherCard", "callEvent", "musicEvent", "pluginDelivery"] as const;
export type LifeLegacyMetadata = Partial<Record<typeof LIFE_LEGACY_KEYS[number], unknown>>;

export function lifeLegacyMetadata(message: object): LifeLegacyMetadata | undefined {
  const record = message as Record<string, unknown>;
  const result = Object.fromEntries(LIFE_LEGACY_KEYS.filter(key => record[key] !== undefined).map(key => [key, record[key]]));
  return Object.keys(result).length ? result : undefined;
}

export function isLifeLegacyMetadata(value: unknown): value is LifeLegacyMetadata {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  return Object.entries(value).every(([key, field]) => {
    if (!(LIFE_LEGACY_KEYS as readonly string[]).includes(key)) return false;
    if (key === "modelContext") return typeof field === "string";
    if (key === "attachments") return Array.isArray(field) && field.every(item => item && typeof item === "object"
      && ["image", "document"].includes(item.kind) && typeof item.name === "string" && typeof item.filePath === "string");
    return !!field && typeof field === "object" && !Array.isArray(field);
  });
}
