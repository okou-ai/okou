import { spawn } from "node:child_process";

const STDERR_LIMIT = 24 * 1024;

export type RunnerRpcLocalFailure =
  | "cancelled"
  | "timed_out"
  | "transport"
  | "protocol";

export interface RunnerRpcResponseReader<T> {
  read(chunk: unknown, json: boolean, signal: AbortSignal): Promise<void>;
  finish(code: number | null, termination: NodeJS.Signals | null): void;
  fail(
    reason: RunnerRpcLocalFailure,
    delivery: "not_started" | "unknown",
  ): void;
  output(): T;
}

export class RunnerRpcProtocolError extends Error {
  constructor(message = "Invalid Runner RPC helper response") {
    super(message);
  }
}

/** One bounded helper invocation. It never retries or replays the request. */
export async function invokeRunnerRpc<T>(
  method: string,
  params: Readonly<Record<string, unknown>>,
  response: RunnerRpcResponseReader<T>,
  json = true,
  parentSignal?: AbortSignal,
): Promise<T> {
  const parentReason = () => {
    return parentSignal?.reason instanceof DOMException &&
      parentSignal.reason.name === "TimeoutError"
      ? "timed_out"
      : "cancelled";
  };
  if (parentSignal?.aborted) {
    response.fail(parentReason(), "not_started");
    return response.output();
  }
  const controller = new AbortController();
  const signal = controller.signal;
  let localReason: "cancelled" | "timed_out" | "transport" = "transport";
  const cancel = () => {
    localReason = "cancelled";
    controller.abort();
  };
  process.once("SIGINT", cancel);
  const timer = setTimeout(() => {
    localReason = "timed_out";
    controller.abort();
  }, 65_000);
  let spawnFailed = false;
  const child = spawn("/usr/local/bin/runner-rpc-client", [], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  const closed = new Promise<{
    code: number | null;
    exitSignal: NodeJS.Signals | null;
  }>((resolve) => {
    child.once("error", () => {
      spawnFailed = true;
      controller.abort();
    });
    child.once("close", (code, exitSignal) => {
      resolve({ code, exitSignal });
    });
  });
  const kill = () => {
    child.kill("SIGKILL");
  };
  signal.addEventListener("abort", kill, { once: true });
  const cancelFromParent = () => {
    localReason = parentReason();
    controller.abort();
  };
  parentSignal?.addEventListener("abort", cancelFromParent, { once: true });
  child.stdin.on("error", () => {
    controller.abort();
  });
  // Diagnostics are not a trusted channel for secrets or outcomes.
  const drain = (async () => {
    let bytes = 0;
    for await (const chunk of child.stderr) {
      if (!Buffer.isBuffer(chunk)) throw new RunnerRpcProtocolError();
      bytes += chunk.length;
      if (bytes > STDERR_LIMIT) throw new RunnerRpcProtocolError();
    }
  })().catch(() => {
    controller.abort();
  });
  child.stdin.end(
    JSON.stringify({
      version: 1,
      method,
      params,
    }),
  );
  try {
    for await (const chunk of child.stdout)
      await response.read(chunk, json, signal);
    const exit = await closed;
    await drain;
    signal.throwIfAborted();
    response.finish(exit.code, exit.exitSignal);
  } catch (error) {
    response.fail(
      error instanceof RunnerRpcProtocolError ? "protocol" : localReason,
      spawnFailed ? "not_started" : "unknown",
    );
  } finally {
    kill();
    await closed;
    await drain;
    clearTimeout(timer);
    process.removeListener("SIGINT", cancel);
    signal.removeEventListener("abort", kill);
    parentSignal?.removeEventListener("abort", cancelFromParent);
  }
  return response.output();
}
