interface Bucket {
  tokens: number;
  lastRefill: number;
}

/** How long a {@link TokenBucketMap} keeps a bucket nobody has drawn on, in milliseconds. */
const STALE_BUCKET_MS = 5 * 60 * 1000;
/** How often a {@link TokenBucketMap} discards its stale buckets, in milliseconds. */
const SWEEP_INTERVAL_MS = 60 * 1000;

/**
 * A rate limiter holding up to `capacity` tokens, refilled continuously at
 * `refillRate` tokens per second. It starts full.
 */
export class TokenBucket {
  private tokens: number;
  private lastRefill: number;

  constructor(
    private readonly capacity: number,
    private readonly refillRate: number
  ) {
    this.tokens = capacity;
    this.lastRefill = Date.now();
  }

  /** Takes `n` tokens and returns `true`, or returns `false` and takes none when fewer than `n` remain. */
  consume(n = 1): boolean {
    const now = Date.now();
    const elapsed = (now - this.lastRefill) / 1000;
    this.tokens = Math.min(this.capacity, this.tokens + elapsed * this.refillRate);
    this.lastRefill = now;
    if (this.tokens < n) return false;
    this.tokens -= n;
    return true;
  }
}

/**
 * Rate limiters keyed by string, such as a client address, each holding up to
 * `capacity` tokens refilled continuously at `refillRate` tokens per second,
 * and starting full. A key's bucket is discarded once nobody has drawn on it
 * for five minutes. Call {@link dispose} when done with the map.
 */
export class TokenBucketMap {
  private readonly buckets = new Map<string, Bucket>();
  private readonly sweepTimer: ReturnType<typeof setInterval>;

  constructor(
    private readonly capacity: number,
    private readonly refillRate: number
  ) {
    this.sweepTimer = setInterval(() => this.sweep(), SWEEP_INTERVAL_MS);
    this.sweepTimer.unref();
  }

  /** Takes `n` tokens from `key`'s bucket and returns `true`, or returns `false` and takes none when fewer than `n` remain. */
  consume(key: string, n = 1): boolean {
    const now = Date.now();
    let bucket = this.buckets.get(key);
    if (!bucket) {
      bucket = { tokens: this.capacity, lastRefill: now };
      this.buckets.set(key, bucket);
    } else {
      const elapsed = (now - bucket.lastRefill) / 1000;
      bucket.tokens = Math.min(this.capacity, bucket.tokens + elapsed * this.refillRate);
      bucket.lastRefill = now;
    }
    if (bucket.tokens < n) return false;
    bucket.tokens -= n;
    return true;
  }

  private sweep(): void {
    const now = Date.now();
    for (const [key, bucket] of this.buckets) {
      if (now - bucket.lastRefill > STALE_BUCKET_MS) {
        this.buckets.delete(key);
      }
    }
  }

  /** Stops discarding stale buckets and discards every bucket. */
  dispose(): void {
    clearInterval(this.sweepTimer);
    this.buckets.clear();
  }
}
