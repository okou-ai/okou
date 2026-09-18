import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { isAbsolute } from "node:path";
import { DownloadDestination, fileReason } from "../ssh/file-local";
import {
  VNC_LIMITS,
  VncError,
  VncFrames,
  frame,
  type VncMethod,
  type VncOutcome,
  type VncReason,
  type VncTerminal,
} from "./protocol";

function reason(error: unknown): VncReason {
  if (error instanceof VncError) return error.reason;
  const local = fileReason(error);
  switch (local) {
    case "path_not_found":
    case "permission_denied":
    case "destination_exists":
    case "not_regular_file":
    case "local_io":
    case "invalid_path":
    case "protocol":
      return local;
    default:
      return "local_io";
  }
}

function failure(
  method: VncMethod,
  why: VncReason,
  delivery: "not_dispatched" | "unknown",
): VncOutcome {
  return {
    outcome:
      method === "vnc.input"
        ? delivery === "not_dispatched"
          ? "not_started"
          : "unknown"
        : "failed",
    reason: why,
    delivery,
  };
}

function helperFailure(
  method: VncMethod,
  terminal: Extract<VncTerminal, { type: "error" }>,
): VncOutcome {
  return failure(
    method,
    terminal.code === "unknown_method"
      ? "unsupported_runner"
      : terminal.code === "invalid_request"
        ? "protocol"
        : terminal.code,
    terminal.delivery,
  );
}

interface CaptureDestination {
  path: string;
  overwrite: boolean;
}

async function closeDestination(
  destination: DownloadDestination | undefined,
  outcome: VncOutcome,
) {
  try {
    await destination?.close();
  } catch {
    // Publication may already have succeeded: preserve that fact for callers.
    outcome.cleanupReason = "local_io";
  }
  if (destination?.residue || outcome.cleanupReason) {
    outcome.cleanupReason = "local_io";
    outcome.residue = destination?.residue ?? null;
  }
}

/** One invocation, with no retries even when a terminal acknowledgement is lost. */
export async function invokeVncRpc(
  method: VncMethod,
  params: Record<string, unknown>,
  captureOptions?: CaptureDestination,
): Promise<VncOutcome> {
  let destination: DownloadDestination | undefined;
  const controller = new AbortController();
  const { signal } = controller;
  const cancel = () => {
    return controller.abort(new VncError("cancelled"));
  };
  process.once("SIGINT", cancel);
  const timer = setTimeout(() => {
    return controller.abort(new VncError("timed_out"));
  }, VNC_LIMITS.timeoutMs);
  let dispatched = false;
  let spawnFailed = false;
  let outcome: VncOutcome;
  try {
    if ((method === "vnc.capture") !== Boolean(captureOptions))
      throw new VncError("invalid_input");
    // Keep filesystem path semantics: resolving .. lexically can skip a symlink.
    const capture = captureOptions && {
      ...captureOptions,
      path: isAbsolute(captureOptions.path)
        ? captureOptions.path
        : `${process.cwd()}/${captureOptions.path}`,
    };
    // Reuse the existing descriptor-pinned private sink, not SSH RPC semantics.
    destination = capture
      ? new DownloadDestination(capture.path, capture.overwrite)
      : undefined;
    await destination?.init();
    signal.throwIfAborted();
    const frames = new VncFrames(method, params);
    const hash = createHash("sha256");
    const child = spawn("/usr/local/bin/runner-rpc-client", ["--stream"], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    const kill = () => {
      child.kill("SIGKILL");
      child.stdin.destroy();
    };
    const closed = new Promise<{
      code: number | null;
      termination: NodeJS.Signals | null;
    }>((complete) => {
      child.once("error", () => {
        spawnFailed = true;
        controller.abort(new VncError("helper_unavailable"));
      });
      child.once("close", (code, termination) => {
        return complete({ code, termination });
      });
    });
    signal.addEventListener("abort", kill, { once: true });
    // A rejected request can close stdin before delivering its terminal.
    // Drain stdout and validate that terminal before classifying delivery.
    const sender = new Promise<void>((complete) => {
      child.stdin.once("error", () => {
        return complete();
      });
      child.stdin.once("close", complete);
      dispatched = true;
      child.stdin.end(
        Buffer.concat([
          frame(Buffer.from(JSON.stringify({ version: 1, method, params }))),
          frame(Buffer.from([1])),
        ]),
        () => {
          return complete();
        },
      );
    });
    const stderr = (async () => {
      let bytes = 0;
      for await (const chunk of child.stderr) {
        if (!Buffer.isBuffer(chunk)) throw new VncError("protocol");
        bytes += chunk.length;
        if (bytes > VNC_LIMITS.controlBytes) throw new VncError("protocol");
      }
    })().catch(() => {
      return controller.abort(new VncError("protocol"));
    });
    const receiver = (async () => {
      for await (const chunk of child.stdout) {
        signal.throwIfAborted();
        await frames.read(chunk, async (bytes) => {
          if (!destination) throw new VncError("protocol");
          try {
            await destination.write(bytes, signal);
          } catch (error) {
            throw new VncError(reason(error));
          }
          hash.update(bytes);
        });
      }
    })().catch((error: unknown) => {
      return controller.abort(
        error instanceof VncError ? error : new VncError("transport"),
      );
    });
    try {
      const [, , , exit] = await Promise.all([
        sender,
        receiver,
        stderr,
        closed,
      ]);
      signal.throwIfAborted();
      const terminal = frames.finish();
      if (exit.termination || (terminal.type === "result" && exit.code !== 0))
        throw new VncError("transport");
      if (terminal.type === "error") outcome = helperFailure(method, terminal);
      else if (terminal.data.outcome === "captured") {
        if (!destination || !capture || !frames.metadata)
          throw new VncError("protocol");
        const sha256 = hash.digest("hex");
        await destination.publish(frames.bytes, sha256, signal);
        outcome = {
          ...frames.metadata,
          outcome: "captured",
          path: capture.path,
          sha256,
        };
      } else outcome = terminal.data;
    } finally {
      kill();
      await Promise.all([sender, receiver, stderr, closed]);
      signal.removeEventListener("abort", kill);
    }
  } catch (error) {
    outcome = failure(
      method,
      reason(error),
      dispatched && !spawnFailed ? "unknown" : "not_dispatched",
    );
  } finally {
    clearTimeout(timer);
    process.removeListener("SIGINT", cancel);
  }
  await closeDestination(destination, outcome);
  return outcome;
}
