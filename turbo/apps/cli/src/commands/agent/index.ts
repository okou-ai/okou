import { Command } from "commander";
import { createCommand } from "./create";
import { editCommand } from "./edit";
import { viewCommand } from "./view";
import { listCommand } from "./list";
import { deleteCommand } from "./delete";

export const agentCommand = new Command("agent")
  .description("View or manage agents")
  .addCommand(createCommand)
  .addCommand(editCommand)
  .addCommand(viewCommand)
  .addCommand(listCommand)
  .addCommand(deleteCommand)
  .addHelpText(
    "after",
    `
Examples:
  Your agent ID is in $OKOU_AGENT_ID (or run: okou whoami)
  View your config:      okou agent view $OKOU_AGENT_ID --instructions
  Update description:    okou agent edit <custom-agent-id> --description "new role"
  Update tone:           okou agent edit <custom-agent-id> --sound friendly
  Update instructions:   okou agent edit <custom-agent-id> --instructions-file <path>
  Attach a workflow:     okou workflow attach <name> --agent $OKOU_AGENT_ID

Notes:
  The workspace default Okou agent is read-only
  Manage workflows with 'okou workflow --help'`,
  );
