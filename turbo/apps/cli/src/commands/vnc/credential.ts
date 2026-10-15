import { randomUUID } from "node:crypto";
import { Command } from "commander";
import { vncCredentialsContract } from "@okouai/api-contracts/contracts/vnc-credentials";
import {
  createVncCredential,
  deleteVncCredential,
  listVncCredentials,
  updateVncCredential,
} from "../../lib/api/domains/vnc-management";
import { withErrorHandler } from "../../lib/command/with-error-handler";
import {
  managementId,
  managementWriteCommand,
  outputManagement,
  requireVncManagementCapability,
  type ManagementOptions,
} from "./management";

export function createVncCredentialCommand(): Command {
  const command = new Command("credential").description(
    "Manage owned reusable VNC credentials without displaying credential values",
  );
  command.addCommand(
    new Command("list")
      .description("List owned VNC credential metadata")
      .option("--json", "Print safe metadata JSON")
      .action(
        withErrorHandler(async (options: ManagementOptions) => {
          requireVncManagementCapability("connector:read");
          outputManagement(
            await listVncCredentials(),
            options,
            "Use okou vnc credential show <id>; create credentials with okou vnc credential create --input <file|->.",
          );
        }),
      ),
  );
  command.addCommand(
    new Command("show")
      .description("Show safe metadata for an exact owned credential UUID")
      .argument("<id>", "Exact UUID from vnc credential list")
      .option("--json", "Print safe metadata JSON")
      .action(
        withErrorHandler(async (id: string, options: ManagementOptions) => {
          requireVncManagementCapability("connector:read");
          const credentialId = managementId(id);
          const credential = (await listVncCredentials()).credentials.find(
            (item) => {
              return item.id === credentialId;
            },
          );
          if (!credential)
            throw new Error(
              "VNC credential unavailable. Refresh okou vnc credential list --json.",
            );
          outputManagement(
            credential,
            options,
            "Include expectedRevision in update/delete input. Credential values cannot be retrieved.",
          );
        }),
      ),
  );
  command.addCommand(
    managementWriteCommand(
      "create",
      "credential",
      vncCredentialsContract.create.body.extend({
        id: vncCredentialsContract.create.body.shape.id.default(randomUUID),
      }),
      async (body) => {
        return createVncCredential(body);
      },
    ),
  );
  command.addCommand(
    managementWriteCommand(
      "update",
      "credential",
      vncCredentialsContract.update.body,
      async (body, id) => {
        return updateVncCredential(managementId(id ?? ""), body);
      },
    ),
  );
  command.addCommand(
    managementWriteCommand(
      "delete",
      "credential",
      vncCredentialsContract.delete.body,
      async (body, id) => {
        return deleteVncCredential(managementId(id ?? ""), body);
      },
    ),
  );
  return command;
}
