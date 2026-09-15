import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { ControlError, MAX_CONTROL_BYTES, MAX_CONTROL_REPLY_BYTES, controlRetry, describeControl, validateControlRequest } from "./control-contract.mjs";
import { getFleetDataDir, workspaceKey } from "./paths.mjs";
import { ensureSupervisor, requestSupervisor } from "./supervisor-protocol.mjs";

export { controlFailure } from "./control-errors.mjs";
import { controlFailure } from "./control-errors.mjs";

async function readRequest(input) {
  const source = typeof input === "function" ? await input() : input ?? process.stdin;
  let bytes = 0;
  const chunks = [];
  const add = (chunk) => {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    bytes += buffer.length;
    if (bytes > MAX_CONTROL_BYTES) throw new ControlError("INVALID_CONTROL_REQUEST", `Request exceeds ${MAX_CONTROL_BYTES} UTF-8 bytes.`);
    chunks.push(buffer);
  };
  if (typeof source === "string" || Buffer.isBuffer(source)) add(source);
  else if (source?.[Symbol.asyncIterator]) { for await (const chunk of source) add(chunk); }
  else throw new ControlError("INVALID_CONTROL_REQUEST", "Expected UTF-8 JSON on stdin.");
  try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks))); }
  catch { throw new ControlError("INVALID_CONTROL_REQUEST", "stdin must contain exactly one valid UTF-8 JSON object."); }
}

function sink(output) {
  return typeof output === "function" ? output : output?.write ? (text) => output.write(text) : (text) => process.stdout.write(text);
}

export async function runControlCli(tokens, options = {}) {
  const write = sink(options.stdout);
  let request = null, response;
  try {
    const args = [...tokens];
    if (args.filter((item) => item === "--json").length > 1) throw new ControlError("INVALID_CONTROL_REQUEST", "Duplicate --json flag.");
    const positionals = args.filter((item) => item !== "--json");
    if (positionals[0] === "describe" && positionals.length <= 2 && !positionals[1]?.startsWith("--")) {
      request = { schemaVersion: 1, operation: "describe", params: positionals[1] ? { operation: positionals[1] } : {} };
    } else if (positionals.length === 1 && positionals[0] === "--stdin") {
      request = await readRequest(options.stdin);
    } else throw new ControlError("INVALID_CONTROL_REQUEST", "Use fleet control describe [operation] --json or fleet control --stdin --json.");
    validateControlRequest(request);
    request = { ...request, requestId: request.requestId ?? crypto.randomUUID() };
    if (request.operation === "describe") response = { schemaVersion: 1, requestId: request.requestId, operation: request.operation, ok: true, data: describeControl(request.params.operation) };
    else {
      const env = options.env ?? process.env, platform = options.platform ?? process.platform, home = options.home ?? os.homedir();
      if (!path.isAbsolute(request.workspacePath) || /[\r\n\t]/u.test(request.workspacePath)) throw new ControlError("INVALID_CONTROL_REQUEST", "workspacePath must be an absolute existing directory without control characters.");
      const canonical = await (options.dependencies?.realpath ?? fs.realpath)(request.workspacePath);
      const stat = await (options.dependencies?.stat ?? fs.stat)(canonical);
      if (!stat.isDirectory()) throw new ControlError("INVALID_CONTROL_REQUEST", "workspacePath must be a directory.");
      request = { ...request, workspacePath: canonical };
      const key = await (options.dependencies?.workspaceKey ?? workspaceKey)(canonical, { platform });
      const manifest = await (options.dependencies?.ensureSupervisor ?? ensureSupervisor)({
        workspacePath: canonical, workspaceKey: key, dataDir: getFleetDataDir(env, platform, home),
        scriptPath: fileURLToPath(new URL("../fleet-supervisor.mjs", import.meta.url)), nodeExecutable: process.execPath, env
      });
      const timeoutMs = request.operation === "wait" ? (request.params.timeoutMs ?? 600000) + 5000
        : ["checkpoint", "attest", "check", "prepare", "apply", "start"].includes(request.operation) ? 120000 : 15000;
      response = await (options.dependencies?.requestSupervisor ?? requestSupervisor)({
        address: manifest.address, token: manifest.token, workspaceKey: key,
        method: "control", params: request, timeoutMs
      });
      if (!response || response.schemaVersion !== 1 || response.requestId !== request.requestId || response.operation !== request.operation || typeof response.ok !== "boolean") {
        throw new ControlError("CONTROL_RESPONSE_INVALID", "The control response identity or version is invalid. Inspect state before retrying.", { retry: controlRetry(request.operation) });
      }
    }
    if (Buffer.byteLength(JSON.stringify(response)) > MAX_CONTROL_REPLY_BYTES) throw new ControlError("CONTROL_RESPONSE_TOO_LARGE", "The response exceeds its bound. Read a narrower observation/result.", { retry: controlRetry(request.operation) });
  } catch (error) { response = controlFailure(request, error); }
  write(`${JSON.stringify(response)}\n`);
  return response.ok ? 0 : /INVALID|UNKNOWN_CONTROL/.test(response.error.code) ? 2
    : response.error.code === "AUTHORITY_DENIED" ? 3 : response.error.retry === "safe" ? 4 : 5;
}
