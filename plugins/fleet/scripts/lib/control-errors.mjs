import { ControlError, controlRetry } from "./control-contract.mjs";
const safeIdentity = (value) => typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/u.test(value) ? value : null;

export function controlFailure(request, error) {
  const input = error instanceof ControlError && /INVALID|UNKNOWN_CONTROL/.test(error.code);
  const authority = error?.category === "authorityDenied" || error?.code === "AUTHORITY_DENIED";
  const contract = Array.isArray(error?.issues);
  const known = error instanceof ControlError;
  const retry = input || contract ? "safe" : known ? error.retry : controlRetry(request?.operation);
  const sentUnknown = error?.requestSent === true || error?.code === "SUPERVISOR_RESPONSE_TIMEOUT";
  return {
    schemaVersion: 1, requestId: safeIdentity(request?.requestId), operation: safeIdentity(request?.operation), ok: false,
    error: {
      code: authority ? "AUTHORITY_DENIED" : contract ? "INVALID_START_CONTRACT" : known ? error.code : sentUnknown ? "CONTROL_RESPONSE_TIMEOUT" : "CONTROL_UNAVAILABLE",
      message: known ? error.message : contract ? "The start contract failed validation. Use the exact contract schema and existing confirmation rules."
        : sentUnknown ? "The response deadline is not proof of non-execution. Observe the exact admission/turn before any retry."
          : "Fleet could not complete the operation. Check the selected workspace and runtime; inspect status before retrying a mutation.",
      retry,
      ...(known && error.path ? { path: error.path } : {}),
      ...(contract ? { issues: error.issues.slice(0, 32).map((issue) => ({ path: String(issue.path).slice(0, 128), kind: issue.kind })) } : {}),
      requestAcceptance: sentUnknown && !["safe"].includes(controlRetry(request?.operation)) ? "unknown" : "not-asserted"
    }
  };
}
