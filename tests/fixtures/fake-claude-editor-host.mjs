import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { spawn } from "node:child_process";

function digest(filePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

if (process.argv[2] === "--editor") {
  const draftPath = path.resolve(process.argv[3]);
  process.stdout.write(`FAKE_EDITOR:OPEN:${path.basename(draftPath)}\n`);
  process.exit(0);
}

const draftPath = path.resolve(process.argv[2]);
const consolePath = path.resolve(process.argv[3]);
const before = digest(draftPath);
process.stdout.write(`CLAUDE_HOST:BEFORE:${before}\n`);

const child = spawn(process.execPath, [consolePath, "--plain", draftPath], {
  cwd: process.cwd(),
  env: {
    ...process.env,
    NO_COLOR: "1",
    FLEET_ASCII: "1",
    FLEET_REDUCED_MOTION: "1",
    FLEET_ORIGINAL_EDITOR_JSON: JSON.stringify([
      process.execPath,
      path.resolve(import.meta.dirname, "fake-claude-editor-host.mjs"),
      "--editor"
    ])
  },
  shell: false,
  stdio: "inherit",
  windowsHide: true
});

child.once("error", (error) => {
  process.stderr.write(`CLAUDE_HOST:ERROR:${error.message}\n`);
  process.exitCode = 1;
});
child.once("exit", (code, signal) => {
  const after = digest(draftPath);
  process.stdout.write(
    `CLAUDE_HOST:AFTER:${after}:UNCHANGED=${String(before === after)}:CONSOLE=${signal ?? code}\n`
  );
  process.exitCode = code ?? 1;
});
