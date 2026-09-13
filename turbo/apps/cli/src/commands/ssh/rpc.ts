import { spawn } from "node:child_process";
import type { Writable } from "node:stream";
import { z } from "zod";

const STREAM_LIMIT = 1024 * 1024;
const LINE_LIMIT = 24 * 1024;
const RESPONSE_LIMIT = 4 * 1024 * 1024;
const count = z.number().int().min(0).max(STREAM_LIMIT);
const totals = {
  stdout_bytes: count,
  stderr_bytes: count,
  stdout_truncated: z.boolean(),
  stderr_truncated: z.boolean(),
};
export const failureReasonSchema = z.enum([
  "unavailable",
  "authority_failure",
  "invalid_credential",
  "unsupported_credential",
  "credential_resource_limit",
  "unsafe_destination",
  "network_failure",
  "host_key_mismatch",
  "unsupported_host_key",
  "configuration_changed",
  "authentication_failed",
  "protocol",
  "exec_rejected",
  "disconnected",
  "timed_out",
  "cancelled",
  "resource_exhausted",
  "transport",
]);
export const remoteExitSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("status"),
      code: z.number().int().min(0).max(0xffffffff),
    })
    .strict(),
  z
    .object({
      type: z.literal("signal"),
      signal: z.enum([
        "ABRT",
        "ALRM",
        "FPE",
        "HUP",
        "ILL",
        "INT",
        "KILL",
        "PIPE",
        "QUIT",
        "SEGV",
        "TERM",
        "USR1",
        "USR2",
        "UNKNOWN",
      ]),
      core_dumped: z.boolean(),
    })
    .strict(),
]);
const terminalSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("finished"),
      effects: z.literal("completed"),
      ...totals,
      exit: remoteExitSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("failed"),
      failure_reason: failureReasonSchema,
      effects: z.enum(["not_started", "unknown"]),
      ...totals,
    })
    .strict(),
]);
export const rpcErrorSchema = z
  .object({
    type: z.literal("error"),
    code: z.enum([
      "invalid_request",
      "unknown_method",
      "unavailable",
      "protocol",
      "transport",
      "timed_out",
      "resource_exhausted",
    ]),
    delivery: z.enum(["not_dispatched", "unknown"]),
  })
  .strict();
const envelopeSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("event"),
      data: z.discriminatedUnion("type", [
        z.object({ type: z.literal("accepted") }).strict(),
        z
          .object({
            type: z.literal("output"),
            stream: z.enum(["stdout", "stderr"]),
            data: z.string(),
          })
          .strict(),
      ]),
    })
    .strict(),
  z.object({ type: z.literal("result"), data: terminalSchema }).strict(),
  rpcErrorSchema,
]);
type Terminal = z.infer<typeof terminalSchema>;
type RpcError = z.infer<typeof rpcErrorSchema>;

// A pipe consumer can stall independently of the helper. Bound writes without
// destroying the caller's stdout/stderr; never replay the remote request.
export async function writeOutput(
  stream: Writable,
  bytes: Buffer,
  signal: AbortSignal,
) {
  signal.throwIfAborted();
  await new Promise<void>((resolve, reject) => {
    const abort = () => {
      return reject(signal.reason);
    };
    signal.addEventListener("abort", abort, { once: true });
    stream.once("error", reject);
    stream.write(bytes, (error) => {
      signal.removeEventListener("abort", abort);
      if (error) reject(error);
      else {
        stream.removeListener("error", reject);
        resolve();
      }
    });
  });
}

export class SshProtocolError extends Error {
  constructor() {
    super("Invalid SSH helper response");
  }
}
function invalid(): never {
  throw new SshProtocolError();
}

class SshResponse {
  readonly chunks: Record<"stdout" | "stderr", Buffer[]> = {
    stdout: [],
    stderr: [],
  };
  readonly sizes = { stdout: 0, stderr: 0 };
  terminal: Terminal | RpcError | undefined;
  private accepted = false;
  private pending = Buffer.alloc(0);
  private total = 0;

  async read(chunk: unknown, json: boolean, signal: AbortSignal) {
    signal.throwIfAborted();
    if (!Buffer.isBuffer(chunk)) invalid();
    this.total += chunk.length;
    if (this.total > RESPONSE_LIMIT) invalid();
    this.pending = Buffer.concat([this.pending, chunk]);
    let newline: number;
    while ((newline = this.pending.indexOf(10)) !== -1) {
      if (newline === 0 || newline > LINE_LIMIT || this.terminal) invalid();
      let decoded: unknown;
      try {
        decoded = JSON.parse(
          new TextDecoder("utf-8", { fatal: true }).decode(
            this.pending.subarray(0, newline),
          ),
        );
      } catch {
        invalid();
      }
      this.pending = this.pending.subarray(newline + 1);
      const parsed = envelopeSchema.safeParse(decoded);
      if (!parsed.success) invalid();
      await this.message(parsed.data, json, signal);
    }
    if (this.pending.length > LINE_LIMIT) invalid();
  }

