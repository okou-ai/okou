import type { AgentVisibility } from "@okouai/api-contracts/contracts/agents";
import { agentIdentityUpdateError } from "@okouai/core/agent-protection";
import { Command, Option } from "commander";
import { readFileSync } from "node:fs";
import chalk from "chalk";
import {
  getAgent,
  updateAgent,
  updateAgentInstructions,
} from "../../lib/api/domains/agents";
import { withErrorHandler } from "../../lib/command/with-error-handler";
import { type AvatarOptions, resolveAvatarUrl } from "./avatar";
import { parseAgentVisibility } from "./visibility";

interface AgentEditOptions extends AvatarOptions {
  displayName?: string;
  description?: string;
  sound?: string;
  visibility?: AgentVisibility;
  instructionsFile?: string;
}

function hasAvatarUpdate(options: AvatarOptions): boolean {
  return (
    options.avatar !== undefined ||
    options.avatarRotation !== undefined ||
    options.avatarSkin !== undefined ||
    options.avatarHairStyle !== undefined ||
    options.avatarHairColor !== undefined ||
    options.avatarExpression !== undefined ||
    options.avatarIntensity !== undefined
  );
}

function hasAgentFieldUpdate(options: AgentEditOptions): boolean {
  return (
    options.displayName !== undefined ||
    options.description !== undefined ||
    options.sound !== undefined ||
    options.visibility !== undefined ||
    hasAvatarUpdate(options)
  );
}

export const editCommand = new Command()
  .name("edit")
  .description("Edit an agent")
  .argument("<agent-id>", "Agent ID")
  .option("--display-name <name>", "New display name")
  .option("--description <text>", "New description")
  .option(
    "--sound <tone>",
    "New tone: professional, friendly, direct, supportive",
  )
  .addOption(
    new Option(
      "--visibility <visibility>",
      "New visibility: private or public",
    ).argParser(parseAgentVisibility),
  )
  .option("--avatar <preset>", "Avatar preset: preset:0 through preset:4")
  .option(
    "--avatar-rotation <1-5>",
    "Head angle: 1=far-left  3=center  5=far-right",
  )
  .option(
    "--avatar-skin <tone>",
    "Skin tone: light | light-medium | medium | medium-dark | dark",
  )
  .option("--avatar-hair-style <1-5>", "Hair style: 1–5")
  .option(
    "--avatar-hair-color <color>",
    "Hair color: blonde | teal | grey | pink | brown",
  )
  .option(
    "--avatar-expression <expr>",
    "Expression: calm | content | neutral | pleasant | excited",
  )
  .option("--avatar-intensity <level>", "Intensity: chill | normal | hyped")
  .option("--instructions-file <path>", "Path to new instructions file")
  .addHelpText(
    "after",
    `
Avatar:
  Quick presets (--avatar):
    preset:0  light skin, brown hair, calm, hyped
    preset:1  light-medium skin, grey hair, calm, normal
    preset:2  medium skin, pink hair, neutral, chill
    preset:3  medium-dark skin, blonde hair, pleasant, hyped
    preset:4  dark skin, teal hair, excited, normal

  Custom attributes (--avatar-* flags, replace the entire avatar):
    --avatar-rotation    1=far-left  3=center(default)  5=far-right
    --avatar-skin        light / light-medium / medium(default) / medium-dark / dark
    --avatar-hair-style  1–5 (default: 1)
    --avatar-hair-color  blonde / teal / grey / pink / brown(default)
    --avatar-expression  calm(default) / content / neutral / pleasant / excited
    --avatar-intensity   chill / normal(default) / hyped

  Note: --avatar and --avatar-* cannot be used together.

Examples:
  Update description:      okou agent edit <agent-id> --description "new role"
  Update tone:             okou agent edit <agent-id> --sound friendly
  Make public:             okou agent edit <agent-id> --visibility public
  Quick preset avatar:     okou agent edit <agent-id> --avatar preset:2
  Custom avatar:           okou agent edit <agent-id> --avatar-skin dark --avatar-hair-color teal --avatar-intensity hyped
  Update instructions:     okou agent edit <agent-id> --instructions-file ./instructions.md
  Update yourself:         okou agent edit $OKOU_AGENT_ID --description "new role"

Notes:
  - The workspace default Okou agent's name, avatar, and Public visibility are fixed
  - Its description, tone, and instructions can be edited with the usual owner/admin permissions
  - At least one option is required
  - Unspecified fields are preserved (not cleared)
  - To attach workflows to agents, use: okou workflow attach --help`,
  )
  .action(
    withErrorHandler(async (agentId: string, options: AgentEditOptions) => {
      const hasAgentUpdate = hasAgentFieldUpdate(options);

      if (!hasAgentUpdate && !options.instructionsFile) {
        throw new Error(
          "At least one option is required (--display-name, --description, --sound, --visibility, --avatar, --avatar-*, --instructions-file)",
        );
      }

      const avatarUrl = hasAvatarUpdate(options)
        ? resolveAvatarUrl(options)
        : undefined;
      if (hasAgentUpdate) {
        const update = {
          displayName: options.displayName,
          description: options.description,
          sound: options.sound,
          visibility: options.visibility,
          avatarUrl,
        };
        const current = await getAgent(agentId);
        const identityError = agentIdentityUpdateError(
          current.isDefaultAgent,
          update,
        );
        if (identityError) {
          throw new Error(identityError.message);
        }
        await updateAgent(agentId, update);
      }

      if (options.instructionsFile) {
        const content = readFileSync(options.instructionsFile, "utf-8");
        await updateAgentInstructions(agentId, content);
      }

      console.log(chalk.green(`✓ Agent "${agentId}" updated`));
    }),
  );
