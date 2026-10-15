import { Command } from "commander";
import { z } from "zod";
import { decodeSandboxTokenPayload } from "./api/sandbox-token";
import { withErrorHandler } from "./command/with-error-handler";
import {
  invokeRunnerRpc,
  RunnerRpcProtocolError,
  type RunnerRpcResponseReader,
} from "./runner-rpc";

import {
  querySchema,
  capabilitiesSchema,
  rpcErrorSchema,
  type Protocol,
  sshCapabilitiesSchema,
  queryV2Schema,
} from "./remote-diagnostic-schema";
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

class DiagnosticReader<T> implements RunnerRpcResponseReader<T | LocalFailure> {
  private pending = Buffer.alloc(0);
  private total = 0;
  private terminal: T | LocalFailure | undefined;
  private rpcError = false;
  constructor(
    private readonly schema: z.ZodType<T>,
    private readonly version = 1,
  ) {}
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
        if (
          version.success &&
          version.data.data.schema_version !== this.version
        ) {
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

function matchesQuery(
  query: z.infer<typeof queryV2Schema> | z.infer<typeof querySchema>,
  protocol: Protocol,
  selector: Selector,
  runId: string,
) {
  const report = query.report;
  return (
    (query.status === "found") === (report !== null) &&
    (!report ||
      (Buffer.byteLength(JSON.stringify(report)) <= 8192 &&
        report.protocol === protocol &&
        report.run_id === runId &&
        (!selector.connectionId ||
          report.connection_id === selector.connectionId) &&
        (!selector.attemptId || report.attempt_id === selector.attemptId) &&
        (!selector.sessionId || report.session_id === selector.sessionId)))
  );
}

async function diagnose(protocol: Protocol, selector: Selector, runId: string) {
  const support = protocol === "ssh" ? await discoverSshDiagnostics() : null;
  if (
    support &&
    "status" in support &&
    !["unsupported", "unsupported_version"].includes(support.reason)
  )
    return support;
  const version2 = support && !("status" in support);
  if (version2 && !support.passive_query)
    return { status: "unavailable", reason: "disabled" } as const;
  // Keep #40311's explicit old-owner query contract until #40283's GA review
  // establishes that captured CLI/owner consumers and rollback builds drained.
  const capabilities = version2
    ? { passive_query: support.passive_query }
    : await invokeRunnerRpc(
        "remote.diagnostics.capabilities",
        {},
        new DiagnosticReader(capabilitiesSchema),
        true,
      );
  if ("status" in capabilities) return capabilities;
  if (!capabilities.passive_query)
    return { status: "unavailable", reason: "disabled" } as const;
  const query = await invokeRunnerRpc(
    version2 ? support.query_method : `${protocol}.diagnose`,
    { ...selector },
    new DiagnosticReader<
      z.infer<typeof queryV2Schema> | z.infer<typeof querySchema>
    >(version2 ? queryV2Schema : querySchema, version2 ? 2 : 1),
    true,
  );
  if ("reason" in query) return query;
  if (!matchesQuery(query, protocol, selector, runId))
    return { status: "unavailable", reason: "protocol" } as const;
  return query;
}

export function discoverSshDiagnostics(signal?: AbortSignal) {
  const timeout = AbortSignal.timeout(2000);
  return invokeRunnerRpc(
    "ssh.diagnostics.capabilities",
    {},
    new DiagnosticReader(sshCapabilitiesSchema, 2),
    true,
    signal ? AbortSignal.any([signal, timeout]) : timeout,
  );
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
      report.schema_version === 2
        ? `SSH stages: ${JSON.stringify(report.ssh)}; next action: ${report.next_action}. Finer native stages were not observed. This is retained evidence; current connectivity has not been checked.`
        : "Finer network stages were not observed. This is retained evidence; current connectivity has not been checked.",
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
