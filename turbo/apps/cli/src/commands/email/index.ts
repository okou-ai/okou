import { Command } from "commander";
import { createEmailUploadFileCommand } from "./upload-file";
import {
  getEmailBinding,
  logoutEmail,
  switchEmailWorkspace,
} from "../../lib/api/domains/integrations-email";
import { withErrorHandler } from "../../lib/command/with-error-handler";

export function createEmailCommand() {
  return new Command("email")
    .description(
      "Manage the current Email sender's workspace and deliver files",
    )
    .addCommand(
      new Command("status")
        .description(
          "Show the current Email sender's workspace and available workspaces",
        )
        .option("--json", "Print the binding and workspace list as JSON")
        .action(
          withErrorHandler(async (options: { readonly json?: boolean }) => {
            const result = await getEmailBinding();
            if (options.json) {
              console.log(JSON.stringify(result, null, 2));
              return;
            }
            console.log(`Email: ${result.emailAddress}`);
            console.log(
              `Workspace: ${result.workspace.name} (${result.workspace.id})`,
            );
            console.log("Available workspaces:");
            for (const workspace of result.workspaces) {
              console.log(`  ${workspace.name} (${workspace.id})`);
            }
            console.log(
              "Switch with okou email switch --workspace-id <id>; disconnect with okou email logout.",
            );
          }),
        ),
    )
    .addCommand(
      new Command("switch")
        .description(
          "Bind the current Email sender to another workspace you belong to",
        )
        .requiredOption(
          "--workspace-id <id>",
          "Workspace ID from okou email status",
        )
        .option("--json", "Print the new binding as JSON")
        .addHelpText(
          "after",
          "\nOnly future emails use the new workspace. Existing chats stay in their original workspace. The server queues a confirmation email; end this turn after success.",
        )
        .action(
          withErrorHandler(
            async (options: {
              readonly workspaceId: string;
              readonly json?: boolean;
            }) => {
              const result = await switchEmailWorkspace(options.workspaceId);
              if (options.json) {
                console.log(JSON.stringify(result, null, 2));
                return;
              }
              console.log(
                `${result.emailAddress} is connected to ${result.workspace.name} (${result.workspace.id}).`,
              );
              console.log(
                "Future emails use this workspace. End this turn; the server queues the confirmation email.",
              );
            },
          ),
        ),
    )
    .addCommand(
      new Command("logout")
        .description("Disconnect the current Email sender from Okou")
        .option("--json", "Print the disconnected email address as JSON")
        .addHelpText(
          "after",
          "\nDisconnects only this sender's Email integration, including a login email. Your Okou account and Gmail/Outlook connectors stay connected. Reconnect explicitly from App Works. The server queues a confirmation email; end this turn after success.",
        )
        .action(
          withErrorHandler(async (options: { readonly json?: boolean }) => {
            const result = await logoutEmail();
            if (options.json) {
              console.log(JSON.stringify(result, null, 2));
              return;
            }
            console.log(
              `${result.emailAddress} is disconnected from Email. Reconnect from App Works.`,
            );
            console.log(
              "End this turn; the server queues the confirmation email.",
            );
          }),
        ),
    )
    .addHelpText(
      "after",
      "\nBinding commands require the current Email-originated run and email:write. They always target its verified sender, never an address supplied in the email body.",
    )
    .addCommand(createEmailUploadFileCommand());
}
