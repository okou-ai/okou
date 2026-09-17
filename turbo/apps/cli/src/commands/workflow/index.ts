import { Command } from "commander";
import { createCommand } from "./create";
import { editCommand } from "./edit";
import { viewCommand } from "./view";
import { listCommand } from "./list";
import { deleteCommand } from "./delete";
import { copyCommand } from "./copy";
import { automationCommand } from "./automation";

export const workflowCommand = new Command("workflow")
  .description("Manage workflows")
  .addCommand(createCommand)
  .addCommand(editCommand)
  .addCommand(viewCommand)
  .addCommand(listCommand)
  .addCommand(deleteCommand)
  .addCommand(copyCommand)
  .addCommand(automationCommand)
  .addHelpText(
    "after",
    `
Examples:
  Create under an agent:   okou workflow create my-workflow --agent <agent-id> --instruction "Do things"
  List workflows:          okou workflow list
  View workflow content:   okou workflow view <workflow> --agent <agent-id>
  Update workflow content: okou workflow edit <workflow> --agent <agent-id> --instruction "New steps"
  Copy onto another agent: okou workflow copy <workflow> --agent <source-agent-id> --to-agent <target-agent-id>
  Manage automations:      okou workflow automation --help
  Delete a workflow:       okou workflow delete <workflow> --agent <agent-id> -y

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
