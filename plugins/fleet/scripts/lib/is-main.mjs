import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

function canonicalPath(value, realpath) {
  const resolved = path.resolve(value);
  try {
    return realpath(resolved);
  } catch {
    return resolved;
  }
}

export function isMainModule(
  metaUrl,
  argvPath = process.argv[1],
  realpath = fs.realpathSync.native
) {
  if (!argvPath) return false;
  return canonicalPath(argvPath, realpath) === canonicalPath(fileURLToPath(metaUrl), realpath);
}
