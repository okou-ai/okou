import { AGENT_EXECUTION_TIMEOUT_SECONDS } from "@okouai/api-contracts/contracts/runners";
import type { FeatureSwitchContext } from "@okouai/core/feature-switch";
import { computed, type Computed } from "ccstate";
import { SINGLE_AGENT_IDENTITY_PROMPT } from "../single-agent-scope-prompt";
import {
  buildAgentToolsPrompt,
  buildAgentToolsPromptInputs,
} from "../agent-tools-prompt.service";
import type { RunPrompt } from "../run-prompt-and-skills";

function buildExecutionTimeLimitPrompt(): string {
  const executionHours = AGENT_EXECUTION_TIMEOUT_SECONDS / (60 * 60);
  const executionHourUnit = executionHours === 1 ? "hour" : "hours";
  return [
    "# Execution Time Limit",
    "",
    `A single agent run has a maximum execution time of ${executionHours} ${executionHourUnit}. When it is reached, the runner stops the run; the user keeps the messages and files delivered before then.`,
    "The user receives results through your messages and the files or links you deliver.",
    "Each model request resends the conversation so far, so requests take longer and cost more as the conversation grows. Files saved in the workspace remain available for the rest of the run, including after context compaction.",
  ].join("\n");
}

export function createAgentPrompt(
  featureSwitches$: Computed<Promise<FeatureSwitchContext>>,
  cloudBrowserEnabled$: Computed<Promise<boolean>>,
  disabledPaidTools$: Computed<Promise<readonly string[]>>,
  singleAgent$: Computed<Promise<boolean>>,
): Computed<Promise<RunPrompt>> {
  return computed(async (get): Promise<RunPrompt> => {
    const [
      featureSwitchContext,
      cloudBrowserEnabled,
      disabledPaidTools,
      singleAgent,
    ] = await Promise.all([
      get(featureSwitches$),
      get(cloudBrowserEnabled$),
      get(disabledPaidTools$),
      get(singleAgent$),
    ]);
    return {
      systemPromptVariables: {
        agentIdentity: SINGLE_AGENT_IDENTITY_PROMPT,
        executionLimit: buildExecutionTimeLimitPrompt(),
        tools: buildAgentToolsPrompt(
          buildAgentToolsPromptInputs({
            singleAgent,
            featureSwitchContext,
            cloudBrowserEnabled,
            disabledPaidTools,
          }),
        ),
      },
      userPromptVariables: {},
    };
  });
}
