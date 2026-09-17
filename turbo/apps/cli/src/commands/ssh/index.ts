import { Command } from "commander";
import { initClient } from "@okouai/api-contracts/contracts/trpc-contract";
import { sshHostsContract } from "@okouai/api-contracts/contracts/ssh-access";
import { z } from "zod";

import {
  getClientConfig,
  handleError,
} from "../../lib/api/core/client-factory";
import { decodeSandboxTokenPayload } from "../../lib/api/sandbox-token";
import { withErrorHandler } from "../../lib/command/with-error-handler";
import { executeSsh } from "./rpc";
import { createSessionCommand } from "./sessions";
import { createFileCommand } from "./files";
import { FILE_LIMIT_HELP } from "./file-protocol";

function requireCapability(capability: "ssh:read" | "ssh:write") {
  if (!decodeSandboxTokenPayload()?.capabilities.includes(capability)) {
    throw new Error(
      `This command requires a Run token with ${capability}. Ask the owner to enable SSH access, then start a new Run.`,
    );
  }
}

const list = new Command("list")
  .description(
    "List live owner hosts authorized for this Agent (not a connectivity check)",
  )
  .option("--json", "Print JSON")
  .action(
    withErrorHandler(async (options: { readonly json?: boolean }) => {
      requireCapability("ssh:read");
      const client = initClient(sshHostsContract, await getClientConfig());
      const result = await client.list();
      if (result.status !== 200) handleError(result, "Cannot list SSH hosts");
      if (options.json) {
        console.log(JSON.stringify(result.body));
        return;
      }
      if (result.body.hosts.length === 0)
        console.log(
          "No SSH hosts configured. Ask the owner to add a host in SSH settings.",
        );
      for (const host of result.body.hosts) {
        console.log(
          `${host.id}  ${host.displayName}  ${host.username}@${host.host}:${host.port}  ${host.learnedHostKey ? "host key learned" : "host key not learned"}`,
        );
      }
    }),
  );

const exec = new Command("exec")
  .description(
    "Execute once through the Runner; never automatically retry an uncertain result",
  )
  .argument("<connection-id>", "Exact ID from ssh host list")
  .requiredOption("--command <command>", "Remote command (up to 64 KiB UTF-8)")
  .option("--json", "Print structured outcome and base64 stdout/stderr")
  .addHelpText(
    "after",
    `
Safety:
  - Use an exact current connection ID from okou ssh host list --json; list again after an unknown or unavailable ID.
  - Inspect structured failure_reason and effects. effects=unknown means the remote command may have run; inspect remote state and never retry automatically.
  - First contact learns the host key (TOFU). An unexpected key requires owner verification and an explicit reset in SSH settings; never accept it automatically.`,
  )
  .action(
    withErrorHandler(
      async (
        connectionId: string,
        options: { readonly command: string; readonly json?: boolean },
      ) => {
        requireCapability("ssh:write");
        if (!z.uuid().safeParse(connectionId).success)
          throw new Error(
            "Invalid SSH connection ID. Use an exact ID from okou ssh host list.",
          );
        if (
          options.command.length === 0 ||
          Buffer.byteLength(options.command) > 65536
        )
          throw new Error("SSH command must contain 1–65536 UTF-8 bytes.");
        const result = await executeSsh(
          connectionId,
          options.command,
          options.json === true,
        );
        if (options.json) console.log(JSON.stringify(result));
        else {
          if (result.type === "failed")
            console.error(
              `SSH failed: ${result.failure_reason}; effects=${result.effects}. ${result.effects === "unknown" ? "The command may have run. Do not automatically retry." : "Check SSH access and host configuration before retrying."}`,
            );
          if (result.type === "rpc_error")
            console.error(
              `SSH helper failed: ${result.code}; delivery=${result.delivery}. ${result.delivery === "unknown" ? "The command may have run. Do not automatically retry." : "Check that this Run has the packaged SSH helper."}`,
            );
          if (result.type === "finished" && result.exit.type === "signal")
            console.error(`SSH command terminated by ${result.exit.signal}`);
          if (result.stdout_truncated || result.stderr_truncated)
            console.error("SSH output was truncated at the per-stream limit.");
        }
        process.exitCode =
          result.type === "finished" && result.exit.type === "status"
            ? result.exit.code <= 255
              ? result.exit.code
              : 1
            : 1;
      },
    ),
  );

export const sshCommand = new Command("ssh")
  .description("Access owner-configured SSH hosts from an authorized Run")
  .addHelpText(
    "after",
    `
Connections use the owner's saved Direct or Cloudflare Access configuration; credentials stay outside the sandbox and no proxy or token options are needed. For Access hosts, the listed hostname and port 443 identify the gateway, not the origin SSH port.

Command guide (read the relevant subcommand's --help before use):
  - Find hosts: okou ssh host list --json
  - Run one command: okou ssh exec <connection-id> --command <command> --json
  - Long commands or persistent shells: okou ssh session --help
    Start with okou ssh session start <connection-id> --command <command> --json, or use --shell instead of --command; add --pty when a terminal is needed.
    Read output and observed state with okou ssh session read <session-id>; no separate status poll is needed. Run okou ssh session read --help for read limits and continuation.
    Close finished sessions with okou ssh session close <session-id> --json.
  - Upload: okou ssh upload <connection-id> <local-file> <remote-file> --json
  - Download: okou ssh download <connection-id> <remote-file> <local-file> --json

Operational safety:
  - Start with okou ssh host list --json and use an exact current connection ID. Never invent an ID or automatically replay an uncertain command.
  - The owner enables SSH access in Agent settings for all configured hosts; agents cannot grant access. Ask for a least-privilege remote SSH user. Configured does not mean connectivity tested.
  - First contact learns a host key (TOFU). An unexpected key requires owner verification and an explicit reset in SSH settings, never automatic acceptance.
  - Inspect structured failure_reason and effects instead of matching error text. effects=unknown means the remote operation may have run.
  - Host inventory is live, while execution authority is cached for this Run and invalidated by notifications. A missed notification can leave stale authority until this Run ends. Ask the owner to end active Runs when immediate revocation is required.
  - Ask the owner to check connection diagnostics in /connectors/ssh when setup fails.

File transfers (upload/download): ${FILE_LIMIT_HELP}
`,
  )
  .addCommand(
    new Command("host")
      .description("Inspect authorized SSH hosts")
      .addCommand(list),
  )
  .addCommand(exec)
  .addCommand(
    createFileCommand("upload", () => {
      requireCapability("ssh:write");
    }),
  )
  .addCommand(
    createFileCommand("download", () => {
      requireCapability("ssh:write");
    }),
  )
  .addCommand(
    createSessionCommand(() => {
      return requireCapability("ssh:write");
    }),
  );
