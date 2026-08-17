const ENTER_ALT_SCREEN = "\u001b[?1049h";
const LEAVE_ALT_SCREEN = "\u001b[?1049l";
const HIDE_CURSOR = "\u001b[?25l";
const SHOW_CURSOR = "\u001b[?25h";
const ENABLE_MOUSE = "\u001b[?1000h\u001b[?1006h";
const DISABLE_MOUSE = "\u001b[?1006l\u001b[?1000l";

const SIGNAL_EXIT_CODES = Object.freeze({ SIGINT: 130, SIGTERM: 143 });

function assertTerminal(io) {
  if (!io || typeof io !== "object") throw new TypeError("Terminal IO is required");
  if (!io.stdin?.isTTY || !io.stdout?.isTTY) {
    throw new Error("Fleet Console requires an interactive TTY");
  }
  if (typeof io.stdin.setRawMode !== "function") {
    throw new Error("Fleet Console requires raw-mode input support");
  }
  if (typeof io.stdout.write !== "function") {
    throw new Error("Fleet Console requires a writable terminal");
  }
}

function removeListener(target, event, handler) {
  if (typeof target.off === "function") target.off(event, handler);
  else if (typeof target.removeListener === "function") target.removeListener(event, handler);
}

export async function withTerminalSession(io, run) {
  assertTerminal(io);
  if (typeof run !== "function") throw new TypeError("Terminal session callback is required");

  const lifecycle = io.lifecycle ?? process;
  const previousRawMode = io.stdin.isRaw === true;
  const abortController = new AbortController();
  const handlers = new Map();
  let modesEntered = false;
  let rawModeChanged = false;
  let inputResumed = false;
  let restored = false;

  function restore() {
    if (restored) return;
    restored = true;
    for (const [event, handler] of handlers) removeListener(lifecycle, event, handler);
    handlers.clear();
    if (modesEntered) {
      try {
        io.stdout.write(`${DISABLE_MOUSE}${SHOW_CURSOR}${LEAVE_ALT_SCREEN}`);
      } catch {
        // A closed output cannot be repaired; raw input restoration still must run.
      }
    }
    if (rawModeChanged) {
      try {
        io.stdin.setRawMode(previousRawMode);
      } catch {
        // The stream may already be closed during process teardown.
      }
    }
    if (inputResumed && typeof io.stdin.pause === "function") {
      try {
        io.stdin.pause();
      } catch {
        // Ignore teardown races after the terminal has already detached.
      }
    }
  }

  function register(event, handler) {
    if (typeof lifecycle.on !== "function") return;
    handlers.set(event, handler);
    lifecycle.on(event, handler);
  }

  for (const signal of ["SIGINT", "SIGTERM"]) {
    register(signal, () => {
      restore();
      abortController.abort(signal);
      lifecycle.exitCode = SIGNAL_EXIT_CODES[signal];
      if (typeof io.onSignal === "function") io.onSignal(signal);
    });
  }
  register("exit", restore);

  try {
    modesEntered = true;
    io.stdout.write(`${ENTER_ALT_SCREEN}${HIDE_CURSOR}${ENABLE_MOUSE}`);
    io.stdin.setRawMode(true);
    rawModeChanged = true;
    if (typeof io.stdin.resume === "function") {
      io.stdin.resume();
      inputResumed = true;
    }
    return await run(Object.freeze({ signal: abortController.signal, restore }));
  } finally {
    restore();
  }
}
