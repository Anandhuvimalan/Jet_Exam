import { createHash, randomBytes, scrypt as nodeScrypt, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import { getServerRuntimeConfig } from "./env";

const scrypt = promisify(nodeScrypt);
const SCRYPT_KEY_LENGTH = 64;
const SESSION_COOKIE_NAME = "jet_session";
const SESSION_MAX_AGE_SECONDS = 60 * 60 * 12;

interface PasswordHash {
  salt: string;
  hash: string;
}

export function getSessionCookieName(): string {
  return SESSION_COOKIE_NAME;
}

export function getSessionMaxAgeSeconds(): number {
  return SESSION_MAX_AGE_SECONDS;
}

export function validatePassword(password: string): string | null {
  if (password.length < 8) {
    return "Password must be at least 8 characters long.";
  }

  return null;
}

export async function hashPassword(password: string): Promise<PasswordHash> {
  const salt = randomBytes(16).toString("hex");
  const derivedKey = (await scrypt(password, salt, SCRYPT_KEY_LENGTH)) as Buffer;

  return {
    salt,
    hash: derivedKey.toString("hex")
  };
}

export async function verifyPassword(password: string, salt: string, hash: string): Promise<boolean> {
  const derivedKey = (await scrypt(password, salt, SCRYPT_KEY_LENGTH)) as Buffer;
  const storedKey = Buffer.from(hash, "hex");

  if (storedKey.length !== derivedKey.length) {
    return false;
  }

  return timingSafeEqual(storedKey, derivedKey);
}

export function createSessionToken(): { token: string; tokenHash: string } {
  const token = randomBytes(32).toString("hex");
  return {
    token,
    tokenHash: hashToken(token)
  };
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function parseCookies(headerValue?: string): Record<string, string> {
  if (!headerValue) {
    return {};
  }

  return headerValue.split(";").reduce<Record<string, string>>((cookies, pair) => {
    const [rawName, ...rest] = pair.trim().split("=");
    if (!rawName) {
      return cookies;
    }

    const rawValue = rest.join("=");

    try {
      cookies[rawName] = decodeURIComponent(rawValue);
    } catch {
      cookies[rawName] = rawValue;
    }

    return cookies;
  }, {});
}

export function buildSessionCookie(token: string): string {
  const config = getServerRuntimeConfig();
  const parts = [
    `${SESSION_COOKIE_NAME}=${encodeURIComponent(token)}`,
    "Path=/",
    "HttpOnly",
    `SameSite=${config.sessionCookieSameSite}`,
    `Max-Age=${SESSION_MAX_AGE_SECONDS}`
  ];

  if (config.sessionCookieSecure) {
    parts.push("Secure");
  }

  return parts.join("; ");
}

export function buildClearedSessionCookie(): string {
  const config = getServerRuntimeConfig();
  const parts = [`${SESSION_COOKIE_NAME}=`, "Path=/", "HttpOnly", `SameSite=${config.sessionCookieSameSite}`, "Max-Age=0"];

  if (config.sessionCookieSecure) {
    parts.push("Secure");
  }

  return parts.join("; ");
}
