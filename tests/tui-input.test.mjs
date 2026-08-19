import assert from "node:assert/strict";
import test from "node:test";

import {
  createInputDecoder,
  reduceInput
} from "../plugins/fleet/scripts/lib/tui-input.mjs";

test("decoder handles arrow and SGR mouse sequences split across chunks", () => {
  const decoder = createInputDecoder();

  assert.deepEqual(decoder.push(Buffer.from("\u001b[")), []);
  assert.deepEqual(decoder.push(Buffer.from("B")), [{ type: "move", delta: 1 }]);
  assert.deepEqual(decoder.push(Buffer.from("\u001b[<0;12;5M")), [
    { type: "mouseDown", button: 0, column: 12, row: 5 }
  ]);
});

test("decoder maps dashboard keys including keyboard-layout-safe help and return", () => {
  const decoder = createInputDecoder();
  const events = decoder.push(Buffer.from("jk\r\t/?hemxrcp\u0007q"));

  assert.deepEqual(events, [
    { type: "move", delta: 1 },
    { type: "move", delta: -1 },
    { type: "activate" },
    { type: "cyclePanel", delta: 1 },
    { type: "filter" },
    { type: "help" },
    { type: "help" },
    { type: "edit" },
    { type: "message" },
    { type: "cancel" },
    { type: "reconcile" },
    { type: "confirm" },
    { type: "toggleMotion" },
    { type: "quit" },
    { type: "quit" }
  ]);
});

test("decoder maps both common F1 sequences to help", () => {
  const decoder = createInputDecoder();

  assert.deepEqual(decoder.push(Buffer.from("\u001bOP\u001b[11~")), [
    { type: "help" },
    { type: "help" }
  ]);
});

test("decoder handles reverse panel navigation, mouse release, and wheel", () => {
  const decoder = createInputDecoder();
  const events = decoder.push(Buffer.from(
    "\u001b[Z\u001b[<0;9;4m\u001b[<64;9;4M\u001b[<65;9;4M"
  ));

  assert.deepEqual(events, [
    { type: "cyclePanel", delta: -1 },
    { type: "mouseUp", button: 0, column: 9, row: 4 },
    { type: "move", delta: -1, source: "mouse" },
    { type: "move", delta: 1, source: "mouse" }
  ]);
});

test("incomplete escape input is bounded and recoverable", () => {
  const decoder = createInputDecoder({ maxPendingBytes: 64 });

  assert.deepEqual(decoder.push(Buffer.from(`\u001b[${"1".repeat(63)}`)), [
    { type: "invalidInput", reason: "escape-sequence-too-long" }
  ]);
  assert.equal(decoder.pendingBytes, 0);
  assert.deepEqual(decoder.push(Buffer.from("j")), [{ type: "move", delta: 1 }]);
});

test("standalone Escape is emitted only when the decoder is flushed", () => {
  const decoder = createInputDecoder();

  assert.deepEqual(decoder.push(Buffer.from("\u001b")), []);
  assert.deepEqual(decoder.flush(), [{ type: "quit" }]);
});

test("filter text mode captures navigation letters without triggering controls", () => {
  const decoder = createInputDecoder();
  decoder.setTextMode(true);

  assert.deepEqual(decoder.push(Buffer.from("jak\u007f\r")), [
    { type: "text", value: "j" },
    { type: "text", value: "a" },
    { type: "text", value: "k" },
    { type: "backspace" },
    { type: "applyFilter" }
  ]);
  assert.deepEqual(decoder.push(Buffer.from("\u001b")), []);
  assert.deepEqual(decoder.flush(), [{ type: "clearFilter" }]);
});

test("composer mode captures shortcuts and emits submit or discard events", () => {
  const decoder = createInputDecoder();
  decoder.setTextMode("composer");

  assert.deepEqual(decoder.push(Buffer.from("jmk\u007f\r")), [
    { type: "text", value: "j" },
    { type: "text", value: "m" },
    { type: "text", value: "k" },
    { type: "backspace" },
    { type: "submitMessage" }
  ]);
  assert.deepEqual(decoder.push(Buffer.from("\u001b")), []);
  assert.deepEqual(decoder.flush(), [{ type: "discardMessage" }]);
});

test("Ctrl+G leaves the embedded Codex session even while composing", () => {
  const decoder = createInputDecoder();
  decoder.setTextMode("composer");

  assert.deepEqual(decoder.push(Buffer.from("\u0007")), [{ type: "closeSession" }]);
});

test("input reducer changes only local console state", () => {
  const initial = {
    laneCount: 3,
    selectedIndex: 0,
    panelIndex: 0,
    panelCount: 5,
    motion: true,
    exitRequested: false
  };

  const selected = reduceInput(initial, { type: "move", delta: -1 });
  const switched = reduceInput(selected, { type: "cyclePanel", delta: -1 });
  const paused = reduceInput(switched, { type: "toggleMotion" });
  const exited = reduceInput(paused, { type: "quit" });

  assert.equal(selected.selectedIndex, 2);
  assert.equal(switched.panelIndex, 4);
  assert.equal(paused.motion, false);
  assert.equal(exited.exitRequested, true);
  assert.deepEqual(initial, {
    laneCount: 3,
    selectedIndex: 0,
    panelIndex: 0,
    panelCount: 5,
    motion: true,
    exitRequested: false
  });
});
