import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import { sanitizeLaneForPersistence } from "./redaction.mjs";

const WORKSPACE_KEY = /^[a-f0-9]{32}$/u;
const PREVIEW_TARGETS = new WeakMap();

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) {
    return value;
  }
  for (const item of Object.values(value)) deepFreeze(item);
  return Object.freeze(value);
}

function stableJson(value) {
  if (Array.isArray(value)) {
    return `[${value.map(stableJson).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => (
      `${JSON.stringify(key)}:${stableJson(value[key])}`
    )).join(",")}}`;
  }
  return JSON.stringify(value);
}

function confirmationToken(bundle, targetDigest) {
  return crypto.createHash("sha256")
    .update("codex-fleet-support-v1\0", "utf8")
    .update(stableJson(bundle), "utf8")
    .update("\0", "utf8")
    .update(targetDigest, "utf8")
    .digest("hex");
}

function targetDigest(outputPath) {
  const canonical = process.platform === "win32" ? outputPath.toLowerCase() : outputPath;
  return crypto.createHash("sha256").update(canonical, "utf8").digest("hex");
}

function countMarkers(value) {
  return (JSON.stringify(value).match(/\[REDACTED:[A-Z]+\]/gu) ?? []).length;
}

async function assertNewRegularTarget(outputPath) {
  if (typeof outputPath !== "string" || !path.isAbsolute(outputPath)) {
    throw new TypeError("Support bundle output path must be absolute.");
  }
  const parent = path.dirname(outputPath);
  const parentMetadata = await fs.lstat(parent);
  if (!parentMetadata.isDirectory() || parentMetadata.isSymbolicLink()) {
    throw new Error("Support bundle parent must be a real directory.");
  }
  try {
    await fs.lstat(outputPath);
    throw new Error("Support bundle target already exists; choose a new file.");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  return path.resolve(outputPath);
}

function sanitizeInput(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  return sanitizeLaneForPersistence(value);
}

export async function previewSupportBundle(options = {}) {
  if (!WORKSPACE_KEY.test(options.workspaceKey ?? "")) {
    throw new TypeError("Support bundle workspaceKey must be a 32-character digest.");
  }
  const outputPath = await assertNewRegularTarget(options.outputPath);
  const sanitized = sanitizeInput({
    doctor: options.doctor ?? {},
    state: options.state ?? {},
    events: Array.isArray(options.events) ? options.events : []
  });
  const bundle = {
    schemaVersion: 1,
    generatedAt: typeof options.generatedAt === "string"
      ? options.generatedAt
      : new Date().toISOString(),
    workspaceKey: options.workspaceKey,
    manifest: {
      redactionMarkers: countMarkers(sanitized),
      includesPrompts: false,
      includesReasoning: false,
      includesCredentials: false,
      includesCanonicalPaths: false
    },
    doctor: sanitized.doctor ?? {},
    state: sanitized.state ?? {},
    events: sanitized.events ?? []
  };
  deepFreeze(bundle);
  const destinationDigest = targetDigest(outputPath);
  const preview = deepFreeze({
    schemaVersion: 1,
    writesPerformed: false,
    manifest: bundle.manifest,
    bundle,
    targetDigest: destinationDigest,
    confirmationToken: confirmationToken(bundle, destinationDigest)
  });
  PREVIEW_TARGETS.set(preview, outputPath);
  return preview;
}

export async function writeSupportBundle(preview, confirmation) {
  const outputPath = PREVIEW_TARGETS.get(preview);
  if (!outputPath || !preview || typeof preview !== "object") {
    throw new TypeError("Support export requires an in-process preview.");
  }
  const expected = confirmationToken(preview.bundle, preview.targetDigest);
  if (confirmation !== preview.confirmationToken || confirmation !== expected) {
    throw new Error("Support export requires the exact preview confirmation token.");
  }
  await assertNewRegularTarget(outputPath);

  const serialized = `${JSON.stringify(preview.bundle, null, 2)}\n`;
  const temporaryPath = path.join(
    path.dirname(outputPath),
    `.${path.basename(outputPath)}-${process.pid}-${crypto.randomUUID()}.tmp`
  );
  let handle;
  try {
    handle = await fs.open(temporaryPath, "wx", 0o600);
    await handle.writeFile(serialized, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await fs.link(temporaryPath, outputPath);
    await fs.chmod(outputPath, 0o600).catch((error) => {
      if (process.platform !== "win32") throw error;
    });
  } finally {
    await handle?.close().catch(() => undefined);
    await fs.unlink(temporaryPath).catch((error) => {
      if (error.code !== "ENOENT") throw error;
    });
  }
  return Object.freeze({ written: true, bytes: Buffer.byteLength(serialized, "utf8") });
}
