import { Command } from "commander";
import { z } from "zod";
import { decodeSandboxTokenPayload } from "./api/sandbox-token";
import { withErrorHandler } from "./command/with-error-handler";
import { diagnosticTextSchema } from "./diagnostic-text";
import {
  invokeRunnerRpc,
  rpcErrorSchema,
  RunnerRpcProtocolError,
  type RunnerRpcResponseReader,
  type RunnerRpcLocalFailure,
} from "./runner-rpc";

type Protocol = "ssh" | "vnc";
const querySchema = z.strictObject({
  status: z.enum([
    "found",
    "no_failure",
    "not_retained",
    "authority_unavailable",
    "unavailable",
  ]),
  message: diagnosticTextSchema.pipe(z.string()),
});
type Query = z.infer<typeof querySchema>;
type Unavailable = { status: "unavailable"; reason: string; message: string };
const envelope = z.union([
  z.strictObject({ type: z.literal("result"), data: querySchema }),
  rpcErrorSchema,
]);

class DiagnosticReader implements RunnerRpcResponseReader<Query | Unavailable> {
  private pending = Buffer.alloc(0);
  private total = 0;
  private terminal: Query | Unavailable | undefined;
  private rpcError = false;

  async read(chunk: unknown, _json: boolean, signal: AbortSignal) {
    signal.throwIfAborted();
    if (!Buffer.isBuffer(chunk) || this.total + chunk.length > 24 * 1024)
      throw new RunnerRpcProtocolError();
    this.total += chunk.length;
    this.pending = Buffer.concat([this.pending, chunk]);
    const newline = this.pending.indexOf(10);
    if (newline === -1) return;
    if (this.terminal || newline === 0 || newline !== this.pending.length - 1)
      throw new RunnerRpcProtocolError();
    let value: unknown;
    try {
      value = JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(
          this.pending.subarray(0, newline),
        ),
      );
    } catch {
      throw new RunnerRpcProtocolError();
    }
    const parsed = envelope.safeParse(value);
    if (!parsed.success) throw new RunnerRpcProtocolError();
    this.pending = Buffer.alloc(0);
    if (parsed.data.type === "error") {
      this.rpcError = true;
      this.terminal = {
        status: "unavailable",
        reason: parsed.data.code,
        message:
          "Diagnostic history is unavailable from this Runner helper. Current connectivity has not been checked.",
      };
    } else this.terminal = parsed.data.data;
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

  fail(reason: RunnerRpcLocalFailure, delivery: "not_started" | "unknown") {
    this.terminal = {
      status: "unavailable",
      reason:
        reason === "transport" && delivery === "not_started"
          ? "helper_unavailable"
          : reason,
      message:
        "Diagnostic history could not be read. Current connectivity has not been checked.",
    };
  }

  output() {
    if (!this.terminal) throw new Error("Missing diagnostic query outcome");
    return this.terminal;
  }
}

export function createDiagnoseCommand(protocol: Protocol) {
  return new Command("diagnose")
    .description(
      `Read this Run's retained ${protocol.toUpperCase()} failure without connecting to the host`,
    )
    .argument(
      "[connection-id]",
      "Exact host ID; omit selectors for this protocol's last failure",
    )
    .option(
      "--attempt-id <id>",
      "Prefer the Attempt ID from the actual failed operation",
    )
    .option("--session-id <id>", "Exact SSH/VNC session UUID")
    .option("--json", "Print query status and Runner-authored explanation text")
    .addHelpText(
      "after",
      `\nPrefer the actual failed operation's Attempt ID: okou ${protocol} diagnose <connection-id> --attempt-id <attempt-id> --json. Add --session-id <id> when known; all supplied selectors must match.
Without --attempt-id, this returns the latest matching retained failure. Verify its operation, connection, session, and time before attributing it to a particular operation. If the exact attempt is not retained, report its evidence as unavailable; do not substitute another failure.
Passive history only, within this Run. Current read permission and host/chat visibility are required. Latest SSH/VNC failures are pinned; other details are limited to 64 reports. Missing evidence is not a connectivity result. This command never retries commands or input. Never automatically replay uncertain commands, input, or checks.`,
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
          const selector: Record<string, string> = {};
          for (const [key, value] of Object.entries({
            connectionId,
            attemptId: options.attemptId,
            sessionId: options.sessionId,
          })) {
            if (value !== undefined) {
              if (!z.uuid().safeParse(value).success)
                throw new Error(
                  "Use exact UUID selectors from this Run's host/session list or diagnostic explanation.",
                );
              selector[key] = value.toLowerCase();
            }
          }
          const result = await invokeRunnerRpc(
            `${protocol}.diagnose`,
            selector,
            new DiagnosticReader(),
          );
          if (options.json) console.log(JSON.stringify(result));
          else console.log(result.message);
          process.exitCode =
            result.status === "found" || result.status === "no_failure" ? 0 : 1;
        },
      ),
    );
}
