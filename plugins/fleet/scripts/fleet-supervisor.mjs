#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";

import { isMainModule } from "./lib/is-main.mjs";
import { captureOwnedProcess } from "./lib/process-ownership.mjs";
import {
  SUPERVISOR_PROTOCOL_VERSION,
  createSupervisorServer,
  supervisorPaths
} from "./lib/supervisor-protocol.mjs";

function parseArguments(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith("--") || !value || value.startsWith("--")) {
      throw new Error("Fleet supervisor arguments must be key/value pairs.");
    }
    if (values.has(key)) throw new Error(`Duplicate Fleet supervisor argument: ${key}.`);
    values.set(key, value);
  }
  const required = ["--data-dir", "--workspace-key", "--workspace-path"];
  for (const key of required) {
    if (!values.has(key)) throw new Error(`Missing Fleet supervisor argument: ${key}.`);
  }
  return Object.freeze({
    dataDir: values.get("--data-dir"),
    workspaceKey: values.get("--workspace-key"),
    workspacePath: values.get("--workspace-path")
  });
}

async function writeManifest(paths, manifest) {
  const temporaryPath = path.join(
    paths.root,
    `.supervisor-${process.pid}-${crypto.randomUUID()}.tmp`
  );
  await fs.writeFile(temporaryPath, `${JSON.stringify(manifest)}\n`, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600
  });
  await fs.rename(temporaryPath, paths.manifestPath);
}

export async function runSupervisor(options = {}) {
  const dataDir = path.resolve(options.dataDir);
  const workspacePath = path.resolve(options.workspacePath);
  const workspaceKey = options.workspaceKey;
  const paths = supervisorPaths({ dataDir, workspaceKey });
  const token = crypto.randomBytes(32).toString("hex");
  const ownedProcess = await captureOwnedProcess(process.pid, options);
  let closing = false;
  let resolveStopped;
  const stopped = new Promise((resolve) => {
    resolveStopped = resolve;
  });

  const server = await createSupervisorServer({
    ...paths,
    workspaceKey,
    token,
    handleRequest: async ({ method }) => {
      if (method === "ping") return { ready: true, active: 0 };
      if (method === "shutdown") {
        setTimeout(() => close(), 50).unref?.();
        return { accepted: true };
      }
      throw new Error(`Unknown Fleet supervisor method: ${method}.`);
    }
  });

  const manifest = Object.freeze({
    schemaVersion: 1,
    protocolVersion: SUPERVISOR_PROTOCOL_VERSION,
    workspaceKey,
    address: paths.address,
    token,
    process: ownedProcess
  });

  async function close() {
    if (closing) return stopped;
    closing = true;
    await server.close().catch(() => undefined);
    try {
      const current = JSON.parse(await fs.readFile(paths.manifestPath, "utf8"));
      if (
        current?.token === token
        && current?.process?.pid === ownedProcess.pid
        && current?.process?.recordedStart === ownedProcess.recordedStart
      ) {
        await fs.unlink(paths.manifestPath).catch((error) => {
          if (error.code !== "ENOENT") throw error;
        });
      }
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    } finally {
      resolveStopped();
    }
    return stopped;
  }

  await writeManifest(paths, manifest);
  process.once("SIGINT", () => void close());
  process.once("SIGTERM", () => void close());
  await stopped;
}

if (isMainModule(import.meta.url)) {
  const options = parseArguments(process.argv.slice(2));
  await runSupervisor(options);
}
