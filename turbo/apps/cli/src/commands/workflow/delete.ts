import { workflowHelp } from "./mode";
import { Command } from "commander";
import chalk from "chalk";
import { deleteWorkflow, getWorkflow } from "../../lib/api/domains/workflows";
import { isInteractive, promptConfirm } from "../../lib/utils/prompt-utils";
import { withErrorHandler } from "../../lib/command/with-error-handler";
import {
  resolveWorkflowRef,
  type WorkflowRefOptions,
} from "./resolve-workflow-ref";

export const deleteCommand = new Command()
  .name("delete")
  .alias("rm")
  .description("Delete a workflow")
  .argument("<workflow>", "Workflow ID or name")
  .option("--agent <id>", "Agent ID for resolving workflow names")
  .option("-y, --yes", "Skip confirmation prompt")
  .addHelpText("after", () => {
    return workflowHelp(`
Examples:
  okou workflow delete tell-a-joke --agent <agent-id> -y
  okou workflow delete <workflow-id>
  okou workflow delete <workflow-id> -y

Notes:
  - Use -y to skip confirmation in non-interactive mode`);
  })
  .action(
    withErrorHandler(
      async (
        workflowRef: string,
        options: { yes?: boolean } & WorkflowRefOptions,
      ) => {
        const workflowId = await resolveWorkflowRef(workflowRef, options);
        const workflow = await getWorkflow(workflowId);

        if (!options.yes) {
          if (!isInteractive()) {
            throw new Error("--yes flag is required in non-interactive mode");
          }
          const confirmed = await promptConfirm(
            `Delete workflow '${workflow.name}'?`,
            false,
          );
          if (!confirmed) {
            console.log(chalk.dim("Cancelled"));
            return;
          }
        }

        await deleteWorkflow(workflowId);
        console.log(chalk.green(`✓ Workflow "${workflow.name}" deleted`));
      },
    ),
  );
