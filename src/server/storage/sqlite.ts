import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";

type SqliteDatabase = Database.Database;

const databaseCache = new Map<string, SqliteDatabase>();

export function resolveSqlitePath(storagePath: string): string {
  return storagePath.replace(/\.json$/i, ".sqlite");
}

export function getLegacyJsonPath(storagePath: string): string | null {
  return storagePath.toLowerCase().endsWith(".json") ? storagePath : null;
}

export function openSqliteDatabase(storagePath: string): SqliteDatabase {
  const sqlitePath = resolveSqlitePath(storagePath);
  const cached = databaseCache.get(sqlitePath);
  if (cached) {
    return cached;
  }

  mkdirSync(dirname(sqlitePath), { recursive: true });
  const database = new Database(sqlitePath, { timeout: 5000 });
  database.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    PRAGMA synchronous = NORMAL;
  `);
  databaseCache.set(sqlitePath, database);
  return database;
}

export function withTransaction<T>(database: SqliteDatabase, callback: () => T): T {
  database.exec("BEGIN IMMEDIATE");

  try {
    const result = callback();
    database.exec("COMMIT");
    return result;
  } catch (error) {
    try {
      database.exec("ROLLBACK");
    } catch {
      // Ignore rollback errors after a failed write.
    }

    throw error;
  }
}

export function readJsonFile<T>(filePath: string | null): T | null {
  if (!filePath || !existsSync(filePath)) {
    return null;
  }

  return JSON.parse(readFileSync(filePath, "utf8")) as T;
}
