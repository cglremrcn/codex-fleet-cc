import assert from "node:assert/strict";
import test from "node:test";
import { sliceControlResult } from "../plugins/fleet/scripts/lib/control-result.mjs";
import { createObservationFeed } from "../plugins/fleet/scripts/lib/control-observation.mjs";
const lane = { id: "worker", status: "complete", executionRevision: 0, workPerformed: ["first", "界\"\n".repeat(20000), "last"], verificationResults: [{ check: "unit", status: "passed", evidence: "gate.json" }] };

test("large Unicode result sections stay byte-bounded and can be reassembled without loss", () => {
  let params = { laneId: "worker", section: "work", maxBytes: 2048 }; const restored = []; let pages = 0;
  while (true) {
    const result = sliceControlResult(lane, params); pages++;
    assert.ok(Buffer.byteLength(JSON.stringify(result)) <= 2048);
    for (const part of result.fragments) { restored[part.index] ??= ""; assert.equal(Array.from(restored[part.index]).length, part.offset); restored[part.index] += part.text; }
    if (result.done) break;
    params = result.next; assert.ok(pages < 200);
  }
  assert.ok(pages > 2); assert.deepEqual(restored, lane.workPerformed);
});
test("changed results cannot be mixed into an already-started section", () => {
  const page = sliceControlResult(lane, { section: "work", maxBytes: 2048 });
  assert.throws(() => sliceControlResult({ ...lane, executionRevision: 1 }, page.next), { code: "CONTROL_RESULT_CHANGED" });
  assert.throws(() => sliceControlResult(lane, { ...page.next, revision: undefined }), { code: "INVALID_CONTROL_REQUEST" });
  assert.throws(() => sliceControlResult(lane, { section: "work", offset: 100, revision: page.revision }), { code: "INVALID_CONTROL_REQUEST" });
});
test("identity discovery excludes full result bodies and retains section counts", () => {
  const identity = sliceControlResult(lane, { section: "identity" });
  assert.equal(identity.counts.work, 3); assert.equal(identity.workPerformed, undefined);
  assert.equal(sliceControlResult(lane, {}).workPerformed, lane.workPerformed);
  const check = sliceControlResult(lane, { section: "checks" });
  assert.deepEqual(JSON.parse(check.fragments[0].text), lane.verificationResults[0]);
});
test("archiving uncertain work hides its row, not the need for reconciliation", () => {
  const feed = createObservationFeed({ workspaceKey: "0123456789abcdef0123456789abcdef" });
  const page = feed.observe({ lanes: [{ id: "hidden-unknown", status: "outcome_unknown", archivedAt: "today" }] });
  assert.equal(page.totals.visible, 0); assert.equal(page.totals.archivedAttention, 1);
  assert.deepEqual(page.totals.archivedAttentionIds, ["hidden-unknown"]);
});
