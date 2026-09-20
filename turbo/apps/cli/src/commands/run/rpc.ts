import { z } from "zod";

import {
  invokeRunnerRpc,
  RunnerRpcProtocolError,
  type RunnerRpcLocalFailure,
  type RunnerRpcResponseReader,
} from "../../lib/runner-rpc";
import {
  runUsageResultSchema,
  type RunUsageCliOutcome,
  type RunUsageErrorKind,
} from "./protocol";

const LINE_LIMIT = 24 * 1024;
const rpcErrorSchema = z
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
      type: z.literal("result"),
      data: runUsageResultSchema,
    })
    .strict(),
  rpcErrorSchema,
]);

type Terminal = z.infer<typeof envelopeSchema>;

function invalid(): never {
  throw new RunnerRpcProtocolError("Invalid run usage helper response");
}

function rpcKind(
  code: z.infer<typeof rpcErrorSchema>["code"],
): RunUsageErrorKind {
  switch (code) {
    case "unknown_method":
      return "unsupported-runner";
    case "unavailable":
      return "feature-unavailable";
    case "resource_exhausted":
      return "busy";
    case "timed_out":
      return "timed-out";
    case "transport":
      return "transport";
    case "invalid_request":
    case "protocol":
      return "invalid-response";
  }
}

function localKind(reason: RunnerRpcLocalFailure): RunUsageErrorKind {
  switch (reason) {
    case "cancelled":
      return "cancelled";
    case "timed_out":
      return "timed-out";
    case "transport":
      return "transport";
    case "protocol":
      return "invalid-response";
  }
}

class RunUsageResponse implements RunnerRpcResponseReader<RunUsageCliOutcome> {
  private pending = Buffer.alloc(0);
  private total = 0;
  private terminal: Terminal | undefined;
  private localFailure:
    | {
        kind: RunUsageErrorKind;
        delivery: "not-dispatched" | "unknown";
      }
    | undefined;

  async read(chunk: unknown, _json: boolean, signal: AbortSignal) {
    signal.throwIfAborted();
    if (!Buffer.isBuffer(chunk)) invalid();
    this.total += chunk.length;
    if (this.total > LINE_LIMIT + 1) invalid();
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
      this.terminal = parsed.data;
    }
    if (this.pending.length > LINE_LIMIT) invalid();
  }

  finish(code: number | null, termination: NodeJS.Signals | null) {
    if (
      this.pending.length !== 0 ||
      !this.terminal ||
      termination !== null ||
      (this.terminal.type === "result" ? code !== 0 : code === 0)
    ) {
      invalid();
    }
  }

  fail(reason: RunnerRpcLocalFailure, delivery: "not_started" | "unknown") {
    this.terminal = undefined;
    this.localFailure = {
      kind: localKind(reason),
      delivery: delivery === "not_started" ? "not-dispatched" : "unknown",
    };
  }

  output(): RunUsageCliOutcome {
    if (this.localFailure) {
      return {
        schemaVersion: 1,
        status: "error",
        error: this.localFailure,
      };
    }
    if (!this.terminal) {
      return {
        schemaVersion: 1,
        status: "error",
        error: { kind: "invalid-response", delivery: "unknown" },
      };
    }
    if (this.terminal.type === "result") {
      return {
        schemaVersion: 1,
        status: "ok",
        usage: this.terminal.data,
      };
    }
    return {
      schemaVersion: 1,
      status: "error",
      error: {
        kind: rpcKind(this.terminal.code),
        delivery:
          this.terminal.delivery === "not_dispatched"
            ? "not-dispatched"
            : "unknown",
      },
    };
  }
}

export async function queryRunUsage(): Promise<RunUsageCliOutcome> {
  return await invokeRunnerRpc("run.usage", {}, new RunUsageResponse());
}
