import { workflowHelp, workflowAgentScope } from "./mode";
import { singleAgentEnabled } from "../../lib/api/single-agent";
import { Command } from "commander";
import chalk from "chalk";
import { listWorkflows } from "../../lib/api/domains/workflows";
import { withErrorHandler } from "../../lib/command/with-error-handler";
import { formatWorkflowAgentName } from "./format";

export const listCommand = new Command()
  .name("list")
  .alias("ls")
  .description("List visible workflows, optionally scoped to one agent")
  .option("--agent <id>", "Only list workflows hosted by this agent")
  .addHelpText("after", () => {
    return workflowHelp(`
Examples:
  okou workflow list
  okou workflow list --agent <agent-id>`);
  })
  .action(
    withErrorHandler(async (options: { agent?: string }) => {
      const singleAgent = await singleAgentEnabled();
      const agentId = await workflowAgentScope(options.agent);
      // Official Workflows are system-managed and never listed as user Workflows.
      const workflows = (await listWorkflows({ agentId })).filter(
        (workflow) => {
          return !workflow.official;
        },
      );

      if (workflows.length === 0) {
        console.log(chalk.dim("No workflows found"));
        console.log(
          chalk.dim(
            singleAgent
              ? "  Create one with: okou workflow create <name> --instruction <text>"
              : "  Create one with: okou workflow create <name> --agent <agent-id> --instruction <text>",
          ),
        );
        return;
      }

      const idWidth = Math.max(
        2,
        ...workflows.map((s) => {
          return s.id.length;
        }),
      );
      const nameWidth = Math.max(
        4,
        ...workflows.map((s) => {
          return s.name.length;
        }),
      );
      const agentWidth = Math.max(
        10,
        ...workflows.map((s) => {
          return formatWorkflowAgentName(s).length;
        }),
      );
      const agentIdWidth = Math.max(
        8,
        ...workflows.map((s) => {
          return s.agentId.length;
        }),
      );

      const header = [
        "ID".padEnd(idWidth),
        "NAME".padEnd(nameWidth),
        "VISIBILITY".padEnd(10),
        ...(singleAgent
          ? ["SLASH RESOLUTION"]
          : ["AGENT NAME".padEnd(agentWidth), "AGENT ID".padEnd(agentIdWidth)]),
        "DESCRIPTION",
      ].join("  ");
      console.log(chalk.dim(header));

      for (const workflow of workflows) {
        const row = [
          workflow.id.padEnd(idWidth),
          workflow.name.padEnd(nameWidth),
          workflow.visibility.padEnd(10),
          ...(singleAgent
            ? [
                workflow.shadowedBy
                  ? `Overridden for you by ${workflow.shadowedBy.id}`
                  : `/${workflow.name}`,
              ]
            : [
                formatWorkflowAgentName(workflow).padEnd(agentWidth),
                workflow.agentId.padEnd(agentIdWidth),
              ]),
          workflow.description ?? "-",
        ].join("  ");
        console.log(row);
      }
    }),
  );
