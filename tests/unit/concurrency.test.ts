import { describe, it, expect, vi } from "vitest";
import { Semaphore, RequestQueue, CircuitBreaker } from "../../src/server/services/concurrency";

describe("Semaphore", () => {
  it("should allow up to maxPermits concurrent operations", async () => {
    const sem = new Semaphore(2);
    let concurrent = 0;
    let maxConcurrent = 0;

    const task = () => sem.withPermit(async () => {
      concurrent++;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      await new Promise((r) => setTimeout(r, 50));
      concurrent--;
    });

    await Promise.all([task(), task(), task(), task()]);
    expect(maxConcurrent).toBe(2);
  });

  it("should track metrics", async () => {
    const sem = new Semaphore(1);
    await sem.withPermit(async () => {});
    const metrics = sem.getMetrics();
    expect(metrics.totalAcquires).toBe(1);
    expect(metrics.availablePermits).toBe(1);
  });

  it("should queue waiters when all permits are taken", async () => {
    const sem = new Semaphore(1);
    const order: number[] = [];

    const p1 = sem.withPermit(async () => {
      order.push(1);
      await new Promise((r) => setTimeout(r, 30));
    });

    const p2 = sem.withPermit(async () => {
      order.push(2);
    });

    await Promise.all([p1, p2]);
    expect(order).toEqual([1, 2]);
  });
});

describe("RequestQueue", () => {
  it("should process requests up to concurrency limit", async () => {
    const queue = new RequestQueue(2, 100);
    let concurrent = 0;
    let maxConcurrent = 0;

    const promises = Array.from({ length: 6 }, () =>
      queue.enqueue(async () => {
        concurrent++;
        maxConcurrent = Math.max(maxConcurrent, concurrent);
        await new Promise((r) => setTimeout(r, 20));
        concurrent--;
        return "done";
      })
    );

    const results = await Promise.all(promises);
    expect(results.every((r) => r === "done")).toBe(true);
    expect(maxConcurrent).toBeLessThanOrEqual(2);
  });

  it("should reject when queue is full", async () => {
    const queue = new RequestQueue(1, 2);
    const blockers = Array.from({ length: 3 }, () =>
      queue.enqueue(() => new Promise((r) => setTimeout(r, 500)))
    );

    await expect(
      queue.enqueue(async () => "overflow")
    ).rejects.toThrow("capacity");

    // Clean up
    await Promise.allSettled(blockers);
  });

  it("should track metrics", async () => {
    const queue = new RequestQueue(5, 100);
    await queue.enqueue(async () => "ok");
    const metrics = queue.getMetrics();
    expect(metrics.totalProcessed).toBe(1);
    expect(metrics.totalRejected).toBe(0);
  });
});

describe("CircuitBreaker", () => {
  it("should pass through when closed", async () => {
    const cb = new CircuitBreaker(3, 100);
    const result = await cb.execute(async () => "success");
    expect(result).toBe("success");
    expect(cb.getState().state).toBe("closed");
  });

  it("should open after failure threshold", async () => {
    const cb = new CircuitBreaker(2, 100);
    const fail = () => cb.execute(async () => { throw new Error("fail"); });

    await expect(fail()).rejects.toThrow("fail");
    await expect(fail()).rejects.toThrow("fail");

    // Circuit should now be open
    await expect(
      cb.execute(async () => "should not run")
    ).rejects.toThrow("temporarily unavailable");
    expect(cb.getState().state).toBe("open");
  });

  it("should transition to half-open after reset timeout", async () => {
    vi.useFakeTimers();
    const cb = new CircuitBreaker(1, 100, 1);
    await expect(cb.execute(async () => { throw new Error("fail"); })).rejects.toThrow();

    vi.advanceTimersByTime(200);
    // Should allow one try in half-open state
    const result = await cb.execute(async () => "recovered");
    expect(result).toBe("recovered");
    expect(cb.getState().state).toBe("closed");

    vi.useRealTimers();
  });
});
