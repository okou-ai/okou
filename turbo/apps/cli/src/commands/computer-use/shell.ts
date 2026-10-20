import { stripVTControlCharacters } from "node:util";
import { Command } from "commander";
import {
  desktopShellRequestSchema,
  desktopShellResultSchema,
  type DesktopShellRequest,
} from "@okouai/api-contracts/contracts/desktop-shell";
import {
  createDesktopShellCommand,
  requestDesktopShellAccess,
} from "../../lib/api/domains/computer-use";
import { ApiRequestError } from "../../lib/api/core/client-factory";
import { decodeSandboxTokenPayload } from "../../lib/api/sandbox-token";
import { withErrorHandler } from "../../lib/command/with-error-handler";
import { waitForComputerUseCommand } from "./wait-for-command";

interface ShellOptions {
  session?: string;
  input?: string;
  key?: string;
  new?: boolean;
  cwd?: string;
  cursor?: string;
  wait?: string;
  all?: boolean;
  json?: boolean;
}

function integer(value: string | undefined, label: string): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0)
    throw new Error(`${label} must be a non-negative integer`);
  return parsed;
}

async function run(
  kind: DesktopShellRequest["kind"],
  command: string | undefined,
  options: ShellOptions,
): Promise<void> {
  const token = decodeSandboxTokenPayload();
  if (token && !token.capabilities.includes("computer-use:shell:write")) {
    throw new Error(
      "Shell authorization required: enable Desktop Shell for your workspace, select this computer before starting a new run, and enable Shell Access in Desktop Developer Tools. Existing tokens cannot gain computer-use:shell:write in place.",
    );
  }
  const parsed = desktopShellRequestSchema.safeParse({
    kind,
    command,
    sessionId: options.session,
    input: options.input,
    key: options.key,
    newSession: options.new,
    cwd: options.cwd,
    cursor: integer(options.cursor, "cursor"),
    waitMs: (integer(options.wait, "wait") ?? 10) * 1000,
    all: options.all,
    realtime: true,
  });
  if (!parsed.success)
    throw new Error(
      parsed.error.issues
        .map((issue) => {
          return issue.message;
        })
        .join("; "),
    );
  const created = await createDesktopShellCommand(parsed.data).catch(
    (cause: unknown) => {
      const mutation =
        command !== undefined ||
        options.input !== undefined ||
        options.key !== undefined;
      if (
        !mutation ||
        (cause instanceof ApiRequestError && cause.status < 500)
      ) {
        throw cause;
      }
      throw new Error(
        "Shell submission outcome is unknown; input may have been delivered. Use shell list and observe the existing session before deciding what to do. Do not replay input.",
        { cause },
      );
    },
  );
  await waitForComputerUseCommand(
    created,
    parsed.data.waitMs / 1000 + 20,
    async (operation) => {
      const { outputBase64, ...result } = desktopShellResultSchema.parse(
        operation.result,
      );
      const raw =
        outputBase64 === undefined
          ? undefined
          : Buffer.from(outputBase64, "base64").toString("utf8");
      // Escape console control bytes in JSON; preserve lossless bytes separately.
      const output =
        raw === undefined ? undefined : stripVTControlCharacters(raw);
      return JSON.stringify(
        {
          operationId: operation.id,
          hostId: operation.hostId,
          hostName: operation.hostName,
          ...result,
          ...(options.json ? { outputBase64 } : {}),
          output,
        },
        null,
        options.json ? undefined : 2,
      );
    },
    {
      progress: false,
      timeoutGuidance:
        ". Input may have been delivered; do not replay it. Observe the shell session instead.",
    },
  );
}

