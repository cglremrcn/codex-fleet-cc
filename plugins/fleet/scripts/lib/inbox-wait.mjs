import crypto from "node:crypto";
import { requestExistingInbox } from "./inbox-client.mjs";

/** One bounded, read-only observer per controller, not one model-polling agent per lane. */
export async function waitForInbox(context, options = {}, dependencies = {}) {
  const timeoutMs = options.timeoutMs ?? 60_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 90_000) throw new TypeError("Inbox wait must be 1-90000 ms.");
  if (options.after !== undefined && !/^[a-f0-9]{64}$/u.test(options.after)) throw new TypeError("Invalid inbox cursor.");
  const now = dependencies.now ?? Date.now;
  const sleep = dependencies.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const read = dependencies.readInbox ?? (() => requestExistingInbox(context, "inbox", {}, dependencies));
  const deadline = now() + timeoutMs;
  // Hard attempt ceiling also bounds behavior if a wall clock moves backwards.
  for (let attempt = 0; attempt < 361; attempt += 1) {
    const snapshot = await read();
    const actionable = snapshot.requests.filter((r) => r.state === "delegated" || (r.state === "pending" && !r.hasProposal));
    const cursor = crypto.createHash("sha256").update(JSON.stringify(actionable.map((r) => [r.id, r.revision, r.state]).sort())).digest("hex");
    if (actionable.length && cursor !== options.after) return { schemaVersion: 1, changed: true, cursor, requests: actionable };
    if (snapshot.connected === false) return { schemaVersion: 1, changed: false, reason: "no-live-supervisor", cursor, requests: [] };
    if (now() >= deadline || attempt === 360) return { schemaVersion: 1, changed: false, reason: "timeout", cursor, requests: [] };
    await sleep(Math.min(250, Math.max(1, deadline - now())));
  }
}
