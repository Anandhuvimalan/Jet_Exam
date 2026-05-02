import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Pool, type PoolClient, type QueryResultRow } from "pg";

type PostgresPool = Pool;
export type PostgresQueryable = Pool | PoolClient;
export type PostgresTransactionLockKey = readonly [number, number];

const poolCache = new Map<string, PostgresPool>();
const schemaApplied = new Set<string>();

export const POSTGRES_SYNC_LOCKS = {
  platform: [83_001, 1] as const,
  questions: [83_001, 2] as const
} as const;

function shouldUseInsecureSsl(connectionString: string): boolean {
  if (/sslmode=disable/i.test(connectionString)) {
    return false;
  }

  if (/sslmode=require/i.test(connectionString)) {
    return true;
  }

  return false;
}

function parseConnectionConfig(connectionString: string): {
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
} {
  const parsed = new URL(connectionString);

  return {
    host: parsed.hostname,
    port: parsed.port ? Number(parsed.port) : 5432,
    database: parsed.pathname.replace(/^\/+/, "") || "postgres",
    user: decodeURIComponent(parsed.username),
    password: decodeURIComponent(parsed.password)
  };
}

export function openPostgresPool(connectionString: string): PostgresPool {
  const normalized = connectionString.trim();
  const cached = poolCache.get(normalized);
  if (cached) {
    return cached;
  }

  const parsedConnection = parseConnectionConfig(normalized);
  const poolConfig = {
    host: parsedConnection.host,
    port: parsedConnection.port,
    database: parsedConnection.database,
    user: parsedConnection.user,
    password: parsedConnection.password,
    ssl: shouldUseInsecureSsl(normalized) ? { rejectUnauthorized: false } : undefined,
    max: 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
    statement_timeout: 10_000,
    keepAlive: true,
    keepAliveInitialDelayMillis: 10_000
  } as unknown as ConstructorParameters<typeof Pool>[0];
  const pool = new Pool(poolConfig);

  // Handle idle client errors gracefully instead of crashing the process.
  // Railway (and other cloud proxies) routinely reset idle TCP connections,
  // which causes pg to emit 'error' on the pool. Without this handler
  // Node.js treats the unhandled 'error' event as fatal and exits.
  pool.on("error", (err) => {
    console.error("[pg-pool] Idle client error (connection will be recycled):", err.message);
  });

  poolCache.set(normalized, pool);
  return pool;
}

export async function applyPostgresSchema(pool: PostgresPool, rootDir = process.cwd()): Promise<void> {
  const cacheKey = [pool.options.host ?? "", pool.options.port ?? "", pool.options.database ?? "", pool.options.user ?? ""].join("|");
  if (schemaApplied.has(cacheKey)) {
    return;
  }

  const schemaPath = join(rootDir, "database", "schema.sql");
  const schemaSql = readFileSync(schemaPath, "utf8");

  // Retry schema application to handle transient connection timeouts
  // during Railway cold starts or proxy reconnections.
  const maxRetries = 3;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      await pool.query(schemaSql);
      schemaApplied.add(cacheKey);
      return;
    } catch (error) {
      const isRetryable =
        error instanceof Error &&
        (error.message.includes("Connection terminated") ||
         error.message.includes("ECONNRESET") ||
         error.message.includes("timeout"));

      if (!isRetryable || attempt === maxRetries) {
        throw error;
      }

      const delayMs = attempt * 2_000;
      console.warn(`[pg] Schema apply failed (attempt ${attempt}/${maxRetries}), retrying in ${delayMs}ms:`, error.message);
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
}

export async function withPostgresTransaction<T>(
  pool: PostgresPool,
  callback: (client: PoolClient) => Promise<T>,
  lockKey?: PostgresTransactionLockKey
): Promise<T> {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");
    if (lockKey) {
      await client.query("SELECT pg_advisory_xact_lock($1, $2)", [lockKey[0], lockKey[1]]);
    }
    const result = await callback(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch {
      // Ignore rollback errors after a failed write.
    }

    throw error;
  } finally {
    client.release();
  }
}

export async function queryOne<T extends QueryResultRow>(
  queryable: PostgresQueryable,
  text: string,
  values: unknown[] = []
): Promise<T | null> {
  const result = await queryable.query<T>(text, values);
  return result.rows[0] ?? null;
}

export async function queryMany<T extends QueryResultRow>(
  queryable: PostgresQueryable,
  text: string,
  values: unknown[] = []
): Promise<T[]> {
  const result = await queryable.query<T>(text, values);
  return result.rows;
}

export function readJsonFile<T>(filePath: string | null): T | null {
  if (!filePath || !existsSync(filePath)) {
    return null;
  }

  return JSON.parse(readFileSync(filePath, "utf8")) as T;
}