export function createShellCommand(): Command {
  const cmd = new Command("cmd")
    .description(
      "Run a command, send interactive input, or observe without sending input",
    )
    .argument(
      "[command]",
      "Shell command (Enter is appended); omit to observe the existing session",
    )
    .option("--session <id>", "Exact session ID on the authorized computer")
    .option(
      "--new",
      "Create another session instead of reusing the only live one",
    )
    .option(
      "--cwd <path>",
      "Absolute Mac directory for a new session; defaults to Mac home",
    )
    .option("--input <text>", "Exact interactive input; no newline is added")
    .option("--key <key>", "Ctrl+C, Ctrl+D, Ctrl+Z, Enter, Escape, or Tab")
    .option(
      "--cursor <bytes>",
      "Resume non-consuming output from this byte cursor",
    )
    .option(
      "--wait <seconds>",
      "Bounded observation, 1–30 seconds; running commands remain alive",
      "10",
    )
    .option(
      "--json",
      "Compact JSON with lossless outputBase64 and output cursors",
    )
    .action(
      withErrorHandler(
        async (command: string | undefined, options: ShellOptions) => {
          return run("shell.cmd", command, options);
        },
      ),
    );

  return new Command("shell")
    .description(
      "Interactive terminal sessions on the computer authorized for this run",
    )
    .addHelpText(
      "after",
      `
Sessions belong to this computer, account and workspace; later authorized runs can reuse them.
No session + a command creates one. One live session is reused; multiple require --session.
An observation returning running is not command completion. Never replay uncertain input.
Use the returned nextCursor to observe more output. list/status do not renew the 15-minute idle timer.
Output and background jobs do not prevent idle closure. Desktop Stop, logout and Shell Access off close sessions.
All Shell operations also require one-hour approval for this chat and computer.
Use request-access, share its link, and end this Run. Approval starts the next chat round.
Expiry or revocation blocks new operations without closing PTYs; existing idle cleanup still applies.

Examples:
  okou computer-use shell cmd 'pwd'
  okou computer-use shell cmd 'cd ~/project && npm test' --session <id> --wait 10
  okou computer-use shell cmd --session <id> --cursor <nextCursor>
  okou computer-use shell cmd --session <id> --input 'yes'
  okou computer-use shell cmd --session <id> --key Enter
  okou computer-use shell cmd --session <id> --key Ctrl+C
  okou computer-use shell list
  okou computer-use shell close --all`,
    )
    .addCommand(
      new Command("request-access")
        .description(
          "Ask the user to allow Shell access for this chat and computer for one hour",
        )
        .requiredOption(
          "--reason <text>",
          "Why the current task needs terminal access",
        )
        .option("--json", "Structured application and authorization state")
        .action(
          withErrorHandler(
            async (options: { reason: string; json?: boolean }) => {
              const result = await requestDesktopShellAccess(options.reason);
              if (options.json) {
                console.log(JSON.stringify(result));
                return;
              }
              if (result.status === "approved") {
                console.log(
                  `Shell access is already approved for this chat on ${result.computerName} until ${result.grantExpiresAt}. Continue using Shell without requesting another approval.`,
                );
                return;
              }
              console.log(
                `Shell access request for ${result.computerName}: ${result.status}`,
              );
              console.log(result.authorizationUrl);
              if (result.status !== "pending") {
                console.log(
                  "This request is closed and grants no Shell access. End this Run; request access from a new chat round if the task still needs it.",
                );
                return;
              }
              console.log(
                `The pending request expires at ${result.requestExpiresAt}. Access lasts one hour from approval.`,
              );
              console.log(
                "Share this link with the user and end the current Run. After this Run ends, approval automatically starts the next chat round. Do not wait for approval or replay input with an uncertain outcome.",
              );
            },
          ),
        ),
    )
    .addCommand(cmd)
    .addCommand(
      new Command("list")
        .description(
          "List this computer's live Okou shell sessions across runs",
        )
        .option("--json", "Compact JSON")
        .action(
          withErrorHandler(async (options: ShellOptions) => {
            return run("shell.list", undefined, options);
          }),
        ),
    )
    .addCommand(
      new Command("status")
        .description("Inspect a session without renewing its idle timer")
        .argument("<session-id>", "Session ID")
        .option("--json", "Compact JSON")
        .action(
          withErrorHandler(async (session: string, options: ShellOptions) => {
            return run("shell.status", undefined, { ...options, session });
          }),
        ),
    )
    .addCommand(
      new Command("close")
        .description("Close a session or all sessions on this computer")
        .argument("[session-id]", "Session ID, or use --all")
        .option("--all", "Close all sessions for this account and workspace")
        .option("--json", "Compact JSON")
        .action(
          withErrorHandler(
            async (session: string | undefined, options: ShellOptions) => {
              return run("shell.close", undefined, { ...options, session });
            },
          ),
        ),
    );
}
