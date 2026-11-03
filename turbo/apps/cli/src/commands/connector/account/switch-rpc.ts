import { literal, object, uuid } from "zod";
import type { ConnectorAccountSelection } from "@okouai/api-contracts/contracts/connector-accounts";
import {
  invokeRunnerRpc,
  rpcErrorSchema,
  RunnerRpcProtocolError,
  type RunnerRpcLocalFailure,
  type RunnerRpcResponseReader,
} from "../../../lib/runner-rpc";

const resultSchema = object({
  type: literal("result"),
  data: object({ connectionId: uuid() }).strict(),
}).strict();
class SwitchResponse implements RunnerRpcResponseReader<string> {
  private pending = Buffer.alloc(0);
  private terminal: { connectionId: string } | { error: string } | undefined;
  private bytes = 0;
  async read(chunk: unknown, _json: boolean, signal: AbortSignal) {
    signal.throwIfAborted();
    if (!Buffer.isBuffer(chunk)) throw new RunnerRpcProtocolError();
    this.bytes += chunk.length;
    if (this.bytes > 2048) throw new RunnerRpcProtocolError();
    this.pending = Buffer.concat([this.pending, chunk]);
    const newline = this.pending.indexOf(10);
    if (newline === -1) return;
    if (this.terminal || newline !== this.pending.length - 1)
      throw new RunnerRpcProtocolError();
    let raw: unknown;
    try {
      raw = JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(
          this.pending.subarray(0, newline),
        ),
      );
    } catch {
      throw new RunnerRpcProtocolError();
    }
    this.pending = Buffer.alloc(0);
    const result = resultSchema.safeParse(raw);
    if (result.success) {
      this.terminal = result.data.data;
      return;
    }
    const error = rpcErrorSchema.safeParse(raw);
    if (!error.success) throw new RunnerRpcProtocolError();
    this.terminal = { error: error.data.code };
  }
  finish(code: number | null, termination: NodeJS.Signals | null) {
    if (
      !this.terminal ||
      this.pending.length !== 0 ||
      termination !== null ||
      ("connectionId" in this.terminal ? code !== 0 : code === 0)
    )
      throw new RunnerRpcProtocolError();
  }
  fail(reason: RunnerRpcLocalFailure) {
    this.terminal = { error: reason };
  }
  output() {
    if (this.terminal && "connectionId" in this.terminal)
      return this.terminal.connectionId;
    throw new Error(
      `Chat selection was saved, but this Run's account publication was not confirmed (${this.terminal && "error" in this.terminal ? this.terminal.error : "invalid response"}). Inspect connector status before continuing; do not automatically replay the switch.`,
    );
  }
}
export async function syncRunConnectorAccount(
  selection: ConnectorAccountSelection,
) {
  const actual = await invokeRunnerRpc(
    "connector.account.sync",
    selection,
    new SwitchResponse(),
  );
  if (actual !== selection.connectionId)
    throw new RunnerRpcProtocolError(
      "Runner acknowledged a different connector account",
    );
}
