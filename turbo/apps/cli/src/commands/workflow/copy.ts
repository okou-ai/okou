import { ApiRequestError } from "../../lib/api/core/client-factory";
import { Command } from "commander";
import chalk from "chalk";
import {
  copyWorkflow,
  getWorkflow,
  listWorkflows,
  listWorkflowAutomations,
} from "../../lib/api/domains/workflows";
import { withErrorHandler } from "../../lib/command/with-error-handler";
import { printWorkflowAutomationsTable } from "./automation/display";
import { resolveWorkflowRef } from "./resolve-workflow-ref";

export const copyCommand = new Command()
  .name("copy")
  .description("Make your private copy in the current workspace")
  .argument("<workflow>", "Workflow ID or name to copy")

  .addHelpText(
    "after",
    `
Examples:
  okou workflow copy tell-a-joke
  okou workflow copy <workflow-id>`,
  )
  .action(
    withErrorHandler(async (workflowRef: string) => {
      const workflowId = await resolveWorkflowRef(workflowRef);
      const existingCopy = async () => {
        const source = await getWorkflow(workflowId);
        return (await listWorkflows()).find((item) => {
          return item.visibility === "private" && item.name === source.name;
        });
      };
      const existing = await existingCopy();
      if (existing) {
        console.log(`Private copy already exists: ${existing.id}`);
        console.log(`Open it: okou workflow view ${existing.id}`);
        return;
      }
      const workflow = await copyWorkflow(workflowId).catch(
        async (error: unknown) => {
          if (error instanceof ApiRequestError && error.status === 409) {
            const existing = await existingCopy();
            if (existing)
              throw new Error(
                `Private copy already exists. Open it: okou workflow view ${existing.id}`,
              );
          }
          throw error;
        },
      );

      console.log(chalk.green(`✓ Workflow "${workflow.name}" copied`));
      console.log();
      console.log(`  ID:           ${workflow.id}`);
      console.log(`  Name:         ${workflow.name}`);
      console.log(`  Visibility:   ${workflow.visibility}`);
      if (workflow.displayName)
        console.log(`  Display Name: ${workflow.displayName}`);
      if (workflow.description)
        console.log(`  Description:  ${workflow.description}`);

      const automations = await listWorkflowAutomations(workflow.id);

      console.log();
      console.log(
        chalk.dim(`── Copied automations (${automations.length}) ──`),
      );
      if (automations.length === 0) {
        console.log(chalk.dim("No automations copied"));
      } else {
        printWorkflowAutomationsTable(automations);
      }
      console.log();
      console.log(`View it: okou workflow view ${workflow.id}`);
    }),
  );
