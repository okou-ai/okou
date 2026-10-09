import type { TriggerSource } from "@okouai/api-contracts/contracts/logs";
import { AGENT_EXECUTION_TIMEOUT_SECONDS } from "@okouai/api-contracts/contracts/runners";
import type { FeatureSwitchContext } from "@okouai/core/feature-switch";
import { computed, type Computed } from "ccstate";
import type { BootstrapAgent } from "../agent-data.service";
import { buildAgentIdentityPrompt } from "../agent-identity-prompt.service";
import {
  buildAgentToolsPrompt,
  buildAgentToolsPromptInputs,
} from "../agent-tools-prompt.service";
import type { RunPromptAndSkills } from "../run-prompt-and-skills";

export interface AgentPromptContext {
  readonly featureSwitchContext: FeatureSwitchContext;
  readonly triggerSource: TriggerSource;
  readonly cloudBrowserEnabled: boolean | undefined;
}

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
  context$: Computed<Promise<AgentPromptContext>>,
): Computed<Promise<RunPromptAndSkills>> {
  return computed(async (get): Promise<RunPromptAndSkills> => {
    const [agent, context] = await Promise.all([get(agent$), get(context$)]);
    return {
      systemPromptVariables: {
        agentIdentity: agent ? (buildAgentIdentityPrompt(agent) ?? "") : "",
        executionLimit: buildExecutionTimeLimitPrompt(),
        tools: buildAgentToolsPrompt(buildAgentToolsPromptInputs(context)),
      },
      userPromptVariables: {},
      skillVolumes: [],
    };
  });
}
