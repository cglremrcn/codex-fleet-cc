import { readSupervisorManifest, requestSupervisor } from "./supervisor-protocol.mjs";

/** Never creates a supervisor, thread or model turn. Mutation errors are never retried. */
export async function requestExistingInbox(context, method, params = {}, dependencies = {}) {
  const manifest = await (dependencies.readSupervisorManifest ?? readSupervisorManifest)({
    dataDir: context.dataDir, workspaceKey: context.key, platform: context.platform
  });
  if (!manifest) {
    if (method === "inbox") return { schemaVersion: 1, version: 0, requests: [], connected: false };
    throw new Error("No existing live inbox. Do not replay an old request into a new supervisor.");
  }
  return (dependencies.requestSupervisor ?? requestSupervisor)({
    address: manifest.address, workspaceKey: context.key, token: manifest.token, method, params,
    timeoutMs: method === "inboxApply" || method === "inboxAnswer" ? 8_000 : 2_000
  });
}
