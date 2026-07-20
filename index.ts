import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const BLINK_INTERVAL_MS = 500;

async function buildHelper(pi: ExtensionAPI): Promise<string> {
  const sourcePath = fileURLToPath(new URL("./capsLockLed.c", import.meta.url));
  const sourceHash = createHash("sha256").update(readFileSync(sourcePath)).digest("hex").slice(0, 16);
  const cacheDirectory = join(homedir(), "Library", "Caches", "pi-capspulse");
  const helperPath = join(cacheDirectory, `capsLockLed-${sourceHash}`);
  if (existsSync(helperPath)) {
    return helperPath;
  }

  mkdirSync(cacheDirectory, { recursive: true });
  const temporaryPath = `${helperPath}.${process.pid}.${randomUUID()}`;
  const result = await pi.exec(
    "xcrun",
    [
      "clang",
      "-std=c11",
      "-Os",
      "-Wall",
      "-Wextra",
      "-Werror",
      sourcePath,
      "-framework",
      "CoreFoundation",
      "-framework",
      "IOKit",
      "-framework",
      "ApplicationServices",
      "-o",
      temporaryPath,
    ],
    { timeout: 30_000 },
  );

  if (result.code !== 0) {
    rmSync(temporaryPath, { force: true });
    throw new Error(result.stderr.trim() || "Failed to compile the CapsPulse native helper");
  }

  renameSync(temporaryPath, helperPath);
  chmodSync(helperPath, 0o755);
  return helperPath;
}

function runHelper(helperPath: string, mode: "on" | "restore"): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(helperPath, [mode], (error, _stdout, stderr) => {
      if (!error) {
        resolve();
        return;
      }

      reject(new Error(stderr.trim() || error.message));
    });
  });
}

export default function capsPulse(pi: ExtensionAPI): void {
  let helperPath: string | undefined;
  let blinkProcess: ChildProcess | undefined;
  let transition = Promise.resolve();
  let lastError: string | undefined;

  const reportError = (ctx: ExtensionContext, error: unknown): void => {
    const message = error instanceof Error ? error.message : String(error);
    if (message === lastError) {
      return;
    }

    lastError = message;
    if (ctx.hasUI) {
      ctx.ui.notify(`CapsPulse: ${message}`, "error");
      return;
    }

    console.error(`CapsPulse: ${message}`);
  };

  const stopBlinking = async (): Promise<void> => {
    const child = blinkProcess;
    blinkProcess = undefined;
    if (!child || child.exitCode !== null) {
      return;
    }

    await new Promise<void>((resolve) => {
      let forceStopTimer: ReturnType<typeof setTimeout> | undefined;
      const finish = (): void => {
        if (forceStopTimer) {
          clearTimeout(forceStopTimer);
        }
        resolve();
      };

      child.once("exit", finish);
      child.once("error", finish);
      child.stdin?.end();
      forceStopTimer = setTimeout(() => child.kill("SIGTERM"), 1000);
    });
  };

  const startBlinking = async (ctx: ExtensionContext): Promise<void> => {
    if (!helperPath || (blinkProcess && blinkProcess.exitCode === null)) {
      return;
    }

    await stopBlinking();
    const child = spawn(helperPath, ["blink", String(BLINK_INTERVAL_MS)], {
      stdio: ["pipe", "ignore", "pipe"],
    });
    let stderr = "";
    blinkProcess = child;
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.once("error", (error) => {
      if (blinkProcess === child) {
        blinkProcess = undefined;
      }
      reportError(ctx, error);
    });
    child.once("exit", (code) => {
      if (blinkProcess === child) {
        blinkProcess = undefined;
      }
      if (code !== null && code !== 0) {
        reportError(ctx, new Error(stderr.trim() || `Native helper exited with code ${code}`));
      }
    });
  };

  const enqueue = (ctx: ExtensionContext, operation: () => Promise<void>): Promise<void> => {
    const next = transition.then(operation, operation);
    transition = next.catch((error: unknown) => {
      reportError(ctx, error);
    });
    return transition;
  };

  pi.on("session_start", async (_event, ctx) => {
    if (process.platform !== "darwin") {
      return;
    }

    await enqueue(ctx, async () => {
      await stopBlinking();
      helperPath = await buildHelper(pi);
      await runHelper(helperPath, "on");
      lastError = undefined;
    });
  });

  pi.on("agent_start", async (_event, ctx) => {
    await enqueue(ctx, () => startBlinking(ctx));
  });

  pi.on("agent_settled", async (_event, ctx) => {
    await enqueue(ctx, async () => {
      await stopBlinking();
      if (helperPath) {
        await runHelper(helperPath, "on");
      }
      lastError = undefined;
    });
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    await enqueue(ctx, async () => {
      await stopBlinking();
      if (helperPath) {
        await runHelper(helperPath, "restore");
      }
    });
  });
}
