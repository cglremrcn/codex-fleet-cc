import { sliceControlResult } from "./control-result.mjs";
import { ControlError, MAX_CONTROL_REPLY_BYTES, describeControl, validateControlRequest } from "./control-contract.mjs";
import { controlFailure } from "./control-errors.mjs";
import { createControlWait } from "./control-wait.mjs";
import { createObservationFeed } from "./control-observation.mjs";

export function createMachineControl({ workspacePath, workspaceKey, snapshot, callLegacy, evidence, plans }) {
  const feed = createObservationFeed({ workspaceKey });
  const waiter = createControlWait({ snapshot, feed });
  async function run(operation, params) {
    if (operation === "describe") return describeControl(params.operation);
    if (operation === "observe") return feed.observe(params.nextPage ? null : await snapshot(), params);
    if (operation === "result") {
      const lane = await callLegacy("result", { laneId: params.laneId });
      return sliceControlResult({ ...lane, sourceEvidence: evidence ? await evidence.forLane(params.laneId) : [] }, params);
    }
    if (operation === "models") return callLegacy("models", params);
    if (operation === "wait") return waiter.wait(params);
    if (operation === "start") return callLegacy("start", params.contract);
    if (operation === "continue") return callLegacy("followUp", params);
    if (operation === "cancel.preview" || operation === "cancel.apply") return callLegacy("cancel", params);
    if (["checkpoint", "attest", "check"].includes(operation) && evidence) return evidence[operation](params);
    if (["prepare", "apply"].includes(operation) && plans) return plans[operation](params);
    throw new ControlError("CONTROL_UNAVAILABLE", "This control capability is not available in the loaded runtime.");
  }
  return Object.freeze({
    async handle(request) {
      try {
        validateControlRequest(request);
        if (request.workspacePath !== workspacePath && request.operation !== "describe") throw new ControlError("INVALID_CONTROL_REQUEST", "Control request workspace does not match the owning supervisor.");
        const data = await run(request.operation, request.params);
        const response = { schemaVersion: 1, requestId: request.requestId ?? null, operation: request.operation, ok: true, data };
        if (Buffer.byteLength(JSON.stringify(response)) > MAX_CONTROL_REPLY_BYTES) throw new ControlError("CONTROL_RESPONSE_TOO_LARGE", "The result exceeds its response budget. Use a smaller observation or a paged result section such as checks or work.");
        return response;
      } catch (error) { return controlFailure(request, error); }
    },
    closeObservationWaits: () => waiter.dispose(),
    hasWorkLease: () => waiter.hasWaiters() || plans?.hasWorkLease?.() === true,
    dispose() { waiter.dispose(); feed.dispose(); plans?.dispose?.(); },
    stats: () => ({ observation: feed.stats(), wait: waiter.stats() })
  });
}
