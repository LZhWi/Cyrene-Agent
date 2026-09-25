export function resolveToolTopK(value: unknown): number {
  const requested = Number(value);
  return Number.isFinite(requested) && requested > 0
    ? Math.min(10, Math.max(1, Math.floor(requested)))
    : 5;
}
