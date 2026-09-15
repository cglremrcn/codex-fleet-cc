import { ControlError, digest } from "./control-contract.mjs";

export const RESULT_SECTIONS = Object.freeze({ work: "workPerformed", checks: "verificationResults", artifacts: "artifactRefs", evidence: "evidenceRefs", events: "events" });

/** Read an explicitly selected result section; revisions prevent mixed-version partial reads. */
export function sliceControlResult(lane, params) {
  if (!params.section || params.section === "full") {
    if (params.offset || params.textOffset || params.revision || params.maxBytes) throw new ControlError("INVALID_CONTROL_REQUEST", "Full results do not accept page fields; choose a named section first.");
    return lane;
  }
  const identity = { id: lane.id, admissionId: lane.admissionId ?? null, threadId: lane.threadId ?? null, turnId: lane.turnId ?? null,
    executionRevision: lane.executionRevision ?? null, instructionDigest: lane.instructionDigest ?? null,
    status: lane.status, phase: lane.phase ?? null, outcome: lane.outcome ?? null, sourceEvidence: lane.sourceEvidence ?? [] };
  if (params.section === "identity") return { ...identity, counts: Object.fromEntries(Object.entries(RESULT_SECTIONS).map(([section, field]) => [section, (lane[field] ?? []).length])) };
  const field = RESULT_SECTIONS[params.section];
  if (!field || !Array.isArray(lane[field] ?? [])) throw new ControlError("CONTROL_RESULT_INVALID", "This result section is not available in a valid shape.");
  const items = lane[field] ?? [], revision = digest({ identity, items }, `fleet-result-${params.section}-v1`);
  const offset = params.offset ?? 0, textOffset = params.textOffset ?? 0;
  if ((offset || textOffset) && !params.revision) throw new ControlError("INVALID_CONTROL_REQUEST", "Continuation pages require the exact returned result revision.");
  if (params.revision && params.revision !== revision) throw new ControlError("CONTROL_RESULT_CHANGED", "The result changed; discard partial section pages and start this section again.");
  if (offset > items.length || (offset === items.length && textOffset)) throw new ControlError("INVALID_CONTROL_REQUEST", "Result page offset is outside the retained section.");
  const response = { schemaVersion: 1, kind: "result-section", laneId: lane.id, section: params.section, revision,
    itemCount: items.length, fragments: [], done: false, next: null };
  const budget = params.maxBytes ?? 8192;
  let used = Buffer.byteLength(JSON.stringify(response)) + 256, index = offset, start = textOffset;
  while (index < items.length) {
    const format = typeof items[index] === "string" ? "text" : "json";
    const chars = Array.from(format === "text" ? items[index] : JSON.stringify(items[index]));
    if (start > chars.length) throw new ControlError("INVALID_CONTROL_REQUEST", "Text offset is outside the selected result item.");
    const item = { index, offset: start, totalCharacters: chars.length, format, text: "" };
    const overhead = Buffer.byteLength(JSON.stringify(item)) + 2;
    if (used + overhead + 16 > budget && response.fragments.length) break;
    let text = "", consumed = 0;
    for (const character of chars.slice(start)) {
      const size = Buffer.byteLength(JSON.stringify(character)) - 2;
      if (used + overhead + consumed + size > budget) break;
      text += character; consumed += size;
    }
    if (!text && start < chars.length) throw new ControlError("CONTROL_RESULT_INVALID", "Result page cannot make progress within its byte budget.");
    item.text = text; response.fragments.push(item); used += overhead + consumed;
    start += Array.from(text).length;
    if (start < chars.length) break;
    index++; start = 0;
  }
  response.done = index === items.length;
  if (!response.done) response.next = { laneId: lane.id, section: params.section, revision, offset: index, textOffset: start, maxBytes: budget };
  return response;
}
