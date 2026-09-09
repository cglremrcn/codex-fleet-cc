// Reported cumulative counters, never subscription billing estimates.
const FIELDS = Object.freeze({ input: "inputTokens", output: "outputTokens", total: "totalTokens",
  cachedInput: "cachedInputTokens", cacheWriteInput: "cacheWriteInputTokens",
  reasoningOutput: "reasoningOutputTokens" });

export function normalizeTokenUsage(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const result = {};
  for (const field of Object.keys(FIELDS)) {
    if (Number.isSafeInteger(value[field]) && value[field] >= 0) result[field] = value[field];
  }
  if (Number.isSafeInteger(result.input)) {
    const hasCached = Number.isSafeInteger(result.cachedInput);
    const cached = hasCached ? Math.min(result.input, result.cachedInput) : 0;
    result.freshInput = Math.max(0, result.input - cached);
    if (hasCached) {
      result.cacheHitPercent = result.input === 0
        ? 0
        : Math.round((cached / result.input) * 10_000) / 100;
    }
  }
  return Object.keys(result).length ? Object.freeze(result) : null;
}

export function usageFromNotification(value) {
  if (!value?.total || typeof value.total !== "object") return null;
  if (["inputTokens", "outputTokens", "totalTokens"].some(
    (field) => !Number.isSafeInteger(value.total[field]) || value.total[field] < 0
  )) return null;
  return normalizeTokenUsage(Object.fromEntries(Object.entries(FIELDS).map(
    ([field, source]) => [field, value.total[source]]
  )));
}
