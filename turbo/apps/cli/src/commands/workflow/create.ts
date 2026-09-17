import { Command } from "commander";
import chalk from "chalk";
import { readFileSync } from "node:fs";
import { createWorkflow } from "../../lib/api/domains/workflows";
import { withErrorHandler } from "../../lib/command/with-error-handler";
import { readSupplementaryFiles } from "../../lib/skill-directory";
import { getOkouAgentId, getOkouChatThreadId } from "../../lib/okou-env";
import { formatWorkflowAgentName } from "./format";

export const createCommand = new Command()
  .name("create")
  .description("Create a workflow under an agent")
  .argument("<name>", "Workflow name (lowercase alphanumeric with hyphens)")
  .option(
    "--agent <id>",
    "Agent ID to host the workflow (defaults to OKOU_AGENT_ID)",
  )
  .option("--instruction <text>", "Workflow instruction text")
  .option(
    "--instruction-file <path>",
    "Path to a file containing the instruction",
  )
  .option(
    "--dir <path>",
    "Path to a directory of supplementary files (SKILL.md is not allowed)",
  )
  .option("--display-name <name>", "Workflow display name")
  .option("--description <text>", "Workflow description")
  .option("--public", "Create as an org-public workflow")
  .addHelpText(
    "after",
    `
Examples:
  okou workflow create my-workflow --agent <agent-id> --instruction "Summarize the inbox"
  okou workflow create my-workflow --instruction-file ./instruction.md
  okou workflow create my-workflow --instruction "Do things" --dir ./workflows/my-workflow/files/
  okou workflow create shared-workflow --instruction "Shared logic" --public

Notes:
  - A workflow belongs to exactly one agent; provide --agent or set OKOU_AGENT_ID
  - SKILL.md is synthesized from (name, description, instruction); do not include it
  - --dir uploads supplementary files only; any SKILL.md is rejected
  - This command persists the workflow through the API. Local /home/user/.codex/skills or /home/user/.claude/skills folders are runtime-only and will not sync back
  - New workflows are private by default
  - Copy a workflow onto another agent: okou workflow copy <workflow-id> --to-agent <agent-id>`,
  )
  .action(
    withErrorHandler(
      async (
        name: string,
        options: {
          agent?: string;
          instruction?: string;
          instructionFile?: string;
          dir?: string;
          displayName?: string;
          description?: string;
          public?: boolean;
        },
      ) => {
        const agentId = options.agent ?? getOkouAgentId();
        if (!agentId) {
          console.error(chalk.red("✗ --agent is required"));
          console.error(
            chalk.dim(
              "  Provide --agent <agent-id> or run inside an agent sandbox (OKOU_AGENT_ID)",
            ),
          );
          process.exit(1);
        }

        if (options.instruction && options.instructionFile) {
          console.error(
            chalk.red("✗ Use either --instruction or --instruction-file"),
          );
          console.error(chalk.dim("  Provide only one instruction source"));
          process.exit(1);
        }

        const instruction = options.instructionFile
          ? readFileSync(options.instructionFile, "utf-8")
          : options.instruction;

        const files = options.dir
          ? readSupplementaryFiles(options.dir)
          : undefined;

        const workflow = await createWorkflow({
          agentId,
          chatThreadId: getOkouChatThreadId(),
          name,
          instruction,
          files,
          displayName: options.displayName,
          description: options.description,
          visibility: options.public ? "public" : undefined,
        });

        console.log(chalk.green(`✓ Workflow "${workflow.name}" created`));
        console.log(`  ID:           ${workflow.id}`);
        console.log(`  Name:         ${workflow.name}`);
        console.log(`  Agent Name:   ${formatWorkflowAgentName(workflow)}`);
        console.log(`  Agent ID:     ${workflow.agentId}`);
        console.log(`  Visibility:   ${workflow.visibility}`);
        if (files) {
          console.log(`  Files:        ${files.length} file(s)`);
        }
        if (workflow.displayName) {
          console.log(`  Display Name: ${workflow.displayName}`);
        }
        if (workflow.description) {
          console.log(`  Description:  ${workflow.description}`);
        }
        console.log();
        console.log(
          `Copy onto another agent: okou workflow copy ${workflow.id} --to-agent <agent-id>`,
        );
      },
    ),
  );
