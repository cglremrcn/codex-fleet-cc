import { chmod, lstat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { isMainModule } from "../plugins/fleet/scripts/lib/is-main.mjs";

export async function ensureNodePtyHelperPermissions({
  root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."),
  platform = process.platform,
  arch = process.arch,
} = {}) {
  if (platform !== "darwin") {
    return { changed: false, reason: "not-macos" };
  }

  if (arch !== "x64" && arch !== "arm64") {
    throw new Error(`Unsupported macOS architecture for node-pty: ${arch}`);
  }

  const helperPath = path.join(
    root,
    "node_modules",
    "node-pty",
    "prebuilds",
    `darwin-${arch}`,
    "spawn-helper",
  );
  const before = await lstat(helperPath);
  if (!before.isFile() || before.isSymbolicLink()) {
    throw new Error(`Refusing to chmod an unexpected node-pty helper: ${helperPath}`);
  }

  await chmod(helperPath, 0o755);
  const after = await lstat(helperPath);
  if ((after.mode & 0o111) === 0) {
    throw new Error(`node-pty helper is still not executable: ${helperPath}`);
  }

  return { changed: true, path: helperPath };
}

if (isMainModule(import.meta.url)) {
  const result = await ensureNodePtyHelperPermissions();
  if (result.changed) {
    process.stdout.write(`Prepared node-pty helper: ${result.path}\n`);
  }
}
