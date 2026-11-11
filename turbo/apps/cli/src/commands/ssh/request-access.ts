import { Command } from "commander";
import { uuid } from "zod";
import { initClient } from "@okouai/api-contracts/contracts/trpc-contract";
import {
  sshAuthorizationContract,
  sshAuthorizationSchema,
  sshAuthorizationPermissionsSchema,
} from "@okouai/api-contracts/contracts/ssh-authorization";
import { getClientConfig } from "../../lib/api/core/client-factory";
import { handleManagementError } from "../../lib/management-input";
import { withErrorHandler } from "../../lib/command/with-error-handler";
import { requireSandboxCapability } from "./management";

export function createSshRequestAccessCommand() {
  return new Command("request-access")
    .description(
      "Ask the owner to allow one configured SSH host in the current Web Chat",
    )
    .argument(
      "<connection-id>",
      "Exact ID from ssh host list --scope configured",
    )
    .requiredOption(
      "--reason <reason>",
      "Why this task needs SSH access (1–500 characters)",
    )
    .option(
      "--callback-prompt <prompt>",
      "Continuation after approval (1–200 characters; no secrets)",
      "Recheck the approved SSH host access and continue the task. Do not replay uncertain commands.",
    )
    .option(
      "--require-permission <connector/permission>",
      "Wait for an accompanying connector approval; repeat for each required permission",
      (value: string, previous: string[]) => {
        return [...previous, value];
      },
      [],
    )
    .option("--json", "Print the request and exact review URL as JSON")
    .addHelpText(
      "after",
      `\nShare the exact authorizationUrl and end this Run. The user can approve in the message card; approval starts the next round. The request never enables access by itself.\nWhen connector permissions are also needed, include every diagnosed approval with --require-permission, share the existing permission/batch card alongside this URL, and put the callback only on this SSH request. The host card waits until those permissions are approved.\nAccess applies only to this chat, using the existing SSH host selection. It permits SSH commands and file transfers as the configured remote user; --reason is not a per-command restriction.`,
    )
    .action(
      withErrorHandler(
        async (
          connectionId: string,
          options: {
            reason: string;
            callbackPrompt: string;
            requirePermission: string[];
            json?: boolean;
          },
        ) => {
          requireSandboxCapability("connector:read");
          if (!uuid().safeParse(connectionId).success)
            throw new Error(
              "Use an exact configured host ID from okou ssh host list --scope configured --json",
            );
          const requiredPermissions = sshAuthorizationPermissionsSchema.parse(
            options.requirePermission.map((value) => {
              const slash = value.indexOf("/");
              if (slash <= 0 || slash === value.length - 1)
                throw new Error(
                  "--require-permission must use connector/permission, for example cloudflare/dns.write",
                );
              return {
                connectorSlug: value.slice(0, slash),
                permission: value.slice(slash + 1),
              };
            }),
          );
          const body = sshAuthorizationContract.create.body.parse({
            connectionId,
            reason: options.reason,
            callbackPrompt: options.callbackPrompt,
            requiredPermissions,
          });
          const result = await initClient(
            sshAuthorizationContract,
            await getClientConfig(),
          ).create({ body });
          if (result.status !== 200)
            handleManagementError(result, "Cannot request SSH access");
          const request = sshAuthorizationSchema.parse(result.body);
          if (options.json) console.log(JSON.stringify(request));
          else {
            console.log(
              `Review SSH access to ${request.displayName} in this chat:`,
            );
            console.log(request.authorizationUrl);
            console.log(
              "Share this exact URL and end this Run. Approval continues the task automatically; the owner does not need to find the host in settings.",
            );
          }
        },
      ),
    );
}
