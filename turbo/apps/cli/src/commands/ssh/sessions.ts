import { Command } from "commander";
import { z } from "zod";
import { withErrorHandler } from "../../lib/command/with-error-handler";
import { sessionRpc } from "./session-rpc";
import { writeOutput } from "./rpc";

function id(value: string) {
  if (!z.uuid().safeParse(value).success)
    throw new Error("Use an exact ID from ssh host list or ssh session list.");
  return value.toLowerCase();
}

async function output(
  result: Awaited<ReturnType<typeof sessionRpc>>,
  json?: boolean,
) {
  process.exitCode = ["failed", "rpc_error", "rejected"].includes(result.type)
    ? 1
    : 0;
  if (json) {
    console.log(JSON.stringify(result));
    return;
  }
  switch (result.type) {
    case "started":
      console.log(
        `${result.session_id}\nUse ssh session status to check setup, then read or write this session.`,
      );
      break;
    case "sessions":
      if (!result.sessions.length)
        console.log(
          "No retained SSH sessions in this Run. Use ssh session start to create one.",
        );
      for (const session of result.sessions)
        console.log(
          `${session.session_id}  ${session.ssh_connection_id}  ${session.state.type}`,
        );
      break;
    case "read": {
      const signal = AbortSignal.timeout(65_000);
      if (result.lost)
        console.error(
          `Output bytes ${result.lost.from}–${result.lost.to} were discarded from the bounded buffer.`,
        );
      for (const chunk of result.chunks) {
        const stream =
          chunk.stream === "stdout" ? process.stdout : process.stderr;
        await writeOutput(stream, Buffer.from(chunk.data, "base64"), signal);
      }
      console.error(
        `next_cursor=${result.next_cursor}; state=${result.session.state.type}`,
      );
      break;
    }
    case "status":
      console.log(JSON.stringify(result.session, null, 2));
      break;
    case "submitted":
      console.log(
        `Submitted to ${result.session_id}; remote effects are unknown. Do not automatically replay input or signals.`,
      );
      break;
    case "closed":
      console.log(
        `Closed ${result.session_id}; effects=${result.effects}. Closing SSH does not confirm remote processes stopped.`,
      );
      break;
    case "rejected":
      console.error(
        `SSH session request rejected: ${result.reason}. Inspect session status before sending more input.`,
      );
      break;
    case "failed":
      console.error(
        `SSH session failed: ${result.failure_reason}; effects=${result.effects}. ${result.effects === "unknown" ? "Do not automatically retry. Inspect ssh session list and status." : "Check session status, SSH access and host configuration."}`,
      );
      break;
    case "rpc_error":
      console.error(
        `SSH helper failed: ${result.code}; delivery=${result.delivery}. ${result.code === "unknown_method" ? "This Runner does not support managed sessions. Start a new Run after the Runner is updated." : "Inspect ssh session list before retrying an uncertain operation."}`,
      );
      break;
  }
}

