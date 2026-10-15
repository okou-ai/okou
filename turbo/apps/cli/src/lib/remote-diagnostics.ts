import { Command } from "commander";
import { z } from "zod";
import { decodeSandboxTokenPayload } from "./api/sandbox-token";
import { withErrorHandler } from "./command/with-error-handler";
import {
  invokeRunnerRpc,
  RunnerRpcProtocolError,
  type RunnerRpcResponseReader,
} from "./runner-rpc";

const nativeFailure = z.enum([
  "resource_exhausted",
  "cancelled",
  "domain_failed",
  "cleanup_timed_out",
]);
const sshFailure = z.enum([
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
const vncFailure = z.enum([
  "unavailable",
  "authority_failure",
  "configuration_changed",
  "unsupported_profile",
  "invalid_credential",
  "unsafe_destination",
  "network_failure",
  "protocol",
  "timed_out",
  "cancelled",
  "resource_exhausted",
  "session_not_found",
  "invalid_input",
  "stale_geometry",
  "disconnected",
  "authentication_failed",
  "delivery_unknown",
  "kerberos_expired",
  "kerberos_non_renewable",
  "kerberos_renewal_exhausted",
]);
const cause = z.discriminatedUnion("source", [
  z.strictObject({ source: z.literal("ssh"), code: sshFailure }),
  z.strictObject({ source: z.literal("vnc"), code: vncFailure }),
  z.strictObject({ source: z.literal("native"), code: nativeFailure }),
]);
const protocolSchema = z.enum(["ssh", "vnc"]);
type Protocol = z.infer<typeof protocolSchema>;
const generation = z.number().int().min(1).max(0x7fffffff);
const reportSchema = z.strictObject({
  schema_version: z.literal(1),
  run_id: z.uuid(),
  assignment_id: z.uuid(),
  attempt_id: z.uuid(),
  sequence: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  observed_at: z.iso.datetime(),
  protocol: protocolSchema,
  connection_id: z.uuid(),
  session_id: z.uuid().nullable(),
  configuration_created_at: z.iso.datetime().nullable(),
  configuration_generation: generation.nullable(),
  operation: z.enum([
    "exec",
    "session",
    "file",
    "forwarding",
    "start",
    "capture",
    "input",
    "retirement",
    "native",
  ]),
  stage: z.enum(["ssh_operation", "vnc_operation", "native_runtime"]),
  cause,
  dependencies: z
    .array(
      z.strictObject({
        protocol: z.literal("ssh"),
        connection_id: z.uuid(),
        cause: cause.nullable(),
        configuration_created_at: z.iso.datetime().nullable(),
        configuration_generation: generation.nullable(),
      }),
    )
    .max(1),
  native: z
    .strictObject({
      configuration_id: z.uuid(),
      generation,
      resource_id: z.uuid(),
      evidence: z.strictObject({
        ready: z.boolean(),
        terminal: nativeFailure.nullable(),
        cleanup_complete: z.boolean(),
        cleanup_failure: nativeFailure.nullable(),
      }),
    })
    .nullable(),
  detail: z.literal("not_observed"),
  truncated: z.boolean(),
});
const querySchema = z.strictObject({
  schema_version: z.literal(1),
  status: z.enum([
    "found",
    "no_failure",
    "not_retained",
    "authority_unavailable",
    "unavailable",
  ]),
  report: reportSchema.nullable(),
  retention: z.strictObject({
    capacity: z.literal(64),
    evicted: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    latest_failure_pinned: z.literal(true),
  }),
});
const capabilitiesSchema = z.strictObject({
  schema_version: z.literal(1),
  passive_query: z.boolean(),
  active_check: z.boolean(),
});
const rpcErrorSchema = z.strictObject({
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
});
type LocalFailure = {
  status: "unavailable";
  reason:
    | "helper_unavailable"
    | "unsupported"
    | "unsupported_version"
    | "disabled"
    | "protocol"
    | "transport"
    | "timed_out"
    | "cancelled";
};

class Reader<T> implements RunnerRpcResponseReader<T | LocalFailure> {
  private pending = Buffer.alloc(0);
  private total = 0;
  private terminal: T | LocalFailure | undefined;
  private rpcError = false;
  constructor(private readonly schema: z.ZodType<T>) {}
  async read(chunk: unknown, _json: boolean, signal: AbortSignal) {
    signal.throwIfAborted();
    if (!Buffer.isBuffer(chunk) || this.total + chunk.length > 24 * 1024)
      throw new RunnerRpcProtocolError();
    this.total += chunk.length;
    this.pending = Buffer.concat([this.pending, chunk]);
    let newline: number;
    while ((newline = this.pending.indexOf(10)) !== -1) {
      if (this.terminal || newline === 0) throw new RunnerRpcProtocolError();
      let value: unknown;
      try {
        const line = new TextDecoder("utf-8", { fatal: true }).decode(
          this.pending.subarray(0, newline),
        );
        value = JSON.parse(line);
      } catch {
        throw new RunnerRpcProtocolError();
      }
      this.pending = this.pending.subarray(newline + 1);
      const error = rpcErrorSchema.safeParse(value);
      if (error.success) {
        this.rpcError = true;
        this.terminal = {
          status: "unavailable",
          reason:
            error.data.code === "unknown_method"
              ? "unsupported"
              : "helper_unavailable",
        };
      } else {
        const version = z
          .object({
            type: z.literal("result"),
            data: z.object({ schema_version: z.number().int() }),
          })
          .safeParse(value);
        if (version.success && version.data.data.schema_version !== 1) {
          this.terminal = {
            status: "unavailable",
            reason: "unsupported_version",
          };
          continue;
        }
        const envelope = z
          .strictObject({ type: z.literal("result"), data: this.schema })
          .safeParse(value);
        if (!envelope.success) throw new RunnerRpcProtocolError();
        this.terminal = envelope.data.data;
      }
    }
  }
  finish(code: number | null, termination: NodeJS.Signals | null) {
    if (
      this.pending.length ||
      !this.terminal ||
      termination !== null ||
      (this.rpcError ? code === 0 : code !== 0)
    )
      throw new RunnerRpcProtocolError();
  }
  fail(
    reason: "cancelled" | "timed_out" | "transport" | "protocol",
    delivery: "not_started" | "unknown",
  ) {
    this.terminal = {
      status: "unavailable",
      reason:
        reason === "transport" && delivery === "not_started"
          ? "helper_unavailable"
          : reason,
    };
  }
  output() {
    return (
      this.terminal ?? {
        status: "unavailable" as const,
        reason: "protocol" as const,
      }
    );
  }
}

interface Selector {
  connectionId?: string;
  attemptId?: string;
  sessionId?: string;
}
async function diagnose(protocol: Protocol, selector: Selector, runId: string) {
  const capabilities = await invokeRunnerRpc(
    "remote.diagnostics.capabilities",
    {},
    new Reader(capabilitiesSchema),
    true,
  );
  if ("status" in capabilities) return capabilities;
  if (!capabilities.passive_query)
    return { status: "unavailable", reason: "disabled" } as const;
  const query = await invokeRunnerRpc(
    `${protocol}.diagnose`,
    { ...selector },
    new Reader(querySchema),
    true,
  );
  if ("reason" in query) return query;
  const report = query.report;
  if (
    (query.status === "found") !== (report !== null) ||
    (report &&
      (Buffer.byteLength(JSON.stringify(report)) > 8192 ||
        report.protocol !== protocol ||
        report.run_id !== runId ||
        (selector.connectionId &&
          report.connection_id !== selector.connectionId) ||
        (selector.attemptId && report.attempt_id !== selector.attemptId) ||
        (selector.sessionId && report.session_id !== selector.sessionId)))
  )
    return { status: "unavailable", reason: "protocol" } as const;
  return query;
}

function printHuman(
  protocol: Protocol,
  result: Awaited<ReturnType<typeof diagnose>>,
) {
  if ("report" in result && result.report) {
    const report = result.report;
    console.log(
      `${protocol.toUpperCase()} failure: ${report.cause.source}/${report.cause.code}; host=${report.connection_id}; attempt=${report.attempt_id}; stage=${report.stage}.`,
    );
    for (const dependency of report.dependencies)
      console.log(
        `SSH dependency ${dependency.connection_id}: ${dependency.cause ? `${dependency.cause.source}/${dependency.cause.code}` : "cause not observed"}.`,
      );
    if (report.native)
      console.log(
        `Native resource ${report.native.resource_id}: terminal=${report.native.evidence.terminal ?? "not observed"}; cleanup=${report.native.evidence.cleanup_complete ? (report.native.evidence.cleanup_failure ?? "complete") : "pending"}.`,
      );
    console.log(
      "Finer network stages were not observed. This is retained evidence; current connectivity has not been checked.",
    );
  } else
    console.log(
      `Diagnostics: ${result.status}${"reason" in result ? ` (${result.reason})` : ""}. No connectivity result is available. ${result.status === "authority_unavailable" ? "Check current read permission, host/chat access and API availability." : "History is limited to this Run and requires a supported, enabled Runner helper."}`,
    );
}

export function createDiagnoseCommand(protocol: Protocol) {
  return new Command("diagnose")
    .description(
      `Query this Run's retained ${protocol.toUpperCase()} failure without connecting to the host`,
    )
    .argument(
      "[connection-id]",
      "Exact host ID; omit selectors for this protocol's last failure",
    )
    .option("--attempt-id <id>", "Exact retained diagnostic attempt UUID")
    .option("--session-id <id>", "Exact SSH/VNC session UUID")
    .option("--json", "Print versioned structured evidence")
    .addHelpText(
      "after",
      "\nPassive history only, within this Run. Current read permission and host/chat visibility are required. The latest SSH and VNC failures are pinned; other details are limited to 64 reports. Missing evidence is not a connectivity result. This command never retries commands or input.",
    )
    .action(
      withErrorHandler(
        async (
          connectionId: string | undefined,
          options: { attemptId?: string; sessionId?: string; json?: boolean },
        ) => {
          const token = decodeSandboxTokenPayload();
          if (!token?.capabilities.includes(`${protocol}:read`))
            throw new Error(
              `This command requires a Run token with ${protocol}:read.`,
            );
          const selector: Selector = {};
          for (const [key, value] of Object.entries({
            connectionId,
            attemptId: options.attemptId,
            sessionId: options.sessionId,
          })) {
            if (value !== undefined && !z.uuid().safeParse(value).success)
              throw new Error(
                "Use exact UUID selectors from this Run's host/session list or diagnostic report.",
              );
            if (value !== undefined) {
              if (key === "connectionId")
                selector.connectionId = value.toLowerCase();
              if (key === "attemptId") selector.attemptId = value.toLowerCase();
              if (key === "sessionId") selector.sessionId = value.toLowerCase();
            }
          }
          const result = await diagnose(protocol, selector, token.runId);
          if (options.json) console.log(JSON.stringify(result));
          else printHuman(protocol, result);
          process.exitCode =
            result.status === "found" || result.status === "no_failure" ? 0 : 1;
        },
      ),
    );
}
