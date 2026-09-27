import crypto from "node:crypto";
import { spawn } from "node:child_process";
import path from "node:path";
import { ControlError, MAX_CONTROL_REPLY_BYTES, controlRetry, validateControlRequest } from "./control-contract.mjs";
import { createObservationAssembler } from "./control-observation.mjs";

export class ControlRemoteError extends Error {
  constructor(error) { super(error.message); this.name = "ControlRemoteError"; this.code = error.code; this.retry = error.retry; this.requestAcceptance = error.requestAcceptance; }
}

/** Exact-argv local CLI transport. Killing a timed-out client never claims to cancel a Fleet turn. */
export function createControlTransport({ scriptPath, env = process.env, nodeExecutable = process.execPath, maxConcurrent = 4 }) {
  if (!path.isAbsolute(scriptPath ?? "") || !path.isAbsolute(nodeExecutable) || !Number.isSafeInteger(maxConcurrent) || maxConcurrent < 1 || maxConcurrent > 16) throw new TypeError("Control transport needs absolute trusted executable paths and 1-16 concurrent clients.");
  let active = 0;
  return function transport(request) {
    validateControlRequest(request);
    if (active >= maxConcurrent) return Promise.reject(new ControlError("CONTROL_CLIENT_LIMIT", "Too many client requests; share one observer and bound parallel control calls."));
    active++;
    return new Promise((resolve, reject) => {
      const timeoutMs = request.operation === "wait" ? (request.params.timeoutMs ?? 600000) + 10000 : 130000;
      let child;
      try { child = spawn(nodeExecutable, [scriptPath, "control", "--stdin", "--json"], { env, shell: false, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] }); }
      catch { active--; reject(new ControlError("CONTROL_CLIENT_START_FAILED", "The local control CLI could not be started.")); return; }
      const chunks = []; let bytes = 0, settled = false, killTimer = null;
      const finish = (error, value) => {
        if (settled) return; settled = true; active--; clearTimeout(timer); clearTimeout(killTimer);
        if (error) reject(error); else resolve(value);
      };
      const fail = (code, message) => {
        const error = new ControlError(code, message, { retry: controlRetry(request.operation) });
        if (controlRetry(request.operation) !== "safe") error.requestAcceptance = "unknown";
        child.kill();
        // Only this spawned CLI process, never its detached supervisor or model turn.
        killTimer = setTimeout(() => child.kill("SIGKILL"), 1000); killTimer.unref?.();
        // Keep the child cleanup fallback until close; return uncertainty immediately.
        if (!settled) { settled = true; active--; clearTimeout(timer); reject(error); }
      };
      const timer = setTimeout(() => fail("CONTROL_CLIENT_TIMEOUT", "The client deadline expired, not the task. Observe the exact lane/plan before retrying a mutation."), timeoutMs);
      timer.unref?.();
      child.stdout.on("data", chunk => {
        if (settled) return;
        bytes += chunk.length;
        if (bytes > MAX_CONTROL_REPLY_BYTES + 1) { fail("CONTROL_CLIENT_RESPONSE_TOO_LARGE", "Control output exceeded its byte bound; use a narrower result."); return; }
        chunks.push(chunk);
      });
      child.stderr.on("data", () => {}); // Drain without exposing raw diagnostics or credentials.
      child.stdin.on("error", () => {}); // A rejecting CLI may close stdin early; its envelope/close decides the outcome.
      child.on("error", () => finish(new ControlError("CONTROL_CLIENT_START_FAILED", "The local control CLI could not be started.")));
      child.on("close", () => {
        clearTimeout(killTimer);
        if (settled) return;
        try {
          const response = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)));
          finish(null, response);
        } catch { finish(new ControlError("CONTROL_CLIENT_RESPONSE_INVALID", "The CLI did not return one bounded UTF-8 JSON envelope. Reconcile mutations before retrying.", { retry: controlRetry(request.operation) })); }
      });
      child.stdin.end(JSON.stringify(request));
    });
  };
}