export function createSessionCommand(requireCapability: () => void) {
  const session = new Command("session").description(
    "Manage SSH commands and shells within the current Run (up to 8 retained sessions)",
  );
  session.addCommand(
    new Command("start")
      .description(
        "Start a command or shell; setup continues after the session ID is returned",
      )
      .argument("<connection-id>", "Exact ID from ssh host list")
      .option("--command <command>", "Remote command (1–65536 UTF-8 bytes)")
      .option("--shell", "Start a persistent remote shell")
      .option("--pty", "Request an 80x24 xterm-256color terminal")
      .option("--json", "Print JSON")
      .action(
        withErrorHandler(
          async (
            connectionId: string,
            options: {
              command?: string;
              shell?: boolean;
              pty?: boolean;
              json?: boolean;
            },
          ) => {
            requireCapability();
            if ((options.command !== undefined) === (options.shell === true))
              throw new Error("Choose exactly one of --command or --shell.");
            if (
              options.command !== undefined &&
              (!options.command.length ||
                Buffer.byteLength(options.command) > 65536)
            )
              throw new Error("SSH command must contain 1–65536 UTF-8 bytes.");
            await output(
              await sessionRpc("start", {
                sshConnectionId: id(connectionId),
                program: options.shell
                  ? { type: "shell" }
                  : { type: "exec", command: options.command },
                pty: options.pty === true,
              }),
              options.json,
            );
          },
        ),
      ),
  );
  session.addCommand(
    new Command("list")
      .description("List this Run's active and recently completed sessions")
      .option("--json", "Print JSON")
      .action(
        withErrorHandler(async (options: { json?: boolean }) => {
          requireCapability();
          await output(await sessionRpc("list", {}), options.json);
        }),
      ),
  );
  for (const method of ["status", "close"] as const) {
    session.addCommand(
      new Command(method)
        .description(
          method === "status"
            ? "Inspect session setup, exit and output cursors"
            : "Retire the session ID and close SSH; remote process termination is not guaranteed",
        )
        .argument("<session-id>", "Exact ID from ssh session start or list")
        .option("--json", "Print JSON")
        .action(
          withErrorHandler(
            async (sessionId: string, options: { json?: boolean }) => {
              requireCapability();
              await output(
                await sessionRpc(method, { sessionId: id(sessionId) }),
                options.json,
              );
            },
          ),
        ),
    );
  }
  session.addCommand(
    new Command("read")
      .description(
        "Read up to 8 KiB without consuming output; continue with next_cursor",
      )
      .argument("<session-id>", "Exact session ID")
      .option("--cursor <offset>", "Nonnegative byte cursor", "0")
      .option("--json", "Print JSON with base64 chunks and any lost range")
      .action(
        withErrorHandler(
          async (
            sessionId: string,
            options: { cursor: string; json?: boolean },
          ) => {
            requireCapability();
            const cursor = Number(options.cursor);
            if (
              !/^(0|[1-9][0-9]*)$/.test(options.cursor) ||
              !Number.isSafeInteger(cursor)
            )
              throw new Error(
                "Cursor must be a nonnegative safe integer from the previous read result.",
              );
            await output(
              await sessionRpc("read", { sessionId: id(sessionId), cursor }),
              options.json,
            );
          },
        ),
      ),
  );
  session.addCommand(
    new Command("write")
      .description(
        "Submit at most 16 KiB to stdin; never automatically replay an uncertain write",
      )
      .argument("<session-id>", "Exact session ID")
      .option("--text <text>", "UTF-8 input")
      .option("--base64 <data>", "Canonical base64 input")
      .option("--eof", "Close stdin after this input")
      .option("--json", "Print JSON")
      .action(
        withErrorHandler(
          async (
            sessionId: string,
            options: {
              text?: string;
              base64?: string;
              eof?: boolean;
              json?: boolean;
            },
          ) => {
            requireCapability();
            if (options.text !== undefined && options.base64 !== undefined)
              throw new Error("Choose either --text or --base64.");
            const bytes =
              options.base64 !== undefined
                ? Buffer.from(options.base64, "base64")
                : Buffer.from(options.text ?? "", "utf8");
            if (
              options.base64 !== undefined &&
              bytes.toString("base64") !== options.base64
            )
              throw new Error("Input must be canonical base64.");
            if (bytes.length > 16384 || (!bytes.length && !options.eof))
              throw new Error("Provide 1–16384 input bytes or --eof.");
            await output(
              await sessionRpc("write", {
                sessionId: id(sessionId),
                dataBase64: bytes.toString("base64"),
                eof: options.eof === true,
              }),
              options.json,
            );
          },
        ),
      ),
  );
  session.addCommand(
    new Command("signal")
      .description(
        "Submit an SSH signal request; remote handling is not confirmed",
      )
      .argument("<session-id>", "Exact session ID")
      .requiredOption("--signal <signal>", "INT, TERM, KILL, HUP, USR1 or USR2")
      .option("--json", "Print JSON")
      .action(
        withErrorHandler(
          async (
            sessionId: string,
            options: { json?: boolean },
            command: Command,
          ) => {
            requireCapability();
            const signalName: unknown = command.getOptionValue("signal");
            if (
              typeof signalName !== "string" ||
              !["INT", "TERM", "KILL", "HUP", "USR1", "USR2"].includes(
                signalName,
              )
            )
              throw new Error(
                "Signal must be INT, TERM, KILL, HUP, USR1 or USR2.",
              );
            await output(
              await sessionRpc("signal", {
                sessionId: id(sessionId),
                signal: signalName,
              }),
              options.json,
            );
          },
        ),
      ),
  );
  return session;
}
