import assert from "node:assert/strict";
import test from "node:test";
import { operatorFooter } from "../plugins/fleet/scripts/lib/operator-guide.mjs";
import { displayWidth } from "../plugins/fleet/scripts/lib/tui-render.mjs";

test("every supported footer width preserves complete return controls", () => {
  const views = [
    { selectedLane: { status: "running" } },
    { selectedLane: { status: "complete" } },
    { selectedGroup: { id: "group" } },
    { scope: "native", selectedLane: { status: "observed", controlAvailable: false } },
    {}
  ];
  for (const view of views) {
    for (let columns = 32; columns <= 200; columns++) {
      const footer = operatorFooter(view, columns);
      assert.ok(displayWidth(footer) <= columns, `Footer exceeds ${columns} columns: ${footer}`);
      assert.match(footer, /Ctrl\+G(?::)? (?:Back|Return)/);
      if (view.scope === "native") assert.doesNotMatch(footer, /Cancel|Send|Open agent/);
    }
  }
});
