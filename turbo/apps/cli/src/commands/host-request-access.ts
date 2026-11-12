import { hostAuthorizationPermissionsSchema } from "@okouai/api-contracts/contracts/host-authorization";
import { requireVncManagementCapability } from "./vnc/management";
import { Command } from "commander";
import {
  vncAuthorizationContract,
  vncAuthorizationSchema,
} from "@okouai/api-contracts/contracts/vnc-authorization";
import { uuid } from "zod";
import { initClient } from "@okouai/api-contracts/contracts/trpc-contract";
import {
  sshAuthorizationContract,
  sshAuthorizationSchema,
} from "@okouai/api-contracts/contracts/ssh-authorization";
import { getClientConfig } from "../lib/api/core/client-factory";
import { handleManagementError } from "../lib/management-input";
import { withErrorHandler } from "../lib/command/with-error-handler";
import { requireSandboxCapability } from "./ssh/management";

export function createHostRequestAccessCommand(protocol: "ssh" | "vnc") {
  const label = protocol.toUpperCase();
  const contract =
    protocol === "ssh" ? sshAuthorizationContract : vncAuthorizationContract;
  const schema =
    protocol === "ssh" ? sshAuthorizationSchema : vncAuthorizationSchema;
  return new Command("request-access")
    .description(
      `Ask the owner to allow one configured ${label} host in the current Web Chat`,
    )
    .argument(
      "<connection-id>",
      `Exact ID from ${protocol} host list --scope configured`,
    )
    .requiredOption(
      "--reason <reason>",
      `Why this task needs ${label} access (1–500 characters)`,
    )
    .option(
      "--callback-prompt <prompt>",
      "Continuation after approval (1–200 characters; no secrets)",
      `Recheck the approved ${label} host access and continue the task. Do not replay uncertain operations.`,
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
      `\nShare the exact authorizationUrl and end this Run. The user can approve in the message card; approval starts the next round. The request never enables access by itself.\nWhen connector permissions are also needed, include every diagnosed approval with --require-permission, share the existing permission/batch card alongside this URL, and put the callback only on this host request. The host card waits until those permissions are approved.\nAccess applies only to this chat, using the existing ${label} host selection. It permits ${protocol === "ssh" ? "SSH commands and file transfers as the configured remote user" : "viewing and controlling the VNC desktop"}; --reason does not restrict that access.${protocol === "vnc" ? " Approve required SSH tunnel and KDC hosts separately with okou ssh request-access first; each approval continues the task before requesting VNC access." : ""}`,
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
          if (protocol === "ssh") requireSandboxCapability("connector:read");
          else requireVncManagementCapability("connector:read");
          if (!uuid().safeParse(connectionId).success)
            throw new Error(
              `Use an exact configured host ID from okou ${protocol} host list --scope configured --json`,
            );
          const requiredPermissions = hostAuthorizationPermissionsSchema.parse(
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
          const body = contract.create.body.parse({
            connectionId,
            reason: options.reason,
            callbackPrompt: options.callbackPrompt,
            requiredPermissions,
          });
          const result = await initClient(
            contract,
            await getClientConfig(),
          ).create({ body });
          if (result.status !== 200)
            handleManagementError(result, `Cannot request ${label} access`);
          const request = schema.parse(result.body);
          if (options.json) console.log(JSON.stringify(request));
          else {
            console.log(
              `Review ${label} access to ${request.displayName} in this chat:`,
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
