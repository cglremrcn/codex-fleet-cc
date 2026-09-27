import { ControlError } from "./control-contract.mjs";

/** One bounded local snapshot read shared by waiters, never model/shell polling. */
export function createControlWait({ snapshot, feed, intervalMs = 250, maxWaiters = 16, now = () => performance.now() }) {
  const waiters = new Set();
  let timer = null, pending = null, disposed = false;
  function finish(waiter, value, error) {
    if (!waiters.delete(waiter)) return;
    if (error) waiter.reject(error); else waiter.resolve(value);
  }
  function schedule() {
    clearTimeout(timer); timer = null;
    if (disposed || !waiters.size) return;
    const delay = Math.max(1, Math.min(intervalMs, ...[...waiters].map((waiter) => waiter.deadline - now())));
    timer = setTimeout(tick, delay); timer.unref?.();
  }
  function tick() {
    if (disposed) return;
    for (const waiter of waiters) {
      if (now() >= waiter.deadline) finish(waiter, { changed: false, timedOut: true, reason: "timeout", next: "observe" });
    }
    if (!pending && waiters.size) {
      const read = Promise.resolve().then(snapshot); pending = read;
      read.then((value) => {
        if (disposed) return;
        for (const waiter of waiters) {
          try {
            const compared = feed.compare(value, waiter.cursor, waiter.includeUsage);
            if (!waiter.cursor) waiter.cursor = compared.cursor;
            else if (compared.changed) { finish(waiter, { changed: true, timedOut: false, reason: compared.reason, next: "observe" }); continue; }
            if (compared.totals && !compared.totals.active && !compared.totals.queued && !compared.totals.attention && !compared.totals.archivedAttention) {
              finish(waiter, { changed: false, timedOut: false, reason: "idle", next: "observe" });
            }
          } catch (error) { finish(waiter, null, error); }
        }
      }, () => {
        for (const waiter of [...waiters]) finish(waiter, null, new ControlError("CONTROL_OBSERVATION_FAILED", "The local observation failed; no empty-fleet conclusion was made."));
      }).finally(() => { if (pending === read) pending = null; schedule(); });
    }
    schedule();
  }
  return Object.freeze({
    wait(params) {
      if (disposed) return Promise.reject(new ControlError("CONTROL_CLOSED", "The observer is closed."));
      if (waiters.size >= maxWaiters) return Promise.reject(new ControlError("CONTROL_WAIT_LIMIT", "Too many concurrent waits; share one observer."));
      return new Promise((resolve, reject) => {
        waiters.add({ resolve, reject, cursor: params.cursor ?? null, includeUsage: params.includeUsage === true,
          deadline: now() + (params.timeoutMs ?? 600_000) });
        tick();
      });
    },
    hasWaiters: () => waiters.size > 0,
    stats: () => ({ waiters: waiters.size, pendingRead: Boolean(pending) }),
    dispose() {
      disposed = true; clearTimeout(timer); timer = null;
      for (const waiter of [...waiters]) finish(waiter, null, new ControlError("CONTROL_CLOSED", "The supervisor observation ended; observe again before acting."));
    }
  });
}
