import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const BLINK_INTERVAL_MS = 500;
const FAST_BLINK_INTERVAL_MS = 150;
const FOCUS_POLL_INTERVAL_MS = 750;

type LedMode = "solid" | "blink" | "fastBlink" | "restore";
type StateEvent = "session_start" | "input" | "agent_start" | "agent_settled" | "session_shutdown";

export function ledModeForEvent(event: StateEvent, waitingForInput = false): LedMode {
  switch (event) {
    case "agent_start":
      return "blink";
    case "agent_settled":
      return waitingForInput ? "fastBlink" : "solid";
    case "session_shutdown":
      return "restore";
    case "session_start":
    case "input":
      return "solid";
  }
}

function messageText(message: unknown): string {
  if (!message || typeof message !== "object") {
    return "";
  }

  const content = (message as { content?: unknown }).content;
  if (typeof content === "string") {
    return content;
  }

  if (!Array.isArray(content)) {
    return "";
  }

  return content
    .map((part) => {
      if (typeof part === "string") {
        return part;
      }
      if (!part || typeof part !== "object") {
        return "";
      }
      const text = (part as { text?: unknown }).text;
      return typeof text === "string" ? text : "";
    })
    .join("\n");
}

export function isAssistantWaitingForInput(message: unknown): boolean {
  return Boolean(
    message &&
      typeof message === "object" &&
      (message as { role?: unknown }).role === "assistant" &&
      /\?\s*$/.test(messageText(message).trim()),
  );
}

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

function execFileText(command: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(command, args, (error, stdout) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(stdout.trim());
    });
  });
}

async function frontmostApplicationPid(): Promise<number | undefined> {
  try {
    const frontApplication = await execFileText("lsappinfo", ["front"]);
    const info = await execFileText("lsappinfo", ["info", "-only", "pid", frontApplication]);
    const match = /"pid"=(\d+)/.exec(info);
    return match ? Number(match[1]) : undefined;
  } catch {
    return undefined;
  }
}

async function processHasAncestor(pid: number, ancestorPid: number): Promise<boolean> {
  let currentPid = pid;
  for (let depth = 0; depth < 32; depth++) {
    if (currentPid === ancestorPid) {
      return true;
    }

    const parentPidText = await execFileText("ps", ["-o", "ppid=", "-p", String(currentPid)]).catch(() => "");
    const parentPid = Number(parentPidText.trim());
    if (!Number.isInteger(parentPid) || parentPid <= 1 || parentPid === currentPid) {
      return false;
    }
    currentPid = parentPid;
  }
  return false;
}

export function shouldRestoreOnFocusLoss(cmuxSurfaceId: string | undefined): boolean {
  return !cmuxSurfaceId;
}

export function cmuxSurfaceIsFocused(identifyOutput: string, surfaceId: string): boolean | undefined {
  try {
    const identify = JSON.parse(identifyOutput) as {
      focused?: { surface_id?: unknown };
    };
    return typeof identify.focused?.surface_id === "string"
      ? identify.focused.surface_id === surfaceId
      : undefined;
  } catch {
    return undefined;
  }
}

async function terminalIsFocused(): Promise<boolean> {
  if (process.platform !== "darwin") {
    return true;
  }

  // cmux retains its focused surface while another application is in front and
  // while macOS is locked. Treat that surface as the LED owner so background
  // agents cannot replace the state of the last tab the user selected.
  const cmuxSurfaceId = process.env.CMUX_SURFACE_ID;
  if (cmuxSurfaceId) {
    const identifyOutput = await execFileText("cmux", ["identify", "--id-format", "uuids"]).catch(() => "");
    const surfaceIsFocused = cmuxSurfaceIsFocused(identifyOutput, cmuxSurfaceId);
    if (surfaceIsFocused !== undefined) {
      return surfaceIsFocused;
    }
  }

  const frontPid = await frontmostApplicationPid();
  if (!frontPid) {
    return true;
  }

  return process.pid === frontPid || (await processHasAncestor(process.pid, frontPid));
}

