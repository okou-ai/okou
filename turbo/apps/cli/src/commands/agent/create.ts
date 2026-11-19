import type { AgentVisibility } from "@okouai/api-contracts/contracts/agents";
import { Command, Option } from "commander";
import { readFileSync } from "node:fs";
import chalk from "chalk";
import {
  createAgent,
  updateAgentInstructions,
} from "../../lib/api/domains/agents";
import { withErrorHandler } from "../../lib/command/with-error-handler";
import { resolveAvatarUrl } from "./avatar";
import { parseAgentVisibility } from "./visibility";

export const createCommand = new Command()
  .name("create")
  .description("Create a new agent")
  .option("--display-name <name>", "Agent display name")
  .option("--description <text>", "Agent description")
  .option(
    "--sound <tone>",
    "Agent tone: professional, friendly, direct, supportive",
  )
  .addOption(
    new Option(
      "--visibility <visibility>",
      "Agent visibility: private or public",
    )
      .default("private" satisfies AgentVisibility)
      .argParser(parseAgentVisibility),
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
  .option("--instructions-file <path>", "Path to instructions file")
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

  Custom attributes (--avatar-* flags, omitted fields use defaults):
    --avatar-rotation    1=far-left  3=center(default)  5=far-right
    --avatar-skin        light / light-medium / medium(default) / medium-dark / dark
    --avatar-hair-style  1–5 (default: 1)
    --avatar-hair-color  blonde / teal / grey / pink / brown(default)
    --avatar-expression  calm(default) / content / neutral / pleasant / excited
    --avatar-intensity   chill / normal(default) / hyped

  Note: --avatar and --avatar-* cannot be used together.

Examples:
  Minimal:               okou agent create --display-name "My Agent"
  Public agent:          okou agent create --display-name "My Agent" --visibility public
  Quick preset:          okou agent create --display-name "My Agent" --avatar preset:2
  Custom avatar:         okou agent create --display-name "My Agent" --avatar-skin dark --avatar-hair-color teal --avatar-intensity hyped
  With instructions:     okou agent create --display-name "My Agent" --instructions-file ./instructions.md`,
  )
  .action(
    withErrorHandler(
      async (options: {
        displayName?: string;
        description?: string;
        sound?: string;
        visibility: AgentVisibility;
        avatar?: string;
        avatarRotation?: string;
        avatarSkin?: string;
        avatarHairStyle?: string;
        avatarHairColor?: string;
        avatarExpression?: string;
        avatarIntensity?: string;
        instructionsFile?: string;
      }) => {
        const avatarUrl = resolveAvatarUrl(options);

        const agent = await createAgent({
          displayName: options.displayName,
          description: options.description,
          sound: options.sound,
          visibility: options.visibility,
          avatarUrl,
        });

        if (options.instructionsFile) {
          const content = readFileSync(options.instructionsFile, "utf-8");
          await updateAgentInstructions(agent.agentId, content);
        }

        console.log(chalk.green(`✓ Agent "${agent.agentId}" created`));
        console.log(`  Agent ID:     ${agent.agentId}`);
        if (agent.displayName) {
          console.log(`  Display Name: ${agent.displayName}`);
        }
        console.log(`  Visibility:   ${agent.visibility}`);

        console.log();
        console.log("Find and inspect connectors with these commands.");
        console.log("  okou connector search <keyword>");
        console.log("  okou connector status <slug>");
        console.log(
          "Manage which saved accounts a Chat can use in Chat settings.",
        );
      },
    ),
  );
