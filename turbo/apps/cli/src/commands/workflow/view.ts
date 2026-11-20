import { Command } from "commander";
import chalk from "chalk";
import { getWorkflow } from "../../lib/api/domains/workflows";
import { withErrorHandler } from "../../lib/command/with-error-handler";
import { resolveWorkflowRef } from "./resolve-workflow-ref";

export const viewCommand = new Command()
  .name("view")
  .description("View a workflow")
  .argument("<workflow>", "Workflow ID or name")

  .addHelpText(
    "after",
    `
Examples:
  okou workflow view tell-a-joke
  okou workflow view <workflow-id>`,
  )
  .action(
    withErrorHandler(async (workflowRef: string) => {
      const workflowId = await resolveWorkflowRef(workflowRef);
      const workflow = await getWorkflow(workflowId);

      console.log(chalk.bold(workflow.name));
      if (workflow.displayName) console.log(chalk.dim(workflow.displayName));
      console.log();
      console.log(`ID:           ${workflow.id}`);
      console.log(`Name:         ${workflow.name}`);
      console.log(`Visibility:   ${workflow.visibility}`);
      if (workflow.shadowedBy)
        console.log(
          `/${workflow.name}: overridden for you by ${workflow.shadowedBy.id}`,
        );
      if (workflow.displayName)
        console.log(`Display Name: ${workflow.displayName}`);
      if (workflow.description)
        console.log(`Description:  ${workflow.description}`);

      if (workflow.files && workflow.files.length > 0) {
        console.log();
        console.log(chalk.dim("── Files ──"));
        for (const f of workflow.files) {
          console.log(`  ${f.path} (${f.size} bytes)`);
        }
      }

      console.log();
      if (workflow.instruction) {
        console.log(chalk.dim("── Instruction ──"));
        console.log(workflow.instruction);
      } else {
        console.log(chalk.dim("No instruction"));
      }
    }),
  );
