import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

import { createAppServerBroker } from "../plugins/fleet/scripts/app-server-broker.mjs";

const events = [];
const disposableRoot = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-app-server-smoke-"));
fs.writeFileSync(
  path.join(disposableRoot, "package.json"),
  `${JSON.stringify({ name: "fleet-disposable-probe", private: true })}\n`,
  "utf8"
);
let resolveCompleted;
const completed = new Promise((resolve) => {
  resolveCompleted = resolve;
});
const broker = await createAppServerBroker({
  codexCommand: "codex",
  cwd: disposableRoot,
  env: process.env,
  onProtocolMessage(summary) {
    events.push(summary);
    if (events.length > 256) events.shift();
    if (summary.method === "turn/completed") resolveCompleted();
  }
});

try {
  const skillCatalog = await broker.request("skills/list", {
    cwds: [disposableRoot],
    forceReload: true
  });
  const imageSkill = (Array.isArray(skillCatalog?.data) ? skillCatalog.data : [])
    .flatMap((group) => Array.isArray(group?.skills) ? group.skills : [])
    .find((skill) => skill?.name === "imagegen");
  const thread = await broker.request("thread/start", {
    cwd: disposableRoot,
    model: "gpt-5.6-sol",
    approvalPolicy: "never",
    sandbox: "read-only",
    serviceName: "codex_fleet_cc_diagnostic",
    ephemeral: true
  });
  await broker.request("turn/start", {
    threadId: thread.thread.id,
    input: [{
      type: "text",
      text: "Read package.json and reply LIVE_APP_SERVER_OK plus the package name. Do not edit files."
    }],
    model: "gpt-5.6-sol",
    effort: "high",
    outputSchema: null
  });
  const finished = await Promise.race([
    completed.then(() => true),
    new Promise((resolve) => setTimeout(() => resolve(false), 60_000))
  ]);
  process.stdout.write(`${JSON.stringify({
    schemaVersion: 1,
    finished,
    imagegen: {
      discovered: Boolean(imageSkill),
      enabled: imageSkill?.enabled === true,
      system: imageSkill?.scope === "system",
      safePath: typeof imageSkill?.path === "string"
        && path.isAbsolute(imageSkill.path)
        && path.basename(imageSkill.path).toLowerCase() === "skill.md"
    },
    events
  })}\n`);
  if (!finished) process.exitCode = 1;
} finally {
  await broker.close();
  fs.rmSync(disposableRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
