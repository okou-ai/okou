import { Command } from "commander";

import { runPiSubagentLoop } from "../lib/pi-subagent-loop";
import { reportPiSandboxAgentLoopFailure } from "../lib/pi-agent-loop";

export const subagentLoopCommand = new Command("__subagent_loop__")
  .description("Internal child Pi session loop")
  .argument("<directory>")
  .action(async (directory: string) => {
    try {
      await runPiSubagentLoop(directory);
    } catch (error) {
      reportPiSandboxAgentLoopFailure(error);
    } finally {
      // The child owns no work after session/tool cleanup. SDK transport handles
      // must not keep a completed task alive after its directory has been removed.
      process.exit(process.exitCode ?? 0);
    }
  });
