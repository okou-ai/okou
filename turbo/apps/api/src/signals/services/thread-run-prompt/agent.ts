import { AGENT_EXECUTION_TIMEOUT_SECONDS } from "@okouai/api-contracts/contracts/runners";
import {
  isFeatureEnabled,
  type FeatureSwitchContext,
} from "@okouai/core/feature-switch";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { computed, type Computed } from "ccstate";
import type { BootstrapAgent } from "../agent-data.service";
import { buildAgentIdentityPrompt } from "../agent-identity-prompt.service";
import {
  buildAgentToolsPrompt,
  buildAgentToolsPromptInputs,
} from "../agent-tools-prompt.service";
import type { RunPromptAndSkills } from "../run-prompt-and-skills";

function buildExecutionTimeLimitPrompt(): string {
  const executionHours = AGENT_EXECUTION_TIMEOUT_SECONDS / (60 * 60);
  const executionHourUnit = executionHours === 1 ? "hour" : "hours";
  return [
    "# Execution Time Limit",
    "",
    `A single agent run has a maximum execution time of ${executionHours} ${executionHourUnit}.`,
    "Plan and prioritize the work so you can complete the most important in-scope tasks and provide a final response before the run ends.",
  ].join("\n");
}

export function createAgentPrompt(
  agent$: Computed<
    Promise<Pick<
      BootstrapAgent,
      "id" | "defaultAgentId" | "displayName" | "description" | "sound"
    > | null>
  >,
  featureSwitches$: Computed<Promise<FeatureSwitchContext>>,
  cloudBrowserEnabled$: Computed<Promise<boolean>>,
): Computed<Promise<RunPromptAndSkills>> {
  return computed(async (get): Promise<RunPromptAndSkills> => {
    const [agent, featureSwitchContext, cloudBrowserEnabled] =
      await Promise.all([
        get(agent$),
        get(featureSwitches$),
        get(cloudBrowserEnabled$),
      ]);
    return {
      systemPromptVariables: {
        agentIdentity: agent ? (buildAgentIdentityPrompt(agent) ?? "") : "",
        executionLimit: buildExecutionTimeLimitPrompt(),
        tools:
          buildAgentToolsPrompt(
            buildAgentToolsPromptInputs({
              featureSwitchContext,
              cloudBrowserEnabled,
            }),
          ) +
          (agent?.id === agent?.defaultAgentId &&
          isFeatureEnabled(FeatureSwitchKey.ProactiveJobs, featureSwitchContext)
            ? "\n- Jobs: create a persistent Job only when the user explicitly entrusts work as an Okou Job. Use `okou job --help`, then `okou job create --file <path> --json` with a stable UUID, title and objective. Ordinary questions, tasks and Suggestions do not become Jobs automatically. `okou job list --json` and `okou job get <id> --json` read saved progress and Results. User replies and permission responses belong to Job details. Never infer permission from a stored approval or bypass current tool grants."
            : ""),
      },
      userPromptVariables: {},
      skillVolumes: [],
    };
  });
}
