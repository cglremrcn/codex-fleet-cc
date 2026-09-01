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
    },
    registerCleanup(...resources) {
      t.after(async () => {
        const failures = [];
        for (const resource of resources) {
          try {
            await resource.close();
          } catch (error) {
            failures.push(error);
          }
        }
        try {
          fs.rmSync(root, {
            recursive: true,
            force: true,
            maxRetries: 10,
            retryDelay: 50
          });
        } catch (error) {
          failures.push(error);
        }
        if (failures.length > 0) {
          throw new AggregateError(failures, "Fake Codex cleanup failed.");
        }
      });
    }
  };
}
