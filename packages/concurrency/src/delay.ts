export interface DelayOptions {
  /** Abort the wait. The promise rejects with `signal.reason`. */
  readonly signal?: AbortSignal | undefined;
}

/**
 * Wait `ms` milliseconds. Rejects with `signal.reason` if the signal aborts first
 * (the timer is cleared, so an aborted delay never keeps the process alive).
 */
export function delay(ms: number, { signal }: DelayOptions = {}): Promise<void> {
  if (!(typeof ms === "number" && ms >= 0)) {
    return Promise.reject(
      new TypeError(`Expected \`ms\` to be a number >= 0, got \`${String(ms)}\``),
    );
  }
  if (signal?.aborted) return Promise.reject(signal.reason);

  const { promise, resolve, reject } = Promise.withResolvers<void>();
  const onAbort = (): void => {
    clearTimeout(timer);
    reject(signal?.reason);
  };
  const timer = setTimeout(() => {
    signal?.removeEventListener("abort", onAbort);
    resolve();
  }, ms);
  signal?.addEventListener("abort", onAbort, { once: true });
  return promise;
}
