import {
  array,
  boolean,
  discriminatedUnion,
  literal,
  number,
  object,
  string,
  uuid,
  enum as zEnum,
  type infer as zInfer,
} from "zod";

import { diagnosticTextSchema } from "../../lib/diagnostic-text";
import { invokeRunnerRpc, rpcErrorSchema } from "../../lib/runner-rpc";
import { failureReasonSchema, remoteExitSchema, SshProtocolError } from "./rpc";

const cursor = number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const effects = zEnum(["not_started", "unknown", "completed"]);
const state = discriminatedUnion("type", [
  object({ type: literal("starting") }).strict(),
  object({ type: literal("running") }).strict(),
  object({ type: literal("finished"), exit: remoteExitSchema }).strict(),
  object({
    type: literal("failed"),
    failure_reason: failureReasonSchema,
  }).strict(),
]);
const info = object({
  session_id: uuid(),
  ssh_connection_id: uuid(),
  generation: number().int().min(0).max(Number.MAX_SAFE_INTEGER).nullable(),
  state,
  effects,
  stdin_closed: boolean(),
  oldest_cursor: cursor,
  end_cursor: cursor,
})
  .strict()
  .refine((value) => {
    return (
      value.oldest_cursor <= value.end_cursor &&
      (value.state.type === "finished"
        ? value.effects === "completed"
        : value.effects !== "completed") &&
      (value.state.type !== "running" || value.effects === "unknown")
    );
  });
const failure = object({
  type: literal("failed"),
  diagnostic_text: diagnosticTextSchema,
  failure_reason: failureReasonSchema,
  effects: zEnum(["not_started", "unknown"]),
}).strict();
const resultSchema = discriminatedUnion("type", [
  object({ type: literal("started"), session_id: uuid() }).strict(),
  object({ type: literal("sessions"), sessions: array(info).max(8) }).strict(),
  object({
    type: literal("status"),
    session: info,
    diagnostic_text: diagnosticTextSchema,
  }).strict(),
  object({
    type: literal("read"),
    diagnostic_text: diagnosticTextSchema,
    session: info,
    wait_expired: boolean(),
    chunks: array(
      object({
        cursor,
        stream: zEnum(["stdout", "stderr"]),
        data: string().max(5464),
      }).strict(),
    ).max(32),
    next_cursor: cursor,
    lost: object({ from: cursor, to: cursor }).strict().optional(),
  }).strict(),
  object({
    type: literal("submitted"),
    session_id: uuid(),
    effects: literal("unknown"),
  }).strict(),
  object({ type: literal("closed"), session_id: uuid(), effects }).strict(),
  object({
    type: literal("rejected"),
    reason: zEnum(["not_running", "stdin_closed"]),
  }).strict(),
  failure,
]);
const envelope = discriminatedUnion("type", [
  object({ type: literal("result"), data: resultSchema }).strict(),
  rpcErrorSchema,
]);
type Result = zInfer<typeof resultSchema>;
type Outcome =
  | Result
  | (Omit<zInfer<typeof rpcErrorSchema>, "type"> & { type: "rpc_error" });
export type SessionReadPage = Extract<Result, { type: "read" }>;
export type SessionReadFailure = Extract<
  Outcome,
  { type: "failed" | "rpc_error" }
>;
type Method =
  "start" | "list" | "status" | "read" | "write" | "signal" | "close";
const expected: Record<Method, Result["type"]> = {
  start: "started",
  list: "sessions",
  status: "status",
  read: "read",
  write: "submitted",
  signal: "submitted",
  close: "closed",
};

class SessionResponse {
  private pending = Buffer.alloc(0);
  private total = 0;
  private result: Outcome | undefined;

  constructor(
    private readonly method: Method,
    private readonly params: Readonly<Record<string, unknown>>,
  ) {}

