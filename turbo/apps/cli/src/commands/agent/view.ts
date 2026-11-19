import { Command } from "commander";
import chalk from "chalk";
import { getAgent, getAgentInstructions } from "../../lib/api/domains/agents";
import { withErrorHandler } from "../../lib/command/with-error-handler";
import { formatAvatar } from "./avatar";
export const viewCommand = new Command()
  .name("view")
  .description("View an agent")
  .argument("<agent-id>", "Agent ID")
  .option("--instructions", "Also show instructions content")
  .addHelpText(
    "after",
    `
Examples:
  View basic info:         okou agent view <agent-id>
  Include instructions:    okou agent view <agent-id> --instructions
  View yourself:           okou agent view $OKOU_AGENT_ID --instructions`,
  )
  .action(
    withErrorHandler(
      async (agentId: string, options: { instructions?: boolean }) => {
        const agent = await getAgent(agentId);

        console.log(chalk.bold(agent.agentId));
        if (agent.displayName) console.log(chalk.dim(agent.displayName));
        console.log();
        console.log(`Agent ID:     ${agent.agentId}`);
        console.log(`Visibility:   ${agent.visibility}`);

        if (agent.description)
          console.log(`Description:  ${agent.description}`);
        if (agent.sound) console.log(`Sound:        ${agent.sound}`);
        const avatar = formatAvatar(agent.avatarUrl);
        if (avatar) console.log(`Avatar:       ${avatar}`);

        if (options.instructions) {
          console.log();
          const result = await getAgentInstructions(agentId);
          if (result.content) {
            console.log(chalk.dim("── Instructions ──"));
            console.log(result.content);
          } else {
            console.log(chalk.dim("No instructions set"));
          }
        }
      },
    ),
  );
