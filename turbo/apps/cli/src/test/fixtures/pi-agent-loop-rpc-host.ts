import {
  piSandboxAgentConfigFromEnv,
  runPiSandboxAgentLoop,
} from "../../lib/pi-agent-loop";

const agentDir = process.argv[2];
const sessionDir = process.argv[3];
if (!agentDir || !sessionDir) {
  throw new Error("The Pi RPC fixture requires agent and session directories");
}

const config = await piSandboxAgentConfigFromEnv();

await runPiSandboxAgentLoop({
  config,
  agentDir,
  sessionDir,
  memoryRoot: process.argv[4],
});