export function createFleetControlClient({ workspacePath, transport, ...options }) {
  if (!path.isAbsolute(workspacePath ?? "")) throw new TypeError("A canonical absolute workspacePath is required.");
  const send = transport ?? createControlTransport(options);
  async function call(operation, params = {}) {
    const request = { schemaVersion: 1, requestId: crypto.randomUUID(), operation, workspacePath, params };
    validateControlRequest(request);
    const response = await send(request);
    if (!response || response.schemaVersion !== 1 || response.requestId !== request.requestId || response.operation !== operation
      || typeof response.ok !== "boolean" || Buffer.byteLength(JSON.stringify(response)) > MAX_CONTROL_REPLY_BYTES) {
      throw new ControlError("CONTROL_CLIENT_RESPONSE_INVALID", "Mismatched control response; do not reuse it for a mutation.", { retry: controlRetry(operation) });
    }
    if (!response.ok) {
      if (!response.error || typeof response.error.code !== "string" || typeof response.error.message !== "string") throw new ControlError("CONTROL_CLIENT_RESPONSE_INVALID", "Malformed remote error.", { retry: controlRetry(operation) });
      throw new ControlRemoteError(response.error);
    }
    return response.data;
  }
  return Object.freeze({ call,
    async observe(previous = { cursor: null, lanes: [] }, options = {}) {
      const assembler = createObservationAssembler(previous);
      let params = { ...options, ...(previous.cursor ? { cursor: previous.cursor } : {}) };
      for (let pageCount = 0; pageCount <= 512; pageCount++) {
        const page = await call("observe", params), result = assembler.accept(page);
        if (result) return result;
        params = { nextPage: page.nextPage };
      }
      throw new ControlError("OBSERVATION_ASSEMBLY_INVALID", "Observation exceeded its bounded page count; previous state was not replaced.");
    },
    async readSection(laneId, section, options = {}) {
      if (!["work", "checks", "artifacts", "evidence", "events"].includes(section)) throw new TypeError("Choose a paged result section.");
      let params = { ...options, laneId, section }, revision = null, bytes = 0, expectedIndex = 0, text = "", format = null;
      const items = [];
      for (let pageCount = 0; pageCount < 2048; pageCount++) {
        const page = await call("result", params);
        if (page?.kind !== "result-section" || page.laneId !== laneId || page.section !== section || !Array.isArray(page.fragments)
          || (revision && page.revision !== revision)) throw new ControlError("CONTROL_RESULT_CHANGED", "Discard mixed or malformed result pages.");
        revision ??= page.revision;
        for (const fragment of page.fragments) {
          if (fragment.index !== expectedIndex || fragment.offset !== Array.from(text).length || typeof fragment.text !== "string"
            || !["text", "json"].includes(fragment.format) || (format && format !== fragment.format)) throw new ControlError("CONTROL_RESULT_INVALID", "Out-of-order or malformed result fragments.");
          bytes += Buffer.byteLength(fragment.text);
          if (bytes > 2 * 1024 * 1024) throw new ControlError("CONTROL_RESULT_TOO_LARGE", "Client section assembly exceeds 2 MiB; process individual pages instead.");
          format = fragment.format; text += fragment.text;
          if (Array.from(text).length > fragment.totalCharacters) throw new ControlError("CONTROL_RESULT_INVALID", "Result fragment exceeds its declared length.");
          if (Array.from(text).length === fragment.totalCharacters) { items.push(format === "json" ? JSON.parse(text) : text); expectedIndex++; text = ""; format = null; }
        }
        if (page.done) {
          if (page.next !== null || text || items.length !== page.itemCount) throw new ControlError("CONTROL_RESULT_INVALID", "Incomplete result section.");
          return { revision, items };
        }
        if (!page.next || !page.fragments.length) throw new ControlError("CONTROL_RESULT_INVALID", "Result pagination did not progress.");
        params = page.next;
      }
      throw new ControlError("CONTROL_RESULT_TOO_LARGE", "Result page count exceeds its bound.");
    },
    wait: (cursor, options = {}) => call("wait", { ...options, ...(cursor ? { cursor } : {}) })
  });
}
