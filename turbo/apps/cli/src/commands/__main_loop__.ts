import { Command } from "commander";

import {
  piSandboxAgentConfigFromEnv,
  runPiSandboxAgentLoop,
  reportPiSandboxAgentLoopFailure,
} from "../lib/pi-agent-loop";
import { requirePiMainLoopEnvironment } from "../lib/pi-session-env";

export const mainLoopCommand = new Command("__main_loop__")
  .description("Internal sandbox Pi main loop")
  .action(async () => {
    try {
      requirePiMainLoopEnvironment();
      await runPiSandboxAgentLoop({
        config: await piSandboxAgentConfigFromEnv(),
      });
    } catch (error) {
      reportPiSandboxAgentLoopFailure(error);
    }
  });
