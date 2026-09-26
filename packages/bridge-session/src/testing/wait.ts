/** How long a testkit wait lasts before it fails, in milliseconds. */
export const WAIT_MS = 2000;

/** Resolves or rejects as `promise` does; rejects naming `what` when `promise` has not settled within {@link WAIT_MS}. */
export function within<T>(promise: Promise<T>, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`timed out waiting for ${what}`));
    }, WAIT_MS);
  });
  return Promise.race([promise, timeout]).finally(() => {
    clearTimeout(timer);
  });
}

/** Resolves after `ms` milliseconds. */
export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
