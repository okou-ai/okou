import { Command } from "commander";

import {
  installPaidToolPolicy,
  markPaidToolForwarder,
} from "../../lib/command/paid-tools";
import { dataCommand } from "./index";

/** Rollout bridge for historical API prompts and durable recovery commands.
 * Keep aliases until canonical CLI readers are deployed, live/captured/durable
 * callers are accounted for, old Runner/Run owners have drained, and supported
 * rollback writers cannot reintroduce unsupported callers. The owning PR must
 * record evidence for every gate and a real removal follow-up before cleanup;
 * no gate is established by a calendar date alone.
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
