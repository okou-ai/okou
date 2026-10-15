import { z } from "zod";
import { decodeSandboxTokenPayload } from "./api/sandbox-token";
import { discoverSshDiagnostics } from "./remote-diagnostics";
import { attachmentSchema, type ReportV2 } from "./remote-diagnostic-schema";
import {
  RunnerRpcProtocolError,
  invokeRunnerRpc,
  type RunnerRpcResponseReader,
  type RunnerRpcLocalFailure,
} from "./runner-rpc";

export type DiagnosticSupport = Awaited<
  ReturnType<typeof discoverSshDiagnostics>
>;
type Support = DiagnosticSupport;
export type DiagnosticResult =
  z.infer<typeof attachmentSchema> | { status: "unavailable"; reason: string };
export type Diagnosed<T> = T & { diagnostics?: DiagnosticResult };
const envelope = z
  .object({
    type: z.literal("result"),
    data: z.record(z.string(), z.unknown()),
  })
  .passthrough();
const outcome = z
  .object({
    type: z.string(),
    failure_reason: z.string().nullable().optional(),
    session: z
      .object({
        ssh_connection_id: z.string(),
        state: z
          .object({ type: z.string(), failure_reason: z.string().optional() })
          .passthrough(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

export class SshDiagnosticContext {
  readonly cancelled: boolean;
  readonly wireMethod: string;
  readonly enabled: boolean;
  private candidate: unknown;
  private localFailure: string | undefined;
  private readonly run = decodeSandboxTokenPayload()?.runId;
  constructor(
    readonly method: string,
    private readonly params: Readonly<Record<string, unknown>>,
    private readonly support: Support,
  ) {
    this.cancelled = "status" in support && support.reason === "cancelled";
    const proposed = `${method}.diagnostics.v2`;
    this.enabled =
      !("status" in support) &&
      support.passive_query &&
      support.automatic_methods.some((m) => {
        return m === proposed;
      });
    // #40311 requires one legacy dispatch for unsupported/disabled owners.
    // Revisit at #40283's GA gate after captured CLI/owner consumers and
    // rollback builds have drained; this never retries a business call.
    this.wireMethod = this.enabled ? proposed : method;
  }
  strip(value: unknown): unknown {
    if (!this.enabled) return value;
    const parsed = envelope.safeParse(value);
    if (!parsed.success) return value;
    const { diagnostics, ...data } = parsed.data.data;
    this.candidate = diagnostics;
    return { ...parsed.data, data };
  }
  fail(reason: string) {
    this.candidate = undefined;
    this.localFailure = reason;
  }
  attach<T extends object>(business: T): Diagnosed<T> {
    const parsed = outcome.safeParse(business);
    const failure = parsed.success
      ? parsed.data.type === "failed"
        ? parsed.data.failure_reason
        : parsed.data.session?.state.type === "failed"
          ? parsed.data.session.state.failure_reason
          : undefined
      : undefined;
    const rpcFailure = parsed.success && parsed.data.type === "rpc_error";
    if (!failure && !rpcFailure) return business;
    let diagnostic: DiagnosticResult;
    const candidate = attachmentSchema.safeParse(this.candidate);
    if (
      this.enabled &&
      !this.localFailure &&
      candidate.success &&
      candidate.data.status === "found" &&
      this.matches(
        candidate.data.report,
        failure,
        parsed.success ? parsed.data.session?.ssh_connection_id : undefined,
      )
    )
      diagnostic = candidate.data;
    else if (
      this.enabled &&
      !this.localFailure &&
      candidate.success &&
      candidate.data.status === "unavailable"
    )
      diagnostic = candidate.data;
    else
      diagnostic = {
        status: "unavailable",
        reason: this.unavailableReason(),
      };
    return Object.assign(business, { diagnostics: diagnostic });
  }
  private unavailableReason(): string {
    if (this.localFailure) return this.localFailure;
    if (this.enabled)
      return this.candidate === undefined ? "not_recorded" : "protocol";
    if ("status" in this.support) return this.support.reason;
    return this.support.passive_query ? "unsupported" : "disabled";
  }
  private matches(
    report: ReportV2,
    failure: string | null | undefined,
    sessionConnection: string | undefined,
  ) {
    const connection = this.params.sshConnectionId ?? sessionConnection;
    const session = this.params.sessionId;
    const operation = this.method.startsWith("ssh.file.")
      ? "file"
      : this.method.startsWith("ssh.session.")
        ? "session"
        : "exec";
    return (
      report.protocol === "ssh" &&
      report.run_id === this.run &&
      report.cause.code === failure &&
      report.operation === operation &&
      (typeof connection !== "string" ||
        report.connection_id === connection.toLowerCase()) &&
      (typeof session !== "string" ||
        report.session_id === session.toLowerCase()) &&
      Buffer.byteLength(JSON.stringify(report)) <= 8192
    );
  }
}

export async function sshDiagnosticContext(
  method: string,
  params: Readonly<Record<string, unknown>>,
  support?: Support,
  signal?: AbortSignal,
) {
  return new SshDiagnosticContext(
    method,
    params,
    support ?? (await discoverSshDiagnostics(signal)),
  );
}

class Reader<T extends object> implements RunnerRpcResponseReader<
  Diagnosed<T>
> {
  private pending = Buffer.alloc(0);
  private total = 0;
  constructor(
    private readonly business: RunnerRpcResponseReader<T>,
    private readonly context: SshDiagnosticContext,
  ) {}
  async read(chunk: unknown, json: boolean, signal: AbortSignal) {
    signal.throwIfAborted();
    if (!Buffer.isBuffer(chunk) || this.total + chunk.length > 4 * 1024 * 1024)
      throw new RunnerRpcProtocolError();
    this.total += chunk.length;
    this.pending = Buffer.concat([this.pending, chunk]);
    let newline: number;
    while ((newline = this.pending.indexOf(10)) !== -1) {
      if (newline === 0 || newline > 24576) throw new RunnerRpcProtocolError();
      let decoded: unknown;
      try {
        decoded = JSON.parse(
          new TextDecoder("utf-8", { fatal: true }).decode(
            this.pending.subarray(0, newline),
          ),
        );
      } catch {
        throw new RunnerRpcProtocolError();
      }
      this.pending = this.pending.subarray(newline + 1);
      await this.business.read(
        Buffer.from(JSON.stringify(this.context.strip(decoded)) + "\n"),
        json,
        signal,
      );
    }
    if (this.pending.length > 24576) throw new RunnerRpcProtocolError();
  }
  finish(code: number | null, signal: NodeJS.Signals | null) {
    if (this.pending.length) throw new RunnerRpcProtocolError();
    this.business.finish(code, signal);
  }
  fail(reason: RunnerRpcLocalFailure, delivery: "not_started" | "unknown") {
    this.context.fail(reason);
    this.business.fail(reason, delivery);
  }
  output() {
    return this.context.attach(this.business.output());
  }
}

export async function invokeDiagnosedSsh<T extends object>(
  method: string,
  params: Readonly<Record<string, unknown>>,
  reader: RunnerRpcResponseReader<T>,
  json = true,
  signal?: AbortSignal,
  support?: Support,
): Promise<Diagnosed<T>> {
  if (method === "ssh.session.list")
    return invokeRunnerRpc(method, params, reader, json, signal);
  const context = await sshDiagnosticContext(method, params, support, signal);
  if (context.cancelled) {
    reader.fail("cancelled", "not_started");
    context.fail("cancelled");
    return context.attach(reader.output());
  }
  return invokeRunnerRpc(
    context.wireMethod,
    params,
    new Reader(reader, context),
    json,
    signal,
  );
}

const guidance: Record<ReportV2["next_action"], string> = {
  check_access_certificate:
    "Check the Access gateway certificate and TLS trust.",
  check_access_policy:
    "Check the Cloudflare Access service token and application policy.",
  check_access_websocket:
    "Check the Access WebSocket upgrade and binary carrier.",
  check_access_route:
    "Check the Cloudflare Access gateway route and availability.",
  verify_host_key:
    "Verify the server host key through a trusted channel before updating trust.",
  check_credential:
    "Check the configured SSH credential and allowed authentication method.",
  check_authority: "Check current Run, chat and host access and configuration.",
  check_capacity: "Check Run and host connection capacity.",
  check_destination_policy:
    "Check that the configured destination resolves only to permitted addresses.",
  check_transfer_limits: "Check file size and concurrent transfer limits.",
  check_remote_file:
    "Check the remote path, permissions and file-operation outcome.",
  inspect_native_source:
    "Inspect the retained native source before starting another operation.",
  check_dns: "Check destination DNS resolution.",
  check_route_and_port: "Check the selected address, route and SSH port.",
  inspect_operation_without_replay:
    "Inspect the SSH operation and its effects before any manual retry.",
};
export function diagnosticText(diagnostic: DiagnosticResult): string {
  if (diagnostic.status !== "found")
    return `Diagnostics unavailable (${diagnostic.reason}); exact failure association was not established.`;
  const report = diagnostic.report;
  const trace = report.ssh;
  const stages =
    trace?.stages
      .filter((s) => {
        return s.status === "failed" || s.status === "unknown";
      })
      .map((s) => {
        return `${s.stage}=${s.status}`;
      })
      .join(", ") || "no finer failed stage observed";
  return `Diagnostic ${report.attempt_id}: ${report.cause.source}/${report.cause.code}; ${trace?.route ?? "unknown"}/${trace?.transport ?? "unknown"}${trace?.selected_address ? `; ${trace.selected_address} (${trace.address_family})` : ""}; ${stages}. ${guidance[report.next_action]} Retained evidence does not check current connectivity.`;
}
export function printSshDiagnostics(result: {
  diagnostics?: DiagnosticResult;
}) {
  if (result.diagnostics) console.error(diagnosticText(result.diagnostics));
}
