const ESCAPE = "\u001b";
const DEFAULT_MAX_PENDING_BYTES = 64;

const KEY_EVENTS = Object.freeze({
  j: Object.freeze({ type: "move", delta: 1 }),
  k: Object.freeze({ type: "move", delta: -1 }),
  "\r": Object.freeze({ type: "activate" }),
  "\n": Object.freeze({ type: "activate" }),
  "\t": Object.freeze({ type: "cyclePanel", delta: 1 }),
  "/": Object.freeze({ type: "filter" }),
  "?": Object.freeze({ type: "help" }),
  e: Object.freeze({ type: "edit" }),
  m: Object.freeze({ type: "message" }),
  x: Object.freeze({ type: "cancel" }),
  r: Object.freeze({ type: "reconcile" }),
  c: Object.freeze({ type: "confirm" }),
  p: Object.freeze({ type: "toggleMotion" }),
  q: Object.freeze({ type: "quit" })
});

const CSI_EVENTS = Object.freeze({
  A: Object.freeze({ type: "move", delta: -1 }),
  B: Object.freeze({ type: "move", delta: 1 }),
  C: Object.freeze({ type: "cyclePanel", delta: 1 }),
  D: Object.freeze({ type: "cyclePanel", delta: -1 }),
  Z: Object.freeze({ type: "cyclePanel", delta: -1 })
});

function positiveInteger(value, fallback) {
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

function decodeMouse(match) {
  const code = Number.parseInt(match[1], 10);
  const column = Number.parseInt(match[2], 10);
  const row = Number.parseInt(match[3], 10);
  if (![code, column, row].every(Number.isSafeInteger)) {
    return { type: "invalidInput", reason: "invalid-mouse-sequence" };
  }
  if ((code & 64) === 64) {
    return { type: "move", delta: (code & 1) === 0 ? -1 : 1, source: "mouse" };
  }
  const button = code & 3;
  return {
    type: match[4] === "M" ? "mouseDown" : "mouseUp",
    button,
    column,
    row
  };
}

function firstCsiTerminator(value) {
  for (let index = 2; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0x40 && code <= 0x7e) return index;
  }
  return -1;
}

export function createInputDecoder(options = {}) {
  const maxPendingBytes = positiveInteger(
    options.maxPendingBytes,
    DEFAULT_MAX_PENDING_BYTES
  );
  let pending = Buffer.alloc(0);
  let textMode = null;

  function rejectOversizedEscape(events) {
    if (pending.length <= maxPendingBytes || pending[0] !== 0x1b) return false;
    pending = Buffer.alloc(0);
    events.push({ type: "invalidInput", reason: "escape-sequence-too-long" });
    return true;
  }

  function push(chunk) {
    const incoming = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk ?? ""));
    pending = Buffer.concat([pending, incoming]);
    const events = [];

    while (pending.length > 0) {
      if (rejectOversizedEscape(events)) break;
      const value = pending.toString("utf8");
      if (value[0] !== ESCAPE) {
        const character = value[0];
        const byteLength = Buffer.byteLength(character);
        pending = pending.subarray(byteLength);
        if (textMode) {
          if (character === "\r" || character === "\n") {
            events.push({ type: textMode === "composer" ? "submitMessage" : "applyFilter" });
          } else if (character === "\b" || character === "\u007f") {
            events.push({ type: "backspace" });
          } else if (character.codePointAt(0) >= 0x20) {
            events.push({ type: "text", value: character });
          }
          continue;
        }
        const event = KEY_EVENTS[character.toLowerCase()] ?? KEY_EVENTS[character];
        if (event) events.push({ ...event });
        continue;
      }
      if (pending.length === 1) break;
      if (value[1] !== "[") {
        pending = pending.subarray(1);
        events.push({ type: "quit" });
        continue;
      }

      const mouse = /^\u001b\[<(\d{1,3});(\d{1,5});(\d{1,5})([Mm])/.exec(value);
      if (mouse) {
        pending = pending.subarray(Buffer.byteLength(mouse[0]));
        events.push(decodeMouse(mouse));
        continue;
      }

      const terminator = firstCsiTerminator(value);
      if (terminator === -1) {
        if (!rejectOversizedEscape(events)) break;
        continue;
      }
      const sequence = value.slice(0, terminator + 1);
      pending = pending.subarray(Buffer.byteLength(sequence));
      const event = sequence.length === 3 ? CSI_EVENTS[sequence[2]] : null;
      if (event) events.push({ ...event });
    }
    return events;
  }

  function flush() {
    if (pending.length === 0) return [];
    const escapeType = textMode === "composer"
      ? "discardMessage"
      : textMode === "filter" ? "clearFilter" : "quit";
    const events = pending.equals(Buffer.from(ESCAPE))
      ? [{ type: escapeType }]
      : [{ type: "invalidInput", reason: "incomplete-escape-sequence" }];
    pending = Buffer.alloc(0);
    return events;
  }

  return Object.freeze({
    push,
    flush,
    setTextMode(value) {
      textMode = value === "composer" ? "composer" : value === true || value === "filter"
        ? "filter"
        : null;
    },
    get pendingBytes() {
      return pending.length;
    }
  });
}

function wrapIndex(value, count) {
  if (count <= 0) return 0;
  return ((value % count) + count) % count;
}

export function reduceInput(state, event) {
  const source = state && typeof state === "object" ? state : {};
  const next = { ...source };
  if (!event || typeof event !== "object") return next;
  if (event.type === "move") {
    const count = Number.isInteger(source.laneCount) ? source.laneCount : 0;
    const current = Number.isInteger(source.selectedIndex) ? source.selectedIndex : 0;
    next.selectedIndex = wrapIndex(current + (event.delta < 0 ? -1 : 1), count);
  } else if (event.type === "cyclePanel") {
    const count = Number.isInteger(source.panelCount) ? source.panelCount : 0;
    const current = Number.isInteger(source.panelIndex) ? source.panelIndex : 0;
    next.panelIndex = wrapIndex(current + (event.delta < 0 ? -1 : 1), count);
  } else if (event.type === "toggleMotion") {
    next.motion = source.motion !== false ? false : true;
  } else if (event.type === "quit") {
    next.exitRequested = true;
  }
  return next;
}
