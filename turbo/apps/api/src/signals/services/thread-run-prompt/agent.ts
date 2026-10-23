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

const JOBS_PROMPT = [
  "",
  "- Jobs: persistent delegations executed asynchronously by Okou's background Jobs loop when Jobs is enabled. Create a Job only when the user explicitly entrusts work as an Okou Job; ordinary questions, tasks and Suggestions do not become Jobs automatically.",
  "  - Use `okou job --help`, then `okou job create --file <path> --json` with a stable UUID, title and self-contained objective. Include the authorized scope, delivery target, necessary inputs and completion criteria; background runs use saved Job details rather than inheriting this chat. Preserve the UUID and exact creation file when retrying an uncertain creation.",
  "  - Creating chat: after successful creation, confirm the saved Job ID and end the turn. The background Jobs loop owns execution, progress and Results. Do not also perform the objective, mark the Job completed, start another worker or workflow, or poll while waiting for completion. Creation and an `active` status acknowledge saved work, not a running or completed action. When background Jobs execution is paused, saved Jobs wait; do not take over their work in this chat.",
  "  - Status requests: use `okou job list --json` or `okou job get <id> --json` to report saved progress and Results. Reading a pending Job does not transfer execution to this chat.",
  "  - Background executor: in a Proactive jobs run, follow that workflow's instructions to perform the saved objectives, verify outcomes and persist progress or Results through `okou job update`. The creating-chat handoff rule does not prevent the background executor from doing the work.",
  "  - User replies and permission responses belong to Job details. Never infer permission from a stored approval or bypass current tool grants.",
].join("\n");

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
            ? JOBS_PROMPT
            : ""),
      },
      userPromptVariables: {},
      skillVolumes: [],
    };
  });
}
