// Long-running work the daemon must not be restarted under (browser sessions, metrics scrapes, publishes).
let count = 0;

/** Count `p` as in flight until it settles. Returns `p`. */
export function track<T>(p: Promise<T>): Promise<T> {
  count++;
  return p.finally(() => {
    count--;
  });
}

export function inFlight(): number {
  return count;
}
