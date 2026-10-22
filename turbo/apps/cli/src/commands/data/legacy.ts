import { Command } from "commander";

import {
  installPaidToolPolicy,
  markPaidToolForwarder,
} from "../../lib/command/paid-tools";
import { dataCommand } from "./index";

/** Rollout bridge for API prompts issued before the canonical data namespace.
 * Remove after 2026-11-21 (30 days after introduction).
 */
export function createLegacyDataCommand(
  name: string,
  canonicalPath: readonly string[],
): Command {
  const command = new Command(name)
    .description(`Use okou data ${canonicalPath.join(" ")}`)
    .helpOption(false)
    .allowUnknownOption()
    .allowExcessArguments()
    .argument("[arguments...]", "Arguments forwarded to the canonical command")
    .action(async (args: string[]) => {
      installPaidToolPolicy(dataCommand);
      await dataCommand.parseAsync(["node", "okou", ...canonicalPath, ...args]);
    });
  markPaidToolForwarder(command);
  return command;
}
