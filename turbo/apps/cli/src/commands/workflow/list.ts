import { workspaceExecutorId } from "../../lib/command/workspace-executor";
import { Command } from "commander";
import chalk from "chalk";
import { listWorkflows } from "../../lib/api/domains/workflows";
import { withErrorHandler } from "../../lib/command/with-error-handler";

export const listCommand = new Command()
  .name("list")
  .alias("ls")
  .description("List workspace workflows and private overrides")

  .addHelpText(
    "after",
    `
Examples:
  okou workflow list`,
  )
  .action(
    withErrorHandler(async () => {
      const agentId = await workspaceExecutorId();
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
            "  Create one with: okou workflow create <name> --instruction <text>",
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
      const header = [
        "ID".padEnd(idWidth),
        "NAME".padEnd(nameWidth),
        "VISIBILITY".padEnd(10),
        "SLASH RESOLUTION",
        "DESCRIPTION",
      ].join("  ");
      console.log(chalk.dim(header));

      for (const workflow of workflows) {
        const row = [
          workflow.id.padEnd(idWidth),
          workflow.name.padEnd(nameWidth),
          workflow.visibility.padEnd(10),
          workflow.shadowedBy
            ? `Overridden for you by ${workflow.shadowedBy.id}`
            : `/${workflow.name}`,
          workflow.description ?? "-",
        ].join("  ");
        console.log(row);
      }
    }),
  );
