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
  .addCommand(
    new Command("host")
      .description("Inspect authorized SSH hosts")
      .addCommand(list),
  )
  .addCommand(exec)
  .addCommand(
    createSessionCommand(() => {
      return requireCapability("ssh:write");
    }),
  );
