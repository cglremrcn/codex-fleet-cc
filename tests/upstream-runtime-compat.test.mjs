// Ported from openai/codex-plugin-cc at db52e28f4d9ded852ab3942cea316258ae4ef346.
// Import paths were changed for Codex Fleet's isolated upstream runtime directory.

import assert from "node:assert/strict";
import test from "node:test";

import {
  createBrokerEndpoint,
  parseBrokerEndpoint
} from "../plugins/fleet/scripts/lib/broker-endpoint.mjs";

test("inherited broker endpoints use Unix sockets outside Windows", () => {
  const endpoint = createBrokerEndpoint("/tmp/cxc-12345", "darwin");
  assert.equal(endpoint, "unix:/tmp/cxc-12345/broker.sock");
  assert.deepEqual(parseBrokerEndpoint(endpoint), {
    kind: "unix",
    path: "/tmp/cxc-12345/broker.sock"
  });
});

test("inherited broker endpoints use named pipes on Windows", () => {
  const endpoint = createBrokerEndpoint("C:\\Temp\\cxc-12345", "win32");
  assert.equal(endpoint, "pipe:\\\\.\\pipe\\cxc-12345-codex-app-server");
  assert.deepEqual(parseBrokerEndpoint(endpoint), {
    kind: "pipe",
    path: "\\\\.\\pipe\\cxc-12345-codex-app-server"
  });
});
