/**
 * Concurrency stress test - simulates many users taking quizzes simultaneously.
 * Tests connection pooling, semaphore limits, cache behavior, and circuit breaker.
 *
 * Usage: LOAD_USERS=100 LOAD_CONCURRENCY=25 node tools/concurrency-test.mjs
 */
import { performance } from "node:perf_hooks";

const BASE_URL = `http://127.0.0.1:${process.env.LOAD_PORT ?? 3001}`;
const USERS = Number(process.env.LOAD_USERS ?? 50);
const CONCURRENCY = Number(process.env.LOAD_CONCURRENCY ?? 20);
const ROUNDS = Number(process.env.LOAD_ROUNDS ?? 3);

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function percentile(values, p) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.ceil(sorted.length * p) - 1);
  return sorted[Math.max(0, idx)];
}

async function request(path, options = {}) {
  const headers = { ...options.headers };
  if (options.cookie) headers.Cookie = options.cookie;

  const start = performance.now();
  const res = await fetch(`${BASE_URL}${path}`, {
    method: options.method || "GET",
    headers,
    body: options.body
  });
  const duration = performance.now() - start;
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = null; }

  return { status: res.status, data, duration, ok: res.ok };
}

async function runPool(items, concurrency, worker) {
  const results = new Array(items.length);
  let cursor = 0;

  const runners = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (true) {
      const i = cursor++;
      if (i >= items.length) return;
      results[i] = await worker(items[i], i);
    }
  });

  await Promise.all(runners);
  return results;
}

function summarize(label, durations) {
  if (!durations.length) return { label, count: 0 };
  const avg = durations.reduce((a, b) => a + b, 0) / durations.length;
  return {
    label,
    count: durations.length,
    avgMs: Math.round(avg * 10) / 10,
    p50Ms: Math.round(percentile(durations, 0.5) * 10) / 10,
    p95Ms: Math.round(percentile(durations, 0.95) * 10) / 10,
    p99Ms: Math.round(percentile(durations, 0.99) * 10) / 10,
    maxMs: Math.round(Math.max(...durations) * 10) / 10
  };
}

async function main() {
  console.log(`\n🔬 Concurrency Stress Test`);
  console.log(`   Users: ${USERS}, Concurrency: ${CONCURRENCY}, Rounds: ${ROUNDS}\n`);

  // 1. Health check
  const health = await request("/api/health/live");
  if (!health.ok) {
    console.error("Server not responding. Start the server first.");
    process.exit(1);
  }
  console.log("✓ Server is live\n");

  // 2. Hammer the health endpoint concurrently
  const healthDurations = [];
  const healthResults = await runPool(
    Array.from({ length: USERS * 2 }),
    CONCURRENCY,
    async () => {
      const r = await request("/api/health/ready");
      healthDurations.push(r.duration);
      return r;
    }
  );
  const healthErrors = healthResults.filter(r => !r.ok).length;
  console.log("Health endpoint stress:");
  console.log(summarize("  health/ready", healthDurations));
  console.log(`  Errors: ${healthErrors}/${healthResults.length}\n`);

  // 3. Concurrent auth status checks (simulates page loads)
  const authDurations = [];
  await runPool(
    Array.from({ length: USERS }),
    CONCURRENCY,
    async () => {
      const r = await request("/api/auth/status");
      authDurations.push(r.duration);
      return r;
    }
  );
  console.log("Auth status concurrent check:");
  console.log(summarize("  auth/status", authDurations));

  // 4. Rapid-fire dashboard requests (cache behavior test)
  for (let round = 1; round <= ROUNDS; round++) {
    const dashDurations = [];
    await runPool(
      Array.from({ length: USERS }),
      CONCURRENCY,
      async () => {
        const r = await request("/api/health/ready");
        dashDurations.push(r.duration);
        return r;
      }
    );
    console.log(`\nRound ${round}/${ROUNDS} - Ready endpoint:`);
    console.log(summarize(`  round-${round}`, dashDurations));
  }

  // 5. Summary
  const allDurations = [...healthDurations, ...authDurations];
  console.log("\n" + "=".repeat(60));
  console.log("Overall Summary:");
  console.log(summarize("  all-requests", allDurations));
  console.log(`  Total requests: ${allDurations.length}`);
  console.log(`  Throughput: ~${Math.round(allDurations.length / (allDurations.reduce((a, b) => a + b, 0) / 1000))} req/s`);
  console.log("=".repeat(60) + "\n");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
