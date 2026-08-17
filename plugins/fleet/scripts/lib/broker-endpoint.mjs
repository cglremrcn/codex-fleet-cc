// Derived from openai/codex-plugin-cc at db52e28f4d9ded852ab3942cea316258ae4ef346.
// Modified so target-platform socket paths do not inherit the host OS path separator.
// Licensed under Apache-2.0; see ../../LICENSE and ../../NOTICE.

import path from "node:path";
import process from "node:process";

function sanitizePipeName(value) {
  return String(value ?? "")
    .replace(/[^A-Za-z0-9._-]/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function createBrokerEndpoint(sessionDir, platform = process.platform) {
  if (platform === "win32") {
    const pipeName = sanitizePipeName(
      `${path.win32.basename(sessionDir)}-codex-app-server`
    );
    return `pipe:\\\\.\\pipe\\${pipeName}`;
  }

  return `unix:${path.posix.join(sessionDir.replaceAll("\\", "/"), "broker.sock")}`;
}

export function parseBrokerEndpoint(endpoint) {
  if (typeof endpoint !== "string" || endpoint.length === 0) {
    throw new Error("Missing broker endpoint.");
  }
  if (endpoint.startsWith("pipe:")) {
    const pipePath = endpoint.slice("pipe:".length);
    if (!pipePath) {
      throw new Error("Broker pipe endpoint is missing its path.");
    }
    return { kind: "pipe", path: pipePath };
  }
  if (endpoint.startsWith("unix:")) {
    const socketPath = endpoint.slice("unix:".length);
    if (!socketPath) {
      throw new Error("Broker Unix socket endpoint is missing its path.");
    }
    return { kind: "unix", path: socketPath };
  }
  throw new Error(`Unsupported broker endpoint: ${endpoint}`);
}
