import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

const APP_DIRECTORY = "codex-fleet-cc";

function requireAbsolute(value, platformPath, label) {
  if (typeof value !== "string" || !platformPath.isAbsolute(value)) {
    throw new TypeError(`${label} must be an absolute path.`);
  }
  return value;
}

export function getFleetDataDir(env = process.env, platform = process.platform, home) {
  if (platform === "win32") {
    const localAppData = env.LOCALAPPDATA;
    if (!localAppData) {
      throw new Error("LOCALAPPDATA is required on Windows.");
    }
    requireAbsolute(localAppData, path.win32, "LOCALAPPDATA");
    return path.win32.join(localAppData, APP_DIRECTORY);
  }

  requireAbsolute(home, path.posix, "Home directory");
  if (platform === "darwin") {
    return path.posix.join(home, "Library", "Application Support", APP_DIRECTORY);
  }

  if (env.XDG_STATE_HOME) {
    requireAbsolute(env.XDG_STATE_HOME, path.posix, "XDG_STATE_HOME");
    return path.posix.join(env.XDG_STATE_HOME, APP_DIRECTORY);
  }
  return path.posix.join(home, ".local", "state", APP_DIRECTORY);
}

export async function workspaceKey(workspacePath, options = {}) {
  if (typeof workspacePath !== "string" || workspacePath.length === 0) {
    throw new TypeError("Workspace path must be a non-empty string.");
  }

  const platform = options.platform ?? process.platform;
  const platformPath = platform === "win32" ? path.win32 : path.posix;
  let canonical = platformPath.resolve(workspacePath);

  if (platform === process.platform && options.realpath !== false) {
    try {
      canonical = await fs.realpath(canonical);
    } catch (error) {
      if (error.code !== "ENOENT") {
        throw error;
      }
    }
  }

  canonical = platformPath.normalize(canonical);
  if (platform === "win32") {
    canonical = canonical.toLowerCase();
  }

  return crypto.createHash("sha256").update(canonical, "utf8").digest("hex").slice(0, 32);
}

export function resolveOwnedPath(root, ...segments) {
  if (typeof root !== "string" || !path.isAbsolute(root)) {
    throw new TypeError("Owned data root must be an absolute path.");
  }

  const canonicalRoot = path.resolve(root);
  const candidate = path.resolve(canonicalRoot, ...segments);
  const relative = path.relative(canonicalRoot, candidate);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error("Resolved path is outside owned data root.");
  }
  return candidate;
}