// Loaded dynamically through package.json's pi.extensions entry.
// fallow-ignore-next-line unused-export
export default function capsPulse(pi: ExtensionAPI): void {
  let helperPath: string | undefined;
  let blinkProcess: ChildProcess | undefined;
  let transition = Promise.resolve();
  let focusPollTimer: ReturnType<typeof setInterval> | undefined;
  let lastError: string | undefined;
  let desiredMode: LedMode = "solid";
  let lastFocusState = true;
  let waitingForInput = false;

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

  const stopBlinking = async (restore = true): Promise<void> => {
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
      if (!restore) {
        child.stdin?.write("q");
      }
      child.stdin?.end();
      forceStopTimer = setTimeout(() => child.kill("SIGTERM"), 1000);
    });
  };

  const startBlinking = (ctx: ExtensionContext, intervalMs = BLINK_INTERVAL_MS): void => {
    if (!helperPath) {
      return;
    }

    const child = spawn(helperPath, ["blink", String(intervalMs)], {
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

  const applyDesiredMode = async (ctx: ExtensionContext): Promise<void> => {
    if (!helperPath) {
      return;
    }

    const focused = await terminalIsFocused();
    lastFocusState = focused;
    if (!focused) {
      // A deselected cmux surface must relinquish the shared LED without
      // restoring it afterward. The newly selected surface owns the next
      // write; restoring here races with and can erase that surface's state.
      await stopBlinking(shouldRestoreOnFocusLoss(process.env.CMUX_SURFACE_ID));
      return;
    }

    // A mode transition immediately replaces the LED state, so avoid a
    // transient restore between the old and new modes.
    await stopBlinking(false);
    if (desiredMode === "blink") {
      startBlinking(ctx);
    } else if (desiredMode === "fastBlink") {
      startBlinking(ctx, FAST_BLINK_INTERVAL_MS);
    } else {
      await runHelper(helperPath, desiredMode === "restore" ? "restore" : "on");
    }
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

    waitingForInput = false;
    desiredMode = ledModeForEvent("session_start");
    await enqueue(ctx, async () => {
      helperPath = await buildHelper(pi);
      await applyDesiredMode(ctx);
      lastError = undefined;
    });

    focusPollTimer ??= setInterval(() => {
      void enqueue(ctx, async () => {
        const focused = await terminalIsFocused();
        if (focused !== lastFocusState) {
          await applyDesiredMode(ctx);
        }
      });
    }, FOCUS_POLL_INTERVAL_MS);
  });

  pi.on("input", async (_event, ctx) => {
    waitingForInput = false;
    desiredMode = ledModeForEvent("input");
    await enqueue(ctx, () => applyDesiredMode(ctx));
  });

  pi.on("agent_start", async (_event, ctx) => {
    waitingForInput = false;
    desiredMode = ledModeForEvent("agent_start");
    await enqueue(ctx, () => applyDesiredMode(ctx));
  });

  pi.on("message_end", async (event) => {
    if (isAssistantWaitingForInput(event.message)) {
      waitingForInput = true;
    }
  });

  pi.on("agent_end", async (event) => {
    waitingForInput = waitingForInput || event.messages.some(isAssistantWaitingForInput);
  });

  pi.on("agent_settled", async (_event, ctx) => {
    desiredMode = ledModeForEvent("agent_settled", waitingForInput);
    await enqueue(ctx, async () => {
      await applyDesiredMode(ctx);
      lastError = undefined;
    });
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    waitingForInput = false;
    desiredMode = ledModeForEvent("session_shutdown");
    if (focusPollTimer) {
      clearInterval(focusPollTimer);
      focusPollTimer = undefined;
    }
    await enqueue(ctx, async () => {
      if (helperPath && (await terminalIsFocused())) {
        await applyDesiredMode(ctx);
      } else {
        await stopBlinking();
      }
    });
  });
}
