// Account/runtime capability discovery; no thread or model turn is created.
const SAFE_TEXT = /^[^\u0000-\u001f\u007f-\u009f]{1,80}$/u;
export async function discoverModels(request) {
  if (typeof request !== "function") throw new TypeError("Model discovery requires a request function.");
  const models = new Map();
  const cursors = new Set();
  let cursor = null;
  for (let page = 0; page < 16; page += 1) {
    const response = await request("model/list", { limit: 100, includeHidden: false, ...(cursor ? { cursor } : {}) });
    if (!Array.isArray(response?.data)) throw new Error("Codex returned a malformed model catalogue.");
    for (const entry of response.data) {
      if (entry?.hidden === true) continue;
      const model = entry?.model;
      if (typeof model !== "string" || !SAFE_TEXT.test(model)
        || !Array.isArray(entry.supportedReasoningEfforts)) {
        throw new Error("Codex returned malformed model capabilities.");
      }
      const efforts = entry.supportedReasoningEfforts.map((item) => item?.reasoningEffort);
      if (efforts.some((effort) => typeof effort !== "string" || !/^[a-z][a-z0-9_-]{0,31}$/u.test(effort))) {
        throw new Error("Codex returned malformed reasoning effort capabilities.");
      }
      models.set(model, Object.freeze({ model, efforts: Object.freeze([...new Set(efforts)]) }));
      if (models.size > 1024) throw new Error("Codex model catalogue exceeds the bounded inventory.");
    }
    cursor = response.nextCursor ?? null;
    if (cursor === null) return Object.freeze([...models.values()]);
    if (typeof cursor !== "string" || !cursor || cursor.length > 4096 || cursors.has(cursor)) {
      throw new Error("Codex model pagination did not advance safely.");
    }
    cursors.add(cursor);
  }
  throw new Error("Codex model catalogue exceeded the pagination limit.");
}
