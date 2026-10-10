import { Command } from "commander";

import {
  piSandboxAgentConfigFromEnv,
  runPiSandboxAgentLoop,
  reportPiSandboxAgentLoopFailure,
} from "../lib/pi-agent-loop";

import { requirePiMainLoopEnvironment } from "../lib/pi-session-env";

// Retained for queued Runs whose captured CLI/Runner still uses the old entry.
export const agentLoopCommand = new Command()
  .name("__agent-loop")
  .description("Internal sandbox Pi agent loop")
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