  async read(chunk: unknown, _json: boolean, signal: AbortSignal) {
    signal.throwIfAborted();
    if (!Buffer.isBuffer(chunk)) throw new SshProtocolError();
    this.total += chunk.length;
    if (this.total > 24 * 1024 + 1) throw new SshProtocolError();
    this.pending = Buffer.concat([this.pending, chunk]);
    const newline = this.pending.indexOf(10);
    if (newline === -1) return;
    if (this.result || newline === 0 || newline !== this.pending.length - 1)
      throw new SshProtocolError();
    let decoded: unknown;
    try {
      decoded = JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(
          this.pending.subarray(0, newline),
        ),
      );
    } catch {
      throw new SshProtocolError();
    }
    const parsed = envelope.safeParse(decoded);
    if (!parsed.success) throw new SshProtocolError();
    this.pending = Buffer.alloc(0);
    if (parsed.data.type === "error") {
      this.result = { ...parsed.data, type: "rpc_error" };
      return;
    }
    const result = parsed.data.data;
    this.validate(result);
    this.result = result;
  }

  private validate(result: Result) {
    if (result.type === "failed") return;
    if (
      result.type === "rejected" &&
      (this.method === "write" || this.method === "signal")
    )
      return;
    if (result.type !== expected[this.method]) throw new SshProtocolError();
    if (
      "session_id" in result &&
      this.method !== "start" &&
      result.session_id !== this.params.sessionId
    )
      throw new SshProtocolError();
    if (
      "session" in result &&
      result.session.session_id !== this.params.sessionId
    )
      throw new SshProtocolError();
    if (
      result.type === "sessions" &&
      new Set(
        result.sessions.map((session) => {
          return session.session_id;
        }),
      ).size !== result.sessions.length
    )
      throw new SshProtocolError();
    if (result.type !== "read") return;
    this.validateRead(result);
  }

  private validateRead(result: Extract<Result, { type: "read" }>) {
    const requested = this.params.cursor;
    if (typeof requested !== "number" || requested > result.session.end_cursor)
      throw new SshProtocolError();
    let next = Math.max(requested, result.session.oldest_cursor);
    if (
      requested < result.session.oldest_cursor
        ? result.lost?.from !== requested || result.lost.to !== next
        : result.lost !== undefined
    )
      throw new SshProtocolError();
    let bytes = 0;
    for (const chunk of result.chunks) {
      const data = Buffer.from(chunk.data, "base64");
      if (
        chunk.cursor !== next ||
        !data.length ||
        data.length > 4096 ||
        data.toString("base64") !== chunk.data
      )
        throw new SshProtocolError();
      bytes += data.length;
      next += data.length;
    }
    if (
      bytes > 8192 ||
      next !== result.next_cursor ||
      next > result.session.end_cursor ||
      (next < result.session.end_cursor && bytes === 0)
    )
      throw new SshProtocolError();
    this.validateReadBudget(result, bytes);
  }

  private validateReadBudget(result: SessionReadPage, bytes: number) {
    const { maxBytes, maxChunks, waitMs } = this.params;
    const terminal = ["finished", "failed"].includes(result.session.state.type);
    if (
      typeof maxBytes !== "number" ||
      typeof maxChunks !== "number" ||
      typeof waitMs !== "number" ||
      bytes > maxBytes ||
      result.chunks.length > maxChunks ||
      result.wait_expired !==
        (waitMs > 0 && bytes === 0 && !result.lost && !terminal)
    )
      throw new SshProtocolError();
  }

  finish(code: number | null, termination: NodeJS.Signals | null) {
    if (
      this.pending.length ||
      !this.result ||
      termination !== null ||
      (this.result.type === "rpc_error" ? code === 0 : code !== 0)
    )
      throw new SshProtocolError();
  }

  fail(
    failureReason: "cancelled" | "timed_out" | "transport" | "protocol",
    effects: "not_started" | "unknown",
  ) {
    this.result = { type: "failed", failure_reason: failureReason, effects };
  }

  output(): Outcome {
    if (!this.result) throw new Error("Missing SSH session outcome");
    return this.result;
  }
}

export async function sessionRpc(
  method: Method,
  params: Readonly<Record<string, unknown>>,
  signal?: AbortSignal,
) {
  return invokeRunnerRpc(
    `ssh.session.${method}`,
    params,
    new SessionResponse(method, params),
    true,
    signal,
  );
}