  private async message(
    message: z.infer<typeof envelopeSchema>,
    json: boolean,
    signal: AbortSignal,
  ) {
    if (message.type === "error") {
      if (this.accepted && message.delivery === "not_dispatched") invalid();
      this.terminal = message;
    } else if (message.type === "result") {
      this.result(message.data);
    } else if (message.data.type === "accepted") {
      if (this.accepted) invalid();
      this.accepted = true;
    } else {
      if (!this.accepted) invalid();
      const { stream, data } = message.data;
      const bytes = Buffer.from(data, "base64");
      if (
        bytes.length === 0 ||
        bytes.length > 16 * 1024 ||
        bytes.toString("base64") !== data ||
        this.sizes[stream] + bytes.length > STREAM_LIMIT
      )
        invalid();
      this.sizes[stream] += bytes.length;
      if (json) this.chunks[stream].push(bytes);
      else
        await writeOutput(
          stream === "stdout" ? process.stdout : process.stderr,
          bytes,
          signal,
        );
    }
  }

  private result(result: Terminal) {
    if (
      (result.type === "finished" && !this.accepted) ||
      (result.type === "failed" &&
        result.effects === "not_started" &&
        this.accepted) ||
      result.stdout_bytes !== this.sizes.stdout ||
      result.stderr_bytes !== this.sizes.stderr ||
      (result.stdout_truncated && this.sizes.stdout !== STREAM_LIMIT) ||
      (result.stderr_truncated && this.sizes.stderr !== STREAM_LIMIT)
    )
      invalid();
    this.terminal = result;
  }

  finish(code: number | null, termination: NodeJS.Signals | null) {
    if (
      this.pending.length !== 0 ||
      !this.terminal ||
      termination !== null ||
      (this.terminal.type === "error" ? code === 0 : code !== 0)
    )
      invalid();
  }

  capture() {
    return {
      stdout_bytes: this.sizes.stdout,
      stderr_bytes: this.sizes.stderr,
      stdout_truncated: false,
      stderr_truncated: false,
    };
  }

  fail(failureReason: LocalFailure, effects: "not_started" | "unknown") {
    this.terminal = {
      type: "failed",
      failure_reason: failureReason,
      effects,
      ...this.capture(),
    };
  }

  output() {
    const output = {
      stdout_base64: Buffer.concat(this.chunks.stdout).toString("base64"),
      stderr_base64: Buffer.concat(this.chunks.stderr).toString("base64"),
    };
    if (!this.terminal) throw new Error("Missing SSH outcome");
    return this.terminal.type === "error"
      ? {
          ...this.terminal,
          type: "rpc_error" as const,
          ...output,
          ...this.capture(),
        }
      : { ...this.terminal, ...output };
  }
}

/** SSH business payloads from the version-1 packaged helper, not a shell. */
export async function executeSsh(
  connectionId: string,
  command: string,
  json: boolean,
) {
  return invokeSshRpc(
    "ssh.exec",
    { sshConnectionId: connectionId, command },
    new SshResponse(),
    json,
  );
}

type LocalFailure = "cancelled" | "timed_out" | "transport" | "protocol";

interface ResponseReader<T> {
  read(chunk: unknown, json: boolean, signal: AbortSignal): Promise<void>;
  finish(code: number | null, termination: NodeJS.Signals | null): void;
  fail(reason: LocalFailure, effects: "not_started" | "unknown"): void;
  output(): T;
}

/** One bounded helper invocation. Losing an acknowledgement never triggers replay. */
export async function invokeSshRpc<T>(
  method: string,
  params: Readonly<Record<string, unknown>>,
  response: ResponseReader<T>,
  json = true,
): Promise<T> {
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
  child.stdin.on("error", () => {
    controller.abort();
  });
  // Discard diagnostics: they are not a trusted channel for secrets or outcomes.
  const drain = (async () => {
    let bytes = 0;
    for await (const chunk of child.stderr) {
      if (!Buffer.isBuffer(chunk)) invalid();
      bytes += chunk.length;
      if (bytes > LINE_LIMIT) invalid();
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
    // Once dispatched, losing the helper cannot prove execution stopped.
    response.fail(
      error instanceof SshProtocolError ? "protocol" : localReason,
      spawnFailed ? "not_started" : "unknown",
    );
  } finally {
    kill();
    await closed;
    await drain;
    clearTimeout(timer);
    process.removeListener("SIGINT", cancel);
    signal.removeEventListener("abort", kill);
  }
  return response.output();
}
