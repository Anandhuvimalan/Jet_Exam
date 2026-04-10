/**
 * Structured logging with request tracing, performance metrics, and log levels.
 * Wraps Fastify's pino logger with domain-specific context.
 */

import type { FastifyBaseLogger } from "fastify";

export interface RequestMetrics {
  method: string;
  url: string;
  statusCode: number;
  durationMs: number;
  userId?: string;
  userRole?: string;
  cacheHit?: boolean;
}

export interface PerformanceSnapshot {
  timestamp: string;
  uptimeSeconds: number;
  memoryUsageMB: {
    rss: number;
    heapUsed: number;
    heapTotal: number;
    external: number;
  };
  activeHandles: number;
  activeRequests: number;
}

let serverStartedAt = Date.now();

export function markServerStarted(): void {
  serverStartedAt = Date.now();
}

export function getPerformanceSnapshot(): PerformanceSnapshot {
  const mem = process.memoryUsage();
  return {
    timestamp: new Date().toISOString(),
    uptimeSeconds: Math.round((Date.now() - serverStartedAt) / 1000),
    memoryUsageMB: {
      rss: Math.round(mem.rss / 1024 / 1024 * 100) / 100,
      heapUsed: Math.round(mem.heapUsed / 1024 / 1024 * 100) / 100,
      heapTotal: Math.round(mem.heapTotal / 1024 / 1024 * 100) / 100,
      external: Math.round(mem.external / 1024 / 1024 * 100) / 100
    },
    activeHandles: (process as NodeJS.Process & { _getActiveHandles?(): unknown[] })._getActiveHandles?.().length ?? 0,
    activeRequests: (process as NodeJS.Process & { _getActiveRequests?(): unknown[] })._getActiveRequests?.().length ?? 0
  };
}

export function logRequestMetrics(logger: FastifyBaseLogger, metrics: RequestMetrics): void {
  const level = metrics.statusCode >= 500 ? "error" : metrics.statusCode >= 400 ? "warn" : "info";
  const msg = `${metrics.method} ${metrics.url} ${metrics.statusCode} ${metrics.durationMs}ms`;

  if (level === "error") {
    logger.error({ req: metrics }, msg);
  } else if (level === "warn") {
    logger.warn({ req: metrics }, msg);
  } else if (metrics.durationMs > 1000) {
    logger.warn({ req: metrics, slow: true }, `SLOW ${msg}`);
  } else {
    logger.info({ req: metrics }, msg);
  }
}

/** Track slow query patterns for monitoring */
const slowQueries: Array<{ query: string; durationMs: number; timestamp: string }> = [];
const MAX_SLOW_QUERIES = 50;

export function trackSlowQuery(query: string, durationMs: number): void {
  if (durationMs < 500) return;

  slowQueries.push({
    query: query.slice(0, 200),
    durationMs,
    timestamp: new Date().toISOString()
  });

  if (slowQueries.length > MAX_SLOW_QUERIES) {
    slowQueries.shift();
  }
}

export function getSlowQueries() {
  return [...slowQueries];
}
