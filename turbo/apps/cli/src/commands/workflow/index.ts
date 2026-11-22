import { publishCommand, unpublishCommand } from "./visibility";
import { Command } from "commander";
import { createCommand } from "./create";
import { editCommand } from "./edit";
import { viewCommand } from "./view";
import { listCommand } from "./list";
import { deleteCommand } from "./delete";
import { copyCommand } from "./copy";
import { automationCommand } from "./automation";

export const workflowCommand = new Command("workflow")
  .description("Manage workspace workflows")
  .addCommand(createCommand)
  .addCommand(editCommand)
  .addCommand(viewCommand)
  .addCommand(listCommand)
  .addCommand(deleteCommand)
  .addCommand(copyCommand)
  .addCommand(publishCommand)
  .addCommand(unpublishCommand)

  .addCommand(automationCommand)
  .addHelpText(
    "after",
    `
Examples:
  Create a workflow:   okou workflow create my-workflow --instruction "Do things"
  List workflows:          okou workflow list
  View workflow content:   okou workflow view <workflow>
  Update workflow content: okou workflow edit <workflow> --instruction "New steps"
  Make a private copy: okou workflow copy <workflow>
  Manage automations:      okou workflow automation --help
  Delete a workflow:       okou workflow delete <workflow> -y

Persistence:
  create and edit persist a durable workflow through the API. Supply the workflow
  body with --instruction or --instruction-file; SKILL.md is synthesized from
  the name, description, and instruction. --dir uploads supplementary files only
  and rejects a SKILL.md. Editing or creating folders under
  /home/user/.codex/skills or /home/user/.claude/skills changes only this runtime
  and will not persist or sync back.

Automations:
  Use workflow automation commands for schedules, monitoring, reminders, and
  event triggers. /loop, CronCreate/CronList/CronDelete, and ScheduleWakeup are
  not available alternatives.`,
  );
