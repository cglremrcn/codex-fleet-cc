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
  let active = false;
  let resumedForActive = false;
  let closed = false;

  function leave() {
    if (!active) return;
    active = false;
    try {
      io.stdout.write(`${DISABLE_MOUSE}${SHOW_CURSOR}${LEAVE_ALT_SCREEN}`);
    } catch {
      // A closed output cannot be repaired; raw input restoration still must run.
    }
    try {
      io.stdin.setRawMode(previousRawMode);
    } catch {
      // The stream may already be closed during process teardown.
    }
    if (resumedForActive && typeof io.stdin.pause === "function") {
      try {
        io.stdin.pause();
      } catch {
        // Ignore teardown races after the terminal has already detached.
      }
    }
    resumedForActive = false;
  }

  function enter() {
    if (closed || active) return;
    active = true;
    try {
      io.stdout.write(`${ENTER_ALT_SCREEN}${HIDE_CURSOR}${ENABLE_MOUSE}`);
      io.stdin.setRawMode(true);
      if (typeof io.stdin.resume === "function") {
        io.stdin.resume();
        resumedForActive = true;
      }
    } catch (error) {
      leave();
      throw error;
    }
  }

  function restore() {
    if (closed) return;
    closed = true;
    for (const [event, handler] of handlers) removeListener(lifecycle, event, handler);
    handlers.clear();
    leave();
  }

  async function suspend(operation) {
    if (typeof operation !== "function") {
      throw new TypeError("Suspended terminal operation must be a function");
    }
    if (closed) throw new Error("Terminal session is already closed");
    leave();
    try {
      return await operation();
    } finally {
      if (!closed) enter();
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
    enter();
    return await run(Object.freeze({ signal: abortController.signal, restore, suspend }));
  } finally {
    restore();
  }
}
