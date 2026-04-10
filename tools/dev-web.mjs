import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";

const healthUrl = process.env.DEV_API_READY_URL ?? "http://127.0.0.1:3001/api/health/live";
const timeoutMs = Number(process.env.DEV_API_WAIT_MS ?? 45_000);
const pollIntervalMs = 400;

async function waitForApi() {
  const startedAt = Date.now();
  process.stdout.write(`[dev:web] waiting for API readiness at ${healthUrl}\n`);

  while (Date.now() - startedAt < timeoutMs) {
    try {
      const response = await fetch(healthUrl, { cache: "no-store" });
      if (response.ok) {
        process.stdout.write("[dev:web] API ready, starting Vite\n");
        return;
      }
    } catch {
      // Ignore connection errors while the API boots.
    }

    await delay(pollIntervalMs);
  }

  throw new Error(`Timed out waiting for API readiness at ${healthUrl} after ${timeoutMs}ms.`);
}

function startVite() {
  const command = process.platform === "win32"
    ? (process.env.ComSpec ?? "cmd.exe")
    : "npm";
  const args = process.platform === "win32"
    ? ["/c", "npm", "run", "dev:web:raw"]
    : ["run", "dev:web:raw"];
  const child = spawn(command, args, {
    cwd: process.cwd(),
    stdio: "inherit"
  });

  child.on("exit", (code, signal) => {
    if (signal) {
      process.kill(process.pid, signal);
      return;
    }

    process.exit(code ?? 0);
  });

  child.on("error", (error) => {
    console.error(error);
    process.exit(1);
  });
}

waitForApi()
  .then(startVite)
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
