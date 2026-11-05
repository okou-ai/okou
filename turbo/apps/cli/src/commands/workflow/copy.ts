import { workflowHelp, workspaceWorkflowAgentId } from "./mode";
import { singleAgentEnabled } from "../../lib/api/single-agent";
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
import { formatWorkflowAgentName } from "./format";
import {
  resolveWorkflowRef,
  type WorkflowRefOptions,
} from "./resolve-workflow-ref";

export const copyCommand = new Command()
  .name("copy")
  .description("Copy (fork) a workflow onto another agent")
  .argument("<workflow>", "Workflow ID or name to copy")
  .option("--agent <id>", "Agent ID for resolving workflow names")
  .requiredOption("--to-agent <agent-id>", "Target agent ID")
  .addHelpText("after", () => {
    return workflowHelp(`
Examples:
  okou workflow copy tell-a-joke --agent <source-agent-id> --to-agent <target-agent-id>
  okou workflow copy <workflow-id> --to-agent <target-agent-id>`);
  })
  .action(
    withErrorHandler(
      async (
        workflowRef: string,
        options: { toAgent?: string } & WorkflowRefOptions,
      ) => {
        const singleAgent = await singleAgentEnabled();
        if (singleAgent && options.toAgent)
          throw new Error(
            "Use workflow copy <workflow> to make your private copy in this workspace",
          );
        const targetAgentId = singleAgent
          ? await workspaceWorkflowAgentId()
          : options.toAgent;
        if (!targetAgentId)
          throw new Error("--to-agent <agent-id> is required");
        const workflowId = await resolveWorkflowRef(workflowRef, options);
        const existingCopy = async () => {
          const source = await getWorkflow(workflowId);
          return (await listWorkflows({ agentId: targetAgentId })).find(
            (item) => {
              return (
                item.visibility === "private" &&
                !item.official &&
                item.name === source.name
              );
            },
          );
        };
        if (singleAgent) {
          const existing = await existingCopy();
          if (existing) {
            console.log(`Private copy already exists: ${existing.id}`);
            console.log(`Open it: okou workflow view ${existing.id}`);
            return;
          }
        }
        const workflow = await copyWorkflow(workflowId, targetAgentId).catch(
          async (error: unknown) => {
            if (
              singleAgent &&
              error instanceof ApiRequestError &&
              error.status === 409
            ) {
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
        if (!singleAgent) {
          console.log(`  Agent Name:   ${formatWorkflowAgentName(workflow)}`);
          console.log(`  Agent ID:     ${workflow.agentId}`);
        }
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
      },
    ),
  );
