import {
  base64,
  literal,
  null as zNull,
  strictObject,
  union,
  type infer as zInfer,
} from "zod";
import { runnerMcpConnectorsContract } from "@okouai/api-contracts/contracts/mcp-connectors";
import { apiErrorSchema } from "@okouai/api-contracts/contracts/errors";
import { handleError } from "./api/core/client-factory";
import {
  invokeRunnerRpc,
  rpcErrorSchema,
  RunnerRpcProtocolError,
  type RunnerRpcLocalFailure,
  type RunnerRpcResponseReader,
} from "./runner-rpc";

const contract = runnerMcpConnectorsContract.resolve;
const responseSchema = union([
  strictObject({ status: literal(200), body: contract.responses[200] }),
  strictObject({
    status: literal([400, 401, 403, 404, 409, 500, 502, 503]),
    body: apiErrorSchema,
  }),
]);
const envelopeSchema = union([
  strictObject({ type: literal("event"), data: base64() }),
  strictObject({ type: literal("result"), data: zNull() }),
  rpcErrorSchema,
]);
type Data = zInfer<(typeof contract.responses)[200]>;
type Request = zInfer<typeof contract.body>["request"];

class RunnerMcpResponse implements RunnerRpcResponseReader<Data> {
  private pending = Buffer.alloc(0);
  private total = 0;
  private readonly parts: Buffer[] = [];
  private terminal = false;
  private result: Data | undefined;
  private apiError: { status: number; body: unknown } | undefined;
  private error: string | undefined;
  private readonly decoder = new TextDecoder("utf-8", { fatal: true });

  async read(chunk: unknown, _json: boolean, signal: AbortSignal) {
    signal.throwIfAborted();
    if (
      !Buffer.isBuffer(chunk) ||
      this.terminal ||
      this.total + chunk.length > 4 * 1024 * 1024
    ) {
      throw new RunnerRpcProtocolError();
    }
    this.total += chunk.length;
    this.pending = Buffer.concat([this.pending, chunk]);
    let newline = this.pending.indexOf(10);
    while (newline >= 0) {
      if (this.terminal) throw new RunnerRpcProtocolError();
      const envelope = envelopeSchema.safeParse(
        this.parse(this.pending.subarray(0, newline)),
      );
      if (!envelope.success) throw new RunnerRpcProtocolError();
      const frame = envelope.data;
      if (frame.type === "event") {
        this.parts.push(Buffer.from(frame.data, "base64"));
      } else {
        this.terminal = true;
        if (frame.type === "error") this.error = frame.code;
      }
      this.pending = this.pending.subarray(newline + 1);
      newline = this.pending.indexOf(10);
    }
  }

  finish(code: number | null, termination: NodeJS.Signals | null) {
    if (
      this.pending.length ||
      !this.terminal ||
      termination !== null ||
      code !== (this.error ? 1 : 0)
    ) {
      throw new RunnerRpcProtocolError();
    }
    if (!this.error) {
      const result = responseSchema.safeParse(
        this.parse(Buffer.concat(this.parts)),
      );
      if (!result.success) throw new RunnerRpcProtocolError();
      if (result.data.status !== 200) {
        this.apiError = result.data;
      } else {
        this.result = result.data.body;
      }
    }
  }

  private parse(bytes: Buffer): unknown {
    try {
      return JSON.parse(this.decoder.decode(bytes));
    } catch {
      throw new RunnerRpcProtocolError();
    }
  }

  fail(reason: RunnerRpcLocalFailure) {
    this.result = undefined;
    this.apiError = undefined;
    this.error = reason;
  }

  output() {
    if (this.result) return this.result;
    if (this.apiError) {
      handleError(
        this.apiError,
        "Failed to resolve MCP connectors for this run",
      );
    }
    throw new Error(
      `Could not resolve MCP connectors through this Run's Runner (${this.error ?? "invalid response"})`,
    );
  }
}

export function resolvePublishedMcp(
  authorization: string,
  request: Request,
  signal?: AbortSignal,
) {
  return invokeRunnerRpc(
    "connector.mcp.resolve",
    { authorization, request },
    new RunnerMcpResponse(),
    true,
    signal,
  );
}
