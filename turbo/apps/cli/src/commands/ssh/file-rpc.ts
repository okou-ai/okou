import { spawn } from "node:child_process";
import type { Writable } from "node:stream";
import { DownloadDestination, UploadSource, fileReason } from "./file-local";
import {
  FILE_LIMITS,
  FileError,
  FileFrames,
  failure,
  frame,
  type Direction,
  type FileOutcome,
  type FileTerminal,
} from "./file-protocol";

function write(stream: Writable, bytes: Buffer, signal: AbortSignal) {
  signal.throwIfAborted();
  return new Promise<void>((resolve, reject) => {
    const finish = (error?: unknown) => {
      signal.removeEventListener("abort", abort);
      stream.removeListener("error", finish);
      if (error) reject(error);
      else resolve();
    };
    const abort = () => {
      finish(signal.reason);
    };
    signal.addEventListener("abort", abort, { once: true });
    stream.once("error", finish);
    stream.write(bytes, finish);
  });
}

interface TransferArgs {
  direction: Direction;
  connectionId: string;
  remotePath: string;
  overwrite: boolean;
  source?: UploadSource;
  destination?: DownloadDestination;
}

function helperFailure(
  error: Extract<FileTerminal, { type: "error" }>,
  direction: Direction,
  connectionId: string,
) {
  const result = failure(
    direction,
    connectionId,
    error.code === "unknown_method"
      ? "unsupported_operation"
      : error.code === "invalid_request"
        ? "protocol"
        : error.code,
  );
  if (direction === "upload" && error.delivery === "unknown")
    result.effects = "unknown";
  return result;
}

async function completeTransfer(
  args: TransferArgs,
  frames: FileFrames,
  exit: { code: number | null; termination: NodeJS.Signals | null },
  signal: AbortSignal,
): Promise<FileOutcome> {
  const { direction, connectionId, source, destination } = args;
  if (!frames.terminal && exit.code !== 0)
    throw new FileError("helper_unavailable");
  const terminal = frames.finish();
  if (exit.termination || (terminal.type === "result" && exit.code !== 0))
    throw new FileError("transport");
  if (terminal.type === "error") {
    return helperFailure(terminal, direction, connectionId);
  }
  const result = terminal.data;
  if (
    result.direction !== direction ||
    result.ssh_connection_id !== connectionId ||
    (direction === "download" && result.bytes !== frames.bytes)
  )
    throw new FileError("protocol");
  if (result.type === "completed") {
    if (
      source &&
      (result.sha256 !== source.sha256 || result.bytes !== source.bytes)
    )
      throw new FileError("protocol");
    if (destination) {
      if (!frames.ended || !result.sha256) throw new FileError("protocol");
      await destination.publish(result.bytes, result.sha256, signal);
      result.effects = "completed";
    }
  }
  return result;
}

export async function transferFile(args: TransferArgs): Promise<FileOutcome> {
  const { direction, connectionId, source, destination } = args;
  const controller = new AbortController();
  const stoppedInput = new AbortController();
  const signal = controller.signal;
  const inputSignal = AbortSignal.any([signal, stoppedInput.signal]);
  const frames = new FileFrames();
  let dispatched = false;
  let spawnFailed = false;
  const cancel = () => {
    controller.abort(new FileError("cancelled"));
  };
  process.once("SIGINT", cancel);
  const timer = setTimeout(() => {
    controller.abort(new FileError("timed_out"));
  }, FILE_LIMITS.timeout_ms);
  const child = spawn("/usr/local/bin/runner-rpc-client", ["--stream"], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  const closed = new Promise<{
    code: number | null;
    termination: NodeJS.Signals | null;
  }>((resolve) => {
    child.once("error", () => {
      spawnFailed = true;
      controller.abort(new FileError("helper_unavailable"));
    });
    child.once("close", (code, termination) => {
      resolve({ code, termination });
    });
  });
  const kill = () => {
    child.kill("SIGKILL");
    child.stdin.destroy();
  };
  signal.addEventListener("abort", kill, { once: true });
  child.stdin.on("error", () => {
    // Early rejection may close stdin before stdout's terminal arrives. Stop
    // input only; require the same bounded, verified terminal/EOF/exit below.
    stoppedInput.abort(new FileError("transport"));
  });
  const drain = (async () => {
    let count = 0;
    for await (const chunk of child.stderr) {
      if (!Buffer.isBuffer(chunk)) throw new FileError("protocol");
      count += chunk.length;
      if (count > 24576) throw new FileError("protocol");
    }
  })().catch(() => {
    controller.abort(new FileError("protocol"));
  });

  const sender = (async () => {
    const params = {
      sshConnectionId: connectionId,
      remotePath: args.remotePath,
      ...(source ? { size: source.size, overwrite: args.overwrite } : {}),
    };
    // The helper attaches its own remaining lifetime; clients cannot extend it.
    const request = frame(
      Buffer.from(
        JSON.stringify({ version: 1, method: `ssh.file.${direction}`, params }),
      ),
    );
    dispatched = true;
    await write(child.stdin, request, inputSignal);
    if (source)
      await source.send(async (bytes) => {
        await write(
          child.stdin,
          frame(Buffer.concat([Buffer.from([0]), bytes])),
          inputSignal,
        );
      }, inputSignal);
    await write(child.stdin, frame(Buffer.from([1])), inputSignal);
    child.stdin.end();
  })().catch((error: unknown) => {
    if (!stoppedInput.signal.aborted)
      controller.abort(
        error instanceof FileError ? error : new FileError(fileReason(error)),
      );
  });

  const receiver = (async () => {
    for await (const chunk of child.stdout) {
      signal.throwIfAborted();
      await frames.read(chunk, async (bytes) => {
        if (!destination) throw new FileError("protocol");
        await destination.write(bytes, signal);
      });
      if (frames.terminal) stoppedInput.abort();
    }
  })().catch((error: unknown) => {
    controller.abort(
      error instanceof FileError ? error : new FileError(fileReason(error)),
    );
  });

  try {
    await Promise.all([sender, receiver]);
    const exit = await closed;
    await drain;
    signal.throwIfAborted();
    return await completeTransfer(args, frames, exit, signal);
  } catch (error) {
    const result = failure(direction, connectionId, fileReason(error));
    result.bytes = source?.bytes ?? destination?.bytes ?? 0;
    result.actual_bytes = source?.size ?? null;
    if (direction === "upload" && dispatched && !spawnFailed)
      result.effects = "unknown";
    return result;
  } finally {
    stoppedInput.abort();
    kill();
    await Promise.all([closed, sender, receiver, drain]);
    clearTimeout(timer);
    process.removeListener("SIGINT", cancel);
    signal.removeEventListener("abort", kill);
  }
}
