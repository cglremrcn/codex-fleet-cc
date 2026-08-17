import fs from "node:fs";
import path from "node:path";

import {
  buildEnv,
  installFakeCodex
} from "../upstream/fake-codex-fixture.mjs";
import { makeTempDir } from "../helpers.mjs";

export function startFakeCodex(t, behavior = "review-ok") {
  const root = makeTempDir("codex-fleet-runtime-");
  installFakeCodex(root, behavior);
  const statePath = path.join(root, "fake-codex-state.json");
  const scriptPath = path.join(root, "codex");

  t.after(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  return {
    command: {
      executable: process.execPath,
      args: [scriptPath]
    },
    dataDir: path.join(root, "fleet-data"),
    env: buildEnv(root),
    workspace: root,
    readState() {
      return fs.existsSync(statePath)
        ? JSON.parse(fs.readFileSync(statePath, "utf8"))
        : {};
    },
    appServerStarts() {
      return this.readState().appServerStarts ?? 0;
    }
  };
}
