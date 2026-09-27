import assert from "node:assert/strict";
import test from "node:test";
import { operatorFooter } from "../plugins/fleet/scripts/lib/operator-guide.mjs";
import { displayWidth, stripAnsi } from "../plugins/fleet/scripts/lib/tui-render.mjs";
import { createConsoleController } from "../plugins/fleet/scripts/lib/console-controller.mjs";

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

test("controller search and notice footers fit wide Unicode without splitting graphemes", async () => {
  for (const columns of [1, 16, 32, 40, 80, 120]) {
    for (const value of ["界".repeat(100), "🧑‍💻".repeat(100), "e\u0301".repeat(100)]) {
      let screen;
      const controller = createConsoleController({ snapshot: { lanes: [] },
        terminal: { columns, rows: 18 }, preferences: { color: false },
        write: (text) => { screen = text; }
      });
      try {
        await controller.dispatch({ type: "invalidInput", reason: value });
        const notice = stripAnsi(screen).split("\n").at(-1);
        assert.ok(displayWidth(notice) <= columns);
        const retained = notice.replace(/…$/u, "");
        const unit = value.startsWith("界") ? "界" : value.startsWith("🧑") ? "🧑‍💻" : "e\u0301";
        assert.equal(retained, unit.repeat(Array.from(new Intl.Segmenter("en", {
          granularity: "grapheme"
        }).segment(retained)).length));
        await controller.dispatch({ type: "filter" });
        await controller.dispatch({ type: "text", value: value.slice(0, 100) });
        assert.ok(displayWidth(stripAnsi(screen).split("\n").at(-1)) <= columns);
      } finally { controller.dispose(); }
    }
  }
});
