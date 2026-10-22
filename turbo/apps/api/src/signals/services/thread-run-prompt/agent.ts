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

const TASKS_PROMPT = [
  "",
  "- Tasks: persistent delegations executed asynchronously by Okou's background Tasks loop when background execution is enabled. Create a Task only when the user explicitly entrusts work as an Okou Task; ordinary chat requests and Suggestions do not become Tasks automatically.",
  "  - Use `okou task --help`, then `okou task create --file <path> --json` with a stable UUID, title and self-contained objective. Include the authorized scope, delivery target, necessary inputs and completion criteria; background runs use saved Task details rather than inheriting this chat. Preserve the UUID and exact creation file when retrying an uncertain creation.",
  "  - Creating chat: after successful creation, confirm the saved Task ID and end the turn. The background Tasks loop owns execution, progress and Results. Do not also perform the objective, mark the Task completed, start another worker or workflow, or poll while waiting for completion. Creation and an `active` status acknowledge saved work, not a running or completed action. When background Tasks execution is paused, saved Tasks wait; do not take over their work in this chat.",
  "  - Status requests: use `okou task list --json` or `okou task get <id> --json` to report saved progress and Results. Reading a pending Task does not transfer execution to this chat.",
  "  - Background executor: in a Proactive tasks run, follow that workflow's instructions to perform the saved objectives, verify outcomes and persist progress or Results through `okou task update`. The creating-chat handoff rule does not prevent the background executor from doing the work.",
  "  - User replies and permission responses belong to Task details. Never infer permission from a stored approval or bypass current tool grants.",
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
  disabledPaidTools$: Computed<Promise<readonly string[]>>,
): Computed<Promise<RunPromptAndSkills>> {
  return computed(async (get): Promise<RunPromptAndSkills> => {
    const [
      agent,
      featureSwitchContext,
      cloudBrowserEnabled,
      disabledPaidTools,
    ] = await Promise.all([
      get(agent$),
      get(featureSwitches$),
      get(cloudBrowserEnabled$),
      get(disabledPaidTools$),
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
              disabledPaidTools,
            }),
          ) +
          (agent?.id === agent?.defaultAgentId &&
          isFeatureEnabled(FeatureSwitchKey.ProactiveJobs, featureSwitchContext)
            ? TASKS_PROMPT
            : ""),
      },
      userPromptVariables: {},
      skillVolumes: [],
    };
  });
}
