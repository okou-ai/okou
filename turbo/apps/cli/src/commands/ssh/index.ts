import { Command, Option } from "commander";
import { initClient } from "@okouai/api-contracts/contracts/trpc-contract";
import {
  sshHostsContract,
  sshHostsResponseSchema,
} from "@okouai/api-contracts/contracts/ssh-access";
import { uuid } from "zod";

import { getClientConfig } from "../../lib/api/core/client-factory";
import { listConfiguredSshHosts } from "../../lib/api/domains/ssh-management";
import { handleManagementError } from "../../lib/management-input";
import {
  addSshHostManagementCommands,
  createSshCredentialCommand,
  requireSandboxCapability,
} from "./management";
import { decodeSandboxTokenPayload } from "../../lib/api/sandbox-token";
import { withErrorHandler } from "../../lib/command/with-error-handler";
import { executeSsh } from "./rpc";
import { createSessionCommand } from "./sessions";
import { createFileCommand } from "./files";
import { FILE_LIMIT_HELP } from "./file-protocol";
import { createDiagnoseCommand } from "../../lib/remote-diagnostics";
import { createCheckCommand } from "../../lib/remote-check";
import { printSshDiagnostics } from "../../lib/ssh-diagnostics";

function requireCapability(capability: "ssh:read" | "ssh:write") {
  if (!decodeSandboxTokenPayload()?.capabilities.includes(capability)) {
    throw new Error(
      `This command requires a Run token with ${capability}. Ask the owner to enable SSH access, then start a new Run.`,
    );
  }
}

const list = new Command("list")
  .description(
    "List hosts visible to this Run with configuration availability (not a connectivity check)",
  )
  .addOption(
    new Option(
      "--scope <scope>",
      "Authorized Run hosts or owned configured hosts",
    )
      .choices(["authorized", "configured"])
      .default("authorized"),
  )
  .option("--json", "Print JSON")
  .action(
    withErrorHandler(
      async (options: { readonly json?: boolean; readonly scope: string }) => {
        if (options.scope === "configured") {
          requireSandboxCapability("connector:read");
          const inventory = await listConfiguredSshHosts();
          console.log(
            JSON.stringify(inventory, null, options.json ? undefined : 2),
          );
          if (!options.json && inventory.connections.length === 0) {
            console.log(
              "No configured SSH hosts. Use okou ssh host create --help to configure one; this does not grant Run access.",
            );
          }
          return;
        }
        requireCapability("ssh:read");
        const client = initClient(sshHostsContract, await getClientConfig());
        const result = await client.list();
        if (result.status !== 200)
          handleManagementError(result, "Cannot list SSH hosts");
        const inventory = sshHostsResponseSchema.safeParse(result.body);
        if (!inventory.success) {
          throw new Error("Invalid SSH host inventory response.");
        }
        if (options.json) {
          console.log(
            JSON.stringify({
              hosts: inventory.data.hosts.map((host) => {
                return {
                  id: host.id,
                  displayName: host.displayName,
                  host: host.host,
                  port: host.port,
                  learnedHostKey: host.learnedHostKey,
                  availability: host.availability,
                };
              }),
            }),
          );
          return;
        }
        if (inventory.data.hosts.length === 0)
          console.log(
            "No SSH hosts available to this Run. Ask the owner to check host setup and chat access in Connectors.",
          );
        for (const host of inventory.data.hosts) {
          const availability =
            host.availability.status === "blocked"
              ? "blocked: needs_rebind (ask the owner to rebind the saved network in Connectors)"
              : "ready to attempt (connectivity not checked)";
          console.log(
            `${host.id}  ${host.displayName}  ${host.host}:${host.port}  ${host.learnedHostKey ? "host key learned" : "host key not learned"}  ${availability}`,
          );
        }
      },
    ),
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
  - Use an exact current connection ID with availability.status=ready from okou ssh host list --json. Blocked IDs are diagnostic only; ask the owner to repair them. List again after an unknown or unavailable ID.
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
        if (!uuid().safeParse(connectionId).success)
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
          printSshDiagnostics(result);
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
  .addCommand(createDiagnoseCommand("ssh"))
  .addCommand(createCheckCommand("ssh"))
  .description("Access owner-configured SSH hosts from an authorized Run")
  .addHelpText(
    "after",
    `
Connections use the owner's saved Direct SSH, Cloudflare Access, Tailscale or Tailscale SSH settings; credentials stay outside the sandbox and no proxy or token options are needed. Both Tailscale modes reuse saved network configurations. Tailscale SSH uses the tagged source identity, destination OS username and port 22, without an SSH password or private key. For Access hosts, the listed hostname and port 443 identify the gateway, not the origin SSH port.

Command guide (read the relevant subcommand's --help before use):
  - Find authorized execution hosts: okou ssh host list --json
  - Manage owned configuration: okou ssh host list --scope configured --json; okou ssh host --help
  - Manage write-only credentials: okou ssh credential --help
    Management uses connector:read/write, preserves ownership, and never grants this Run SSH access.
  - Run one command: okou ssh exec <connection-id> --command <command> --json
  - Long commands or persistent shells: okou ssh session --help
    Start with okou ssh session start <connection-id> --command <command> --json, or use --shell instead of --command; add --pty when a terminal is needed.
    Read output and observed state with okou ssh session read <session-id>; no separate status poll is needed. Run okou ssh session read --help for read limits and continuation.
    Close finished sessions with okou ssh session close <session-id> --json.
  - Upload: okou ssh upload <connection-id> <local-file> <remote-file> --json
  - Download: okou ssh download <connection-id> <remote-file> <local-file> --json

Operational safety:
  - Start with okou ssh host list --json and use an exact current ID only when availability.status=ready. A blocked needs_rebind host must have its network explicitly rebound by its owner. Ready means configured to attempt, not connectivity-tested. Never invent an ID or automatically replay an uncertain command.
  - The owner controls SSH host access with each host's chat default and per-chat host selection; agents cannot grant themselves access. Ask for a least-privilege remote SSH user.
  - First contact learns a host key (TOFU). An unexpected key requires owner verification and an explicit reset in SSH settings, never automatic acceptance.
  - Inspect structured failure_reason and effects instead of matching error text. effects=unknown means the remote operation may have run.
  - Host inventory is live, while execution authority is cached for this Run and invalidated by notifications. A missed notification can leave stale authority until this Run ends. Ask the owner to end active Runs when immediate revocation is required.
  - Ask the owner to check connection diagnostics in the Remote control tab of /connectors when setup fails.

File transfers (upload/download): ${FILE_LIMIT_HELP}
`,
  )
  .addCommand(
    addSshHostManagementCommands(
      new Command("host")
        .description(
          "Inspect authorized hosts or manage owned SSH configuration",
        )
        .addCommand(list),
    ),
  )
  .addCommand(createSshCredentialCommand())
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
