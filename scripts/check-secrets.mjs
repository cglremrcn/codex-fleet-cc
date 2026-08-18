import { execFile as execFileCallback } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const RULES = Object.freeze([
  ["private-key", /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/u],
  ["openai-api-key", /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/u],
  ["github-token", /\bgh[pousr]_[A-Za-z0-9]{30,}\b/u],
  ["aws-access-key", /\bAKIA[0-9A-Z]{16}\b/u],
  ["google-api-key", /\bAIza[0-9A-Za-z_-]{30,}\b/u],
  ["slack-token", /\bxox[baprs]-[0-9A-Za-z-]{20,}\b/u]
]);

function safeRelativePath(root, relativePath) {
  if (typeof relativePath !== "string" || path.isAbsolute(relativePath)) return null;
  const resolved = path.resolve(root, relativePath);
  const prefix = `${path.resolve(root)}${path.sep}`;
  return resolved.startsWith(prefix) ? resolved : null;
}

export function scanText(file, text) {
  const findings = [];
  const lines = String(text).split(/\r?\n/u);
  for (let index = 0; index < lines.length; index += 1) {
    for (const [rule, pattern] of RULES) {
      if (pattern.test(lines[index])) findings.push({ file, line: index + 1, rule });
    }
  }
  return findings;
}

async function trackedFiles(root) {
  const { stdout } = await execFile("git", ["ls-files", "-z"], {
    cwd: root,
    encoding: "buffer",
    maxBuffer: 16 * 1024 * 1024,
    windowsHide: true
  });
  return stdout.toString("utf8").split("\u0000").filter(Boolean);
}

export async function scanRepository(root, options = {}) {
  const files = options.files ?? await trackedFiles(root);
  const findings = [];
  let scannedFiles = 0;
  for (const relativePath of [...files].sort()) {
    const absolutePath = safeRelativePath(root, relativePath);
    if (!absolutePath) {
      findings.push({ file: String(relativePath), line: 0, rule: "path-outside-root" });
      continue;
    }
    const metadata = await fs.lstat(absolutePath);
    if (metadata.isSymbolicLink()) {
      findings.push({ file: relativePath, line: 0, rule: "symlink-not-scanned" });
      continue;
    }
    if (!metadata.isFile()) continue;
    scannedFiles += 1;
    if (metadata.size > MAX_FILE_BYTES) {
      findings.push({ file: relativePath, line: 0, rule: "oversized-not-scanned" });
      continue;
    }
    const content = await fs.readFile(absolutePath);
    if (content.includes(0)) continue;
    findings.push(...scanText(relativePath, content.toString("utf8")));
  }
  return Object.freeze({
    schemaVersion: 1,
    ok: findings.length === 0,
    scannedFiles,
    findings
  });
}

const isMain = process.argv[1]
  && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMain) {
  try {
    const report = await scanRepository(process.cwd());
    process.stdout.write(`${JSON.stringify(report)}\n`);
    process.exitCode = report.ok ? 0 : 1;
  } catch (error) {
    process.stderr.write(`Secret scan failed: ${error.message}\n`);
    process.exitCode = 1;
  }
}
