import { describe, it, expect, beforeEach, vi } from "vitest";
import { LRUCache } from "../../src/server/services/cache";

describe("LRUCache", () => {
  let cache: LRUCache<string>;

  beforeEach(() => {
    cache = new LRUCache({
      maxSize: 3,
      defaultTtlMs: 5000,
      staleTtlMs: 10000,
      name: "test"
    });
  });

  it("should store and retrieve values", () => {
    cache.set("key1", "value1");
    const result = cache.get("key1");
    expect(result).not.toBeNull();
    expect(result!.value).toBe("value1");
    expect(result!.stale).toBe(false);
  });

  it("should return null for missing keys", () => {
    expect(cache.get("nonexistent")).toBeNull();
  });

  it("should evict oldest entries when at capacity", () => {
    cache.set("a", "1");
    cache.set("b", "2");
    cache.set("c", "3");
    cache.set("d", "4"); // should evict "a"
    expect(cache.get("a")).toBeNull();
    expect(cache.get("d")!.value).toBe("4");
  });

  it("should promote recently accessed entries (LRU)", () => {
    cache.set("a", "1");
    cache.set("b", "2");
    cache.set("c", "3");
    cache.get("a"); // promote "a"
    cache.set("d", "4"); // should evict "b" (oldest unused)
    expect(cache.get("a")!.value).toBe("1");
    expect(cache.get("b")).toBeNull();
  });

  it("should expire entries after TTL + stale window", () => {
    vi.useFakeTimers();
    cache.set("key", "value", 100); // 100ms TTL
    expect(cache.get("key")!.stale).toBe(false);

    vi.advanceTimersByTime(200); // past TTL but in stale window
    const staleResult = cache.get("key");
    expect(staleResult).not.toBeNull();
    expect(staleResult!.stale).toBe(true);

    vi.advanceTimersByTime(15000); // past stale window
    expect(cache.get("key")).toBeNull();

    vi.useRealTimers();
  });

  it("should invalidate by key", () => {
    cache.set("key", "value");
    expect(cache.invalidate("key")).toBe(true);
    expect(cache.get("key")).toBeNull();
  });

  it("should invalidate by prefix", () => {
    cache.set("admin:dashboard", "d1");
    cache.set("admin:questions", "q1");
    cache.set("student:dashboard", "s1");
    const count = cache.invalidatePrefix("admin:");
    expect(count).toBe(2);
    expect(cache.get("student:dashboard")!.value).toBe("s1");
  });

  it("should track metrics correctly", () => {
    cache.set("a", "1");
    cache.get("a"); // hit
    cache.get("b"); // miss
    cache.get("a"); // hit

    const metrics = cache.getMetrics();
    expect(metrics.name).toBe("test");
    expect(metrics.size).toBe(1);
    expect(metrics.hits).toBe(2);
    expect(metrics.misses).toBe(1);
    expect(metrics.hitRate).toBe(66.67);
  });

  it("should generate ETags", () => {
    cache.set("key", "value");
    const etag = cache.getETag("key");
    expect(etag).not.toBeNull();
    expect(etag!.startsWith('W/"')).toBe(true);
  });

  it("should clear all entries", () => {
    cache.set("a", "1");
    cache.set("b", "2");
    cache.clear();
    expect(cache.getMetrics().size).toBe(0);
  });
});
