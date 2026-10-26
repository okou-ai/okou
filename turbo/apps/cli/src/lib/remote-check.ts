import { Command, Option } from "commander";
import {
  literal,
  strictObject,
  string,
  union,
  uuid,
  enum as zEnum,
  type infer as zInfer,
} from "zod";

import { decodeSandboxTokenPayload } from "./api/sandbox-token";
import { withErrorHandler } from "./command/with-error-handler";
import { diagnosticTextSchema } from "./diagnostic-text";
import {
  invokeRunnerRpc,
  rpcErrorSchema,
  RunnerRpcProtocolError,
  type RunnerRpcLocalFailure,
  type RunnerRpcResponseReader,
} from "./runner-rpc";

const checkSchema = strictObject({
  type: literal("active_check"),
  status: zEnum(["passed", "failed", "blocked"]),
  message: diagnosticTextSchema.pipe(string()),
});
type Check = zInfer<typeof checkSchema>;
const envelope = union([
  strictObject({ type: literal("result"), data: checkSchema }),
  rpcErrorSchema,
]);

class CheckReader implements RunnerRpcResponseReader<Check> {
  private pending = Buffer.alloc(0);
  private total = 0;
  private terminal: Check | undefined;
  private rpcError = false;

  async read(chunk: unknown, _json: boolean, signal: AbortSignal) {
    signal.throwIfAborted();
    if (!Buffer.isBuffer(chunk) || this.total + chunk.length > 24 * 1024)
      throw new RunnerRpcProtocolError();
    this.total += chunk.length;
    this.pending = Buffer.concat([this.pending, chunk]);
    const newline = this.pending.indexOf(10);
    if (newline < 0) return;
    if (this.terminal || newline === 0 || newline !== this.pending.length - 1)
      throw new RunnerRpcProtocolError();
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
    const parsed = envelope.safeParse(decoded);
    if (!parsed.success) throw new RunnerRpcProtocolError();
    this.pending = Buffer.alloc(0);
    if (parsed.data.type === "error") {
      this.rpcError = true;
      const effects =
        parsed.data.delivery === "not_dispatched"
          ? "Runner did not dispatch the check."
          : "The check may have begun; current connectivity is unverified.";
      this.terminal = {
        type: "active_check",
        status: "blocked",
        message: `Active check unavailable: ${parsed.data.code}; delivery=${parsed.data.delivery}. ${effects} Inspect current access and host configuration; never retry automatically.`,
      };
    } else this.terminal = parsed.data.data;
  }

  finish(code: number | null, termination: NodeJS.Signals | null) {
    if (
      this.pending.length ||
      !this.terminal ||
      termination !== null ||
      (this.rpcError ? code !== 1 : code !== 0)
    )
      throw new RunnerRpcProtocolError();
  }

  fail(reason: RunnerRpcLocalFailure, delivery: "not_started" | "unknown") {
    const effects =
      delivery === "not_started"
        ? "No check started."
        : "The check may have begun.";
    this.terminal = {
      type: "active_check",
      status: "blocked",
      message: `Active check could not be verified: ${reason}; delivery=${delivery}. ${effects} Do not infer connection health or retry automatically.`,
    };
  }

  output() {
    if (!this.terminal) throw new Error("Missing active check outcome");
    return this.terminal;
  }
}

export function createCheckCommand(protocol: "ssh" | "vnc") {
  const command = new Command("check")
    .description(
      `Check current ${protocol.toUpperCase()} connection setup and close the temporary connection`,
    )
    .argument("<connection-id>", `Exact current ID from ${protocol} host list`)
    .option(
      "--json",
      "Print active-check status and Runner-authored explanation",
    )
    .addHelpText(
      "after",
      protocol === "ssh"
        ? "\nRequires SSH execution access and enabled diagnostics. Opens a fresh physical SSH connection, performs normal host-key trust/TOFU and authentication, then closes it without any command, shell or file operation. Initial native provisioning can occur under existing policy. Passing verifies authentication at that time, not later command health. Previous operational failure remains available through ssh diagnose. Never retry automatically."
        : "\nRequires VNC execution access and enabled diagnostics. Initializes and closes one temporary session under normal capacity/security policy; no screenshot or input is performed. Shared/exclusive mode can affect other viewers; exclusive requests can disconnect them or be refused. Kerberos can acquire tickets through the configured independent KDC. Foreground sessions are never closed to make room. Passing verifies initialization at that time, not framebuffer/input health. Previous operational failure remains available through vnc diagnose. Never retry or switch modes automatically.",
    );
  if (protocol === "vnc")
    command.addOption(
      new Option("--mode <mode>", "Explicit temporary VNC sharing mode")
        .choices(["shared", "exclusive"])
        .makeOptionMandatory(),
    );
  return command.action(
    withErrorHandler(
      async (
        connectionId: string,
        options: { json?: boolean; mode?: string },
      ) => {
        if (
          !decodeSandboxTokenPayload()?.capabilities.includes(
            `${protocol}:write`,
          )
        )
          throw new Error(
            `Active ${protocol.toUpperCase()} checks require a Run token with ${protocol}:write. Passive read access cannot authorize a login.`,
          );
        if (!uuid().safeParse(connectionId).success)
          throw new Error(`Use an exact UUID from ${protocol} host list.`);
        const params =
          protocol === "vnc"
            ? { connectionId: connectionId.toLowerCase(), mode: options.mode }
            : { connectionId: connectionId.toLowerCase() };
        const result = await invokeRunnerRpc(
          `${protocol}.check`,
          params,
          new CheckReader(),
        );
        if (options.json) console.log(JSON.stringify(result));
        else console.log(result.message);
        process.exitCode = result.status === "passed" ? 0 : 1;
      },
    ),
  );
}
