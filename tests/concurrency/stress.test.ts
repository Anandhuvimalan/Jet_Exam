import { describe, it, expect } from "vitest";
import { Semaphore, RequestQueue, CircuitBreaker } from "../../src/server/services/concurrency";
import { LRUCache } from "../../src/server/services/cache";

describe("Concurrency Stress Tests", () => {
  describe("Semaphore under heavy load", () => {
    it("should handle 200 concurrent tasks with limit of 10", async () => {
      const sem = new Semaphore(10);
      let concurrent = 0;
      let maxConcurrent = 0;
      let completed = 0;

      const tasks = Array.from({ length: 200 }, (_, i) =>
        sem.withPermit(async () => {
          concurrent++;
          maxConcurrent = Math.max(maxConcurrent, concurrent);
          // Simulate varying work durations
          await new Promise((r) => setTimeout(r, Math.random() * 10));
          concurrent--;
          completed++;
          return i;
        })
      );

      const results = await Promise.all(tasks);
      expect(results.length).toBe(200);
      expect(completed).toBe(200);
      expect(maxConcurrent).toBeLessThanOrEqual(10);
      expect(concurrent).toBe(0);
    });
  });

  describe("RequestQueue under backpressure", () => {
    it("should process all requests under load without data loss", async () => {
      const queue = new RequestQueue(5, 500);
      const processed = new Set<number>();

      const promises = Array.from({ length: 100 }, (_, i) =>
        queue.enqueue(async () => {
          await new Promise((r) => setTimeout(r, Math.random() * 5));
          processed.add(i);
          return i;
        })
      );

      const results = await Promise.all(promises);
      expect(results.length).toBe(100);
      expect(processed.size).toBe(100);

      const metrics = queue.getMetrics();
      expect(metrics.totalProcessed).toBe(100);
      expect(metrics.totalRejected).toBe(0);
    });

    it("should correctly reject overflow requests", async () => {
      const queue = new RequestQueue(1, 5);
      const results: Array<"ok" | "rejected"> = [];

      const promises = Array.from({ length: 20 }, () =>
        queue.enqueue(async () => {
          await new Promise((r) => setTimeout(r, 50));
          return "ok" as const;
        }).catch(() => "rejected" as const)
      );

      const outcomes = await Promise.all(promises);
      const okCount = outcomes.filter((r) => r === "ok").length;
      const rejectedCount = outcomes.filter((r) => r === "rejected").length;

      expect(okCount + rejectedCount).toBe(20);
      expect(rejectedCount).toBeGreaterThan(0);
    });
  });

  describe("CircuitBreaker under failure storms", () => {
    it("should open and recover after failures subside", async () => {
      const cb = new CircuitBreaker(3, 50, 2);
      let shouldFail = true;

      // Cause failures to open the circuit
      for (let i = 0; i < 3; i++) {
        await cb.execute(async () => {
          if (shouldFail) throw new Error("db down");
          return "ok";
        }).catch(() => {});
      }

      expect(cb.getState().state).toBe("open");

      // Wait for reset timeout
      await new Promise((r) => setTimeout(r, 100));

      // Fix the service
      shouldFail = false;

      // Half-open should allow test requests
      const result1 = await cb.execute(async () => "recovered-1");
      expect(result1).toBe("recovered-1");
      const result2 = await cb.execute(async () => "recovered-2");
      expect(result2).toBe("recovered-2");

      expect(cb.getState().state).toBe("closed");
    });
  });

  describe("LRU Cache under concurrent access", () => {
    it("should handle rapid concurrent reads and writes", async () => {
      const cache = new LRUCache<number>({
        maxSize: 100,
        defaultTtlMs: 5000,
        staleTtlMs: 10000,
        name: "stress-test"
      });

      // Parallel writes
      const writePromises = Array.from({ length: 500 }, (_, i) =>
        Promise.resolve().then(() => cache.set(`key-${i % 100}`, i))
      );
      await Promise.all(writePromises);

      // Parallel reads
      const readResults = await Promise.all(
        Array.from({ length: 500 }, (_, i) =>
          Promise.resolve().then(() => cache.get(`key-${i % 100}`))
        )
      );

      const hits = readResults.filter((r) => r !== null).length;
      expect(hits).toBeGreaterThan(0);

      const metrics = cache.getMetrics();
      expect(metrics.size).toBeLessThanOrEqual(100);
    });

    it("should correctly evict under pressure", () => {
      const cache = new LRUCache<string>({
        maxSize: 10,
        defaultTtlMs: 60000,
        staleTtlMs: 60000,
        name: "eviction-stress"
      });

      // Write 100 items into cache with maxSize 10
      for (let i = 0; i < 100; i++) {
        cache.set(`key-${i}`, `value-${i}`);
      }

      // Only last 10 should survive
      expect(cache.getMetrics().size).toBe(10);
      expect(cache.getMetrics().evictions).toBe(90);

      // Latest entries should be present
      for (let i = 90; i < 100; i++) {
        expect(cache.get(`key-${i}`)?.value).toBe(`value-${i}`);
      }

      // Earliest entries should be evicted
      for (let i = 0; i < 80; i++) {
        expect(cache.get(`key-${i}`)).toBeNull();
      }
    });
  });
});
