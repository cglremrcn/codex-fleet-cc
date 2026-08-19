import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

import { isMainModule } from "../plugins/fleet/scripts/lib/is-main.mjs";

test("main module detection canonicalizes filesystem aliases", () => {
  const canonical = path.resolve("root", "private", "var", "fleet-console.mjs");
  const alias = path.resolve("root", "var", "fleet-console.mjs");
  const realpath = (value) => value === alias ? canonical : value;

  assert.equal(isMainModule(pathToFileURL(canonical).href, alias, realpath), true);
});

test("main module detection rejects imports and missing argv paths", () => {
  const entry = path.resolve("root", "fleet-console.mjs");
  const imported = path.resolve("root", "other.mjs");
  const identity = (value) => value;

  assert.equal(isMainModule(pathToFileURL(imported).href, entry, identity), false);
  assert.equal(isMainModule(pathToFileURL(imported).href, null, identity), false);
});
