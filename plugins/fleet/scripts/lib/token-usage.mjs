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
