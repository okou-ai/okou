import { Command } from "commander";
import { initClient } from "@okouai/api-contracts/contracts/trpc-contract";
import { vncHostsContract } from "@okouai/api-contracts/contracts/vnc-access";

import {
  getClientConfig,
  handleError,
} from "../../lib/api/core/client-factory";
import { withErrorHandler } from "../../lib/command/with-error-handler";
import { outputVncCommandError, outputVncOutcome } from "./output";
import { requireVncCapability } from "./validation";

async function listVncHosts() {
  const client = initClient(vncHostsContract, await getClientConfig());
  const result = await client.list();
  if (result.status === 200) {
    return {
      ...result,
      body: vncHostsContract.list.responses[200].parse(result.body),
    };
  }
  return result;
}

export function createVncHostCommand(): Command {
  return new Command("host")
    .description("Inspect authorized owner-configured VNC hosts")
    .addCommand(
      new Command("list")
        .description(
          "List hosts visible to this Run with configuration availability (not a connectivity check)",
        )
        .option("--json", "Print JSON")
        .action(
          withErrorHandler(async (options: { readonly json?: boolean }) => {
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
              handleError(result, "Cannot list VNC hosts");
            }
            if (options.json) {
              console.log(JSON.stringify(result.body));
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
          }),
        ),
    );
}
