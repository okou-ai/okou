import { randomUUID } from "node:crypto";
import { Command, Option } from "commander";
import { vncConnectionsContract } from "@okouai/api-contracts/contracts/vnc-connections";
import {
  createConfiguredVncHost,
  deleteConfiguredVncHost,
  listConfiguredVncHosts,
  updateConfiguredVncHost,
} from "../../lib/api/domains/vnc-management";
import { handleManagementError } from "../../lib/management-input";
import {
  managementId,
  managementWriteCommand,
  outputManagement,
  requireVncManagementCapability,
  type ManagementOptions,
} from "./management";
import { initClient } from "@okouai/api-contracts/contracts/trpc-contract";
import { vncHostsContract } from "@okouai/api-contracts/contracts/vnc-access";

import { getClientConfig } from "../../lib/api/core/client-factory";
import { withErrorHandler } from "../../lib/command/with-error-handler";
import { outputVncCommandError, outputVncOutcome } from "./output";
import { requireVncCapability } from "./validation";

async function listVncHosts() {
  const client = initClient(vncHostsContract, await getClientConfig());
  const result = await client.list({});
  if (result.status === 200) {
    return {
      ...result,
      body: vncHostsContract.list.responses[200].parse(result.body),
    };
  }
  return result;
}

export function createVncHostCommand(): Command {
  const command = new Command("host")
    .description(
      "Inspect authorized VNC hosts or manage owned host configuration",
    )
    .addCommand(
      new Command("list")
        .description(
          "List hosts visible to this Run with configuration availability (not a connectivity check)",
        )
        .addOption(
          new Option(
            "--scope <scope>",
            "authorized Run hosts or owned configured hosts",
          )
            .choices(["authorized", "configured"])
            .default("authorized"),
        )
        .option("--json", "Print JSON")
        .action(
          withErrorHandler(
            async (options: ManagementOptions & { readonly scope: string }) => {
              if (options.scope === "configured") {
                requireVncManagementCapability("connector:read");
                outputManagement(
                  await listConfiguredVncHosts(),
                  options,
                  "Use okou vnc host show <id>; create configuration with okou vnc host create --input <file|->. Configuration does not grant execution access.",
                );
                return;
              }
              try {
                requireVncCapability("vnc:read");
              } catch (error) {
                outputVncCommandError(error, options.json === true, false);
                return;
              }
              let result;
              try {
                result = await listVncHosts();
              } catch {
                outputVncOutcome(
                  {
                    outcome: "failed",
                    reason: "authority_failure",
                    delivery: "not_dispatched",
                  },
                  options.json,
                );
                return;
              }
              if (result.status !== 200) {
                if (options.json) {
                  outputVncOutcome(
                    {
                      outcome: "failed",
                      reason:
                        result.status === 401 || result.status === 403
                          ? "permission_denied"
                          : result.status === 404
                            ? "unavailable"
                            : "authority_failure",
                      delivery: "not_dispatched",
                    },
                    true,
                  );
                  return;
                }
                handleManagementError(result, "Cannot list VNC hosts");
              }
              if (options.json) {
                console.log(
                  JSON.stringify({
                    hosts: result.body.hosts.map((host) => {
                      return {
                        id: host.id,
                        displayName: host.displayName,
                        host: host.host,
                        port: host.port,
                        authMethod: host.authMethod,
                        securityType: host.securityType,
                        availability:
                          host.availability.status === "ready"
                            ? { status: "ready" }
                            : { status: "blocked", reason: "needs_rebind" },
                      };
                    }),
                  }),
                );
                return;
              }
              if (result.body.hosts.length === 0) {
                console.log(
                  "No VNC hosts available to this Run. Ask the owner to check host setup and chat access in Connectors.",
                );
                return;
              }
              for (const host of result.body.hosts) {
                const availability =
                  host.availability.status === "blocked"
                    ? "blocked: needs_rebind (ask the owner to rebind the underlying SSH host to Cloudflare Access or explicitly choose Direct in SSH settings)"
                    : "ready to attempt (connectivity not checked)";
                console.log(
                  `${host.id}  ${host.displayName}  ${host.host}:${host.port}  ${host.authMethod} / ${host.securityType}  ${availability}`,
                );
              }
              console.log(
                "Use an exact ID with availability.status=ready from okou vnc host list --json; read okou vnc session start --help and choose shared or exclusive mode explicitly.",
              );
            },
          ),
        ),
    );
  command.addCommand(
    new Command("show")
      .description(
        "Show safe configuration metadata for an exact owned host UUID",
      )
      .argument("<id>", "Exact UUID from vnc host list --scope configured")
      .option("--json", "Print safe metadata JSON")
      .action(
        withErrorHandler(async (id: string, options: ManagementOptions) => {
          requireVncManagementCapability("connector:read");
          const connectionId = managementId(id);
          const host = (await listConfiguredVncHosts()).connections.find(
            (item) => {
              return item.id === connectionId;
            },
          );
          if (!host)
            throw new Error(
              "VNC host unavailable. Refresh okou vnc host list --scope configured --json.",
            );
          outputManagement(
            host,
            options,
            "Include expectedGeneration in update/delete input. Use authorized host list before starting a session.",
          );
        }),
      ),
  );
  command.addCommand(
    managementWriteCommand(
      "create",
      "host",
      vncConnectionsContract.create.body.extend({
        id: vncConnectionsContract.create.body.shape.id.default(randomUUID),
      }),
      async (body) => {
        return createConfiguredVncHost(body);
      },
    ),
  );
  command.addCommand(
    managementWriteCommand(
      "update",
      "host",
      vncConnectionsContract.update.body,
      async (body, id) => {
        return updateConfiguredVncHost(managementId(id ?? ""), body);
      },
    ),
  );
  command.addCommand(
    managementWriteCommand(
      "delete",
      "host",
      vncConnectionsContract.delete.body,
      async (body, id) => {
        return deleteConfiguredVncHost(managementId(id ?? ""), body);
      },
    ),
  );
  return command;
}
