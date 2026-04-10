import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface ServerRuntimeConfig {
  nodeEnv: "development" | "test" | "production";
  isProduction: boolean;
  host: string;
  port: number;
  trustProxy: boolean;
  appOrigin: string | null;
  corsOrigins: string[];
  logLevel: "debug" | "info" | "warn" | "error";
  bodyLimitBytes: number;
  rateLimitMax: number;
  rateLimitWindowMs: number;
  authRateLimitMax: number;
  sessionCookieSecure: boolean;
  sessionCookieSameSite: "Strict" | "Lax";
  databaseUrl: string | null;
  googleClientId: string | null;
  superAdminEmail: string;
}

let cachedConfig: ServerRuntimeConfig | null = null;

function parseEnvValue(value: string): string {
  const trimmed = value.trim();

  if ((trimmed.startsWith("\"") && trimmed.endsWith("\"")) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1);
  }

  return trimmed;
}

function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) {
    return fallback;
  }

  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) {
    return true;
  }

  if (["0", "false", "no", "off"].includes(normalized)) {
    return false;
  }

  return fallback;
}

function parsePositiveInteger(value: string | undefined, fallback: number, minimum = 1): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum) {
    return fallback;
  }

  return parsed;
}

function parseOrigins(value: string | undefined): string[] {
  if (!value?.trim()) {
    return [];
  }

  return [...new Set(
    value
      .split(",")
      .map((origin) => origin.trim())
      .filter(Boolean)
  )];
}

export function loadProjectEnv(rootDir = process.cwd()): void {
  for (const fileName of [".env.local", ".env"]) {
    const filePath = join(rootDir, fileName);
    if (!existsSync(filePath)) {
      continue;
    }

    const content = readFileSync(filePath, "utf8");
    for (const rawLine of content.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith("#")) {
        continue;
      }

      const separatorIndex = line.indexOf("=");
      if (separatorIndex <= 0) {
        continue;
      }

      const key = line.slice(0, separatorIndex).trim();
      if (!key || process.env[key] !== undefined) {
        continue;
      }

      process.env[key] = parseEnvValue(line.slice(separatorIndex + 1));
    }
  }
}

export function getServerRuntimeConfig(rootDir = process.cwd()): ServerRuntimeConfig {
  if (cachedConfig) {
    return cachedConfig;
  }

  loadProjectEnv(rootDir);

  const nodeEnv = process.env.NODE_ENV === "production"
    ? "production"
    : process.env.NODE_ENV === "test"
      ? "test"
      : "development";
  const isProduction = nodeEnv === "production";
  const appOrigin = process.env.APP_ORIGIN?.trim() || null;
  const corsOrigins = parseOrigins(process.env.CORS_ORIGINS ?? appOrigin ?? undefined);
  const logLevel = (() => {
    const value = process.env.LOG_LEVEL?.trim().toLowerCase();
    if (value === "debug" || value === "info" || value === "warn" || value === "error") {
      return value;
    }

    return "info";
  })();
  const sessionCookieSameSite = process.env.COOKIE_SAMESITE?.trim().toLowerCase() === "lax" ? "Lax" : "Strict";

  cachedConfig = {
    nodeEnv,
    isProduction,
    host: process.env.HOST?.trim() || "0.0.0.0",
    port: parsePositiveInteger(process.env.PORT, 3001),
    trustProxy: parseBoolean(process.env.TRUST_PROXY, isProduction),
    appOrigin,
    corsOrigins,
    logLevel,
    bodyLimitBytes: parsePositiveInteger(process.env.BODY_LIMIT_MB, 12) * 1024 * 1024,
    rateLimitMax: parsePositiveInteger(process.env.RATE_LIMIT_MAX, 1200),
    rateLimitWindowMs: parsePositiveInteger(process.env.RATE_LIMIT_WINDOW_MS, 60_000, 5_000),
    authRateLimitMax: parsePositiveInteger(process.env.AUTH_RATE_LIMIT_MAX, 300),
    sessionCookieSecure: parseBoolean(process.env.COOKIE_SECURE, isProduction),
    sessionCookieSameSite,
    databaseUrl: process.env.DATABASE_URL?.trim() || null,
    googleClientId: process.env.GOOGLE_CLIENT_ID?.trim() || null,
    superAdminEmail: process.env.SUPER_ADMIN_EMAIL?.trim().toLowerCase() || "anandhu7833@gmail.com"
  };

  return cachedConfig;
}
