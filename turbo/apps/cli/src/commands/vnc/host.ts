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
          "List live hosts authorized for this Agent (not a connectivity check)",
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
                "No VNC hosts configured. Ask the owner to configure a host and enable this Agent's VNC access.",
              );
              return;
            }
            for (const host of result.body.hosts) {
              console.log(
                `${host.id}  ${host.displayName}  ${host.host}:${host.port}  ${host.authMethod} / ${host.securityType}`,
              );
            }
            console.log(
              "Use an exact connection ID with okou vnc session start --help; choose shared or exclusive mode explicitly.",
            );
          }),
        ),
    );
}
