/**
 * Cleanups that must run however the process ends: normal return, thrown
 * error, uncaught exception, SIGINT or SIGTERM.
 */
const cleanups = new Set<() => Promise<unknown>>();

export function registerCleanup(fn: () => Promise<unknown>): () => void {
  cleanups.add(fn);
  return () => cleanups.delete(fn);
}

export async function runCleanups(): Promise<void> {
  const fns = [...cleanups];
  cleanups.clear();
  await Promise.allSettled(fns.map((fn) => fn()));
}

export interface SignalWatch {
  signal: AbortSignal;
  received(): NodeJS.Signals | undefined;
  dispose(): void;
}

/**
 * Turn SIGINT/SIGTERM into an abort, so the drill stops sending and its
 * `finally` revokes the key. A second signal only prints a reminder: exiting
 * then would leave the key behind.
 */
export function watchSignals(onSecond: () => void): SignalWatch {
  const ac = new AbortController();
  let got: NodeJS.Signals | undefined;
  const handler = (sig: NodeJS.Signals) => {
    if (got) {
      onSecond();
      return;
    }
    got = sig;
    ac.abort(new Error(`received ${sig}`));
  };
  process.on("SIGINT", handler);
  process.on("SIGTERM", handler);
  return {
    signal: ac.signal,
    received: () => got,
    dispose: () => {
      process.off("SIGINT", handler);
      process.off("SIGTERM", handler);
    },
  };
}
