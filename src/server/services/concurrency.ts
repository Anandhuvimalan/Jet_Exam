/**
 * Concurrency control primitives for industrial-grade request handling.
 * Semaphore for limiting concurrent DB-heavy operations.
 * Request queue with backpressure and timeout.
 */

interface QueuedTask<T> {
  execute: () => Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
  enqueuedAt: number;
  timeoutMs: number;
}

export class Semaphore {
  private permits: number;
  private readonly maxPermits: number;
  private readonly waitQueue: Array<() => void> = [];
  private totalAcquires = 0;
  private totalWaits = 0;
  private maxQueueDepth = 0;

  constructor(maxPermits: number) {
    this.permits = maxPermits;
    this.maxPermits = maxPermits;
  }

  async acquire(): Promise<void> {
    this.totalAcquires++;

    if (this.permits > 0) {
      this.permits--;
      return;
    }

    this.totalWaits++;
    this.maxQueueDepth = Math.max(this.maxQueueDepth, this.waitQueue.length + 1);

    return new Promise<void>((resolve) => {
      this.waitQueue.push(resolve);
    });
  }

  release(): void {
    const next = this.waitQueue.shift();
    if (next) {
      next();
    } else {
      this.permits = Math.min(this.permits + 1, this.maxPermits);
    }
  }

  async withPermit<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await fn();
    } finally {
      this.release();
    }
  }

  getMetrics() {
    return {
      availablePermits: this.permits,
      maxPermits: this.maxPermits,
      queueDepth: this.waitQueue.length,
      totalAcquires: this.totalAcquires,
      totalWaits: this.totalWaits,
      maxQueueDepth: this.maxQueueDepth
    };
  }
}

export class RequestQueue<T = unknown> {
  private readonly queue: Array<QueuedTask<T>> = [];
  private activeCount = 0;
  private readonly maxConcurrent: number;
  private readonly maxQueueSize: number;
  private totalProcessed = 0;
  private totalRejected = 0;
  private totalTimedOut = 0;

  constructor(maxConcurrent: number, maxQueueSize = 1000) {
    this.maxConcurrent = maxConcurrent;
    this.maxQueueSize = maxQueueSize;
  }

  enqueue(execute: () => Promise<T>, timeoutMs = 30_000): Promise<T> {
    if (this.queue.length >= this.maxQueueSize) {
      this.totalRejected++;
      return Promise.reject(new Error("Server is at capacity. Please try again shortly."));
    }

    return new Promise<T>((resolve, reject) => {
      this.queue.push({
        execute,
        resolve,
        reject,
        enqueuedAt: Date.now(),
        timeoutMs
      });
      this.processNext();
    });
  }

  private processNext(): void {
    if (this.activeCount >= this.maxConcurrent || this.queue.length === 0) {
      return;
    }

    const task = this.queue.shift();
    if (!task) return;

    const elapsed = Date.now() - task.enqueuedAt;
    if (elapsed > task.timeoutMs) {
      this.totalTimedOut++;
      task.reject(new Error("Request timed out while waiting in queue."));
      this.processNext();
      return;
    }

    this.activeCount++;
    task.execute()
      .then((result) => {
        this.totalProcessed++;
        task.resolve(result);
      })
      .catch((error) => {
        task.reject(error);
      })
      .finally(() => {
        this.activeCount--;
        this.processNext();
      });
  }

  getMetrics() {
    return {
      activeCount: this.activeCount,
      queuedCount: this.queue.length,
      maxConcurrent: this.maxConcurrent,
      maxQueueSize: this.maxQueueSize,
      totalProcessed: this.totalProcessed,
      totalRejected: this.totalRejected,
      totalTimedOut: this.totalTimedOut
    };
  }
}

/**
 * Circuit breaker to protect against cascading failures.
 * States: closed (normal) -> open (failing) -> half-open (testing)
 */
export class CircuitBreaker {
  private state: "closed" | "open" | "half-open" = "closed";
  private failures = 0;
  private lastFailureAt = 0;
  private successesSinceHalfOpen = 0;
  private readonly failureThreshold: number;
  private readonly resetTimeoutMs: number;
  private readonly halfOpenSuccessThreshold: number;

  constructor(
    failureThreshold = 5,
    resetTimeoutMs = 30_000,
    halfOpenSuccessThreshold = 2
  ) {
    this.failureThreshold = failureThreshold;
    this.resetTimeoutMs = resetTimeoutMs;
    this.halfOpenSuccessThreshold = halfOpenSuccessThreshold;
  }

  async execute<T>(fn: () => Promise<T>): Promise<T> {
    if (this.state === "open") {
      if (Date.now() - this.lastFailureAt > this.resetTimeoutMs) {
        this.state = "half-open";
        this.successesSinceHalfOpen = 0;
      } else {
        throw new Error("Service temporarily unavailable. Please try again later.");
      }
    }

    try {
      const result = await fn();

      if (this.state === "half-open") {
        this.successesSinceHalfOpen++;
        if (this.successesSinceHalfOpen >= this.halfOpenSuccessThreshold) {
          this.state = "closed";
          this.failures = 0;
        }
      } else {
        this.failures = 0;
      }

      return result;
    } catch (error) {
      this.failures++;
      this.lastFailureAt = Date.now();

      if (this.failures >= this.failureThreshold) {
        this.state = "open";
      }

      throw error;
    }
  }

  getState() {
    return {
      state: this.state,
      failures: this.failures,
      failureThreshold: this.failureThreshold
    };
  }
}

// Singleton instances for the quiz submission pipeline
export const quizSubmitSemaphore = new Semaphore(20);
export const quizSubmitQueue = new RequestQueue(50, 500);
export const dbCircuitBreaker = new CircuitBreaker(10, 60_000, 3);
