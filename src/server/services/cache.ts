/**
 * Production-grade LRU cache with TTL, stale-while-revalidate, and metrics.
 * Inspired by industrial multi-agent caching patterns.
 */

interface CacheEntry<T> {
  value: T;
  createdAt: number;
  expiresAt: number;
  staleAt: number;
  hits: number;
}

interface LRUCacheOptions {
  maxSize: number;
  defaultTtlMs: number;
  staleTtlMs: number;
  name: string;
}

export class LRUCache<T = unknown> {
  private readonly cache = new Map<string, CacheEntry<T>>();
  private readonly maxSize: number;
  private readonly defaultTtlMs: number;
  private readonly staleTtlMs: number;
  private readonly name: string;
  private totalHits = 0;
  private totalMisses = 0;
  private totalEvictions = 0;

  constructor(options: LRUCacheOptions) {
    this.maxSize = options.maxSize;
    this.defaultTtlMs = options.defaultTtlMs;
    this.staleTtlMs = options.staleTtlMs;
    this.name = options.name;
  }

  get(key: string): { value: T; stale: boolean } | null {
    const entry = this.cache.get(key);
    if (!entry) {
      this.totalMisses++;
      return null;
    }

    const now = Date.now();

    if (now > entry.expiresAt) {
      this.cache.delete(key);
      this.totalMisses++;
      return null;
    }

    // Move to end (most recently used)
    this.cache.delete(key);
    entry.hits++;
    this.cache.set(key, entry);
    this.totalHits++;

    return {
      value: entry.value,
      stale: now > entry.staleAt
    };
  }

  set(key: string, value: T, ttlMs?: number): void {
    const effectiveTtl = ttlMs ?? this.defaultTtlMs;
    const now = Date.now();

    // Evict oldest if at capacity
    if (this.cache.size >= this.maxSize && !this.cache.has(key)) {
      const oldestKey = this.cache.keys().next().value;
      if (oldestKey !== undefined) {
        this.cache.delete(oldestKey);
        this.totalEvictions++;
      }
    }

    this.cache.set(key, {
      value,
      createdAt: now,
      staleAt: now + effectiveTtl,
      expiresAt: now + effectiveTtl + this.staleTtlMs,
      hits: 0
    });
  }

  invalidate(key: string): boolean {
    return this.cache.delete(key);
  }

  invalidatePrefix(prefix: string): number {
    let count = 0;
    for (const key of this.cache.keys()) {
      if (key.startsWith(prefix)) {
        this.cache.delete(key);
        count++;
      }
    }
    return count;
  }

  clear(): void {
    this.cache.clear();
  }

  getMetrics() {
    const total = this.totalHits + this.totalMisses;
    return {
      name: this.name,
      size: this.cache.size,
      maxSize: this.maxSize,
      hits: this.totalHits,
      misses: this.totalMisses,
      evictions: this.totalEvictions,
      hitRate: total > 0 ? Math.round((this.totalHits / total) * 10000) / 100 : 0
    };
  }

  /** Generate a weak ETag from cache entry metadata */
  getETag(key: string): string | null {
    const entry = this.cache.get(key);
    if (!entry) return null;
    return `W/"${entry.createdAt.toString(36)}-${entry.hits.toString(36)}"`;
  }
}

// Singleton caches for different data domains
export const questionCache = new LRUCache<unknown>({
  maxSize: 200,
  defaultTtlMs: 30_000,
  staleTtlMs: 60_000,
  name: "questions"
});

export const dashboardCache = new LRUCache<unknown>({
  maxSize: 50,
  defaultTtlMs: 15_000,
  staleTtlMs: 30_000,
  name: "dashboard"
});

export const sessionCache = new LRUCache<unknown>({
  maxSize: 500,
  defaultTtlMs: 60_000,
  staleTtlMs: 120_000,
  name: "sessions"
});

export function getAllCacheMetrics() {
  return [
    questionCache.getMetrics(),
    dashboardCache.getMetrics(),
    sessionCache.getMetrics()
  ];
}
