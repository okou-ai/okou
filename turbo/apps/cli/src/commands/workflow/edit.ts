import { Command } from "commander";
import chalk from "chalk";
import { readFileSync } from "node:fs";
import { updateWorkflow } from "../../lib/api/domains/workflows";
import { withErrorHandler } from "../../lib/command/with-error-handler";
import { readSupplementaryFiles } from "../../lib/skill-directory";
import {
  resolveWorkflowRef,
  type WorkflowRefOptions,
} from "./resolve-workflow-ref";

export const editCommand = new Command()
  .name("edit")
  .description("Update a workflow's instruction, files, or metadata")
  .argument("<workflow>", "Workflow ID or name")
  .option("--agent <id>", "Agent ID for resolving workflow names")
  .option("--instruction <text>", "New instruction text")
  .option(
    "--instruction-file <path>",
    "Path to a file containing the instruction",
  )
  .option(
    "--dir <path>",
    "Path to a directory of supplementary files (SKILL.md is not allowed)",
  )
  .option("--display-name <name>", "New display name")
  .option("--description <text>", "New description")
  .addHelpText(
    "after",
    `
Examples:
  okou workflow edit tell-a-joke --agent <agent-id> --instruction "New steps"
  okou workflow edit <workflow-id> --instruction "New steps"
  okou workflow edit <workflow-id> --instruction-file ./instruction.md
  okou workflow edit <workflow-id> --dir ./workflows/my-workflow/files/
  okou workflow edit <workflow-id> --display-name "My Workflow" --description "Does things"

Notes:
  - SKILL.md is synthesized automatically; --dir uploads supplementary files only and rejects SKILL.md
  - This command persists the update through the API. Editing /home/user/.codex/skills or /home/user/.claude/skills is runtime-only and will not sync back
  - At least one of --instruction, --instruction-file, --dir, --display-name, or --description is required`,
  )
  .action(
    withErrorHandler(
      async (
        workflowRef: string,
        options: {
          instruction?: string;
          instructionFile?: string;
          dir?: string;
          displayName?: string;
          description?: string;
        } & WorkflowRefOptions,
      ) => {
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

        if (
          instruction === undefined &&
          files === undefined &&
          options.displayName === undefined &&
          options.description === undefined
        ) {
          console.error(chalk.red("✗ Nothing to update"));
          console.error(
            chalk.dim(
              "  Provide --instruction, --instruction-file, --dir, --display-name, or --description",
            ),
          );
          process.exit(1);
        }

        const workflowId = await resolveWorkflowRef(workflowRef, options);
        const workflow = await updateWorkflow(workflowId, {
          instruction,
          files,
          displayName: options.displayName,
          description: options.description,
        });

        console.log(chalk.green(`✓ Workflow "${workflow.name}" updated`));
        if (instruction !== undefined) {
          console.log(`  Instruction:  updated`);
        }
        if (files) {
          console.log(`  Files:        ${files.length} file(s)`);
        }
        if (options.displayName !== undefined) {
          console.log(`  Display Name: ${workflow.displayName ?? "-"}`);
        }
        if (options.description !== undefined) {
          console.log(`  Description:  ${workflow.description ?? "-"}`);
        }
      },
    ),
  );
