import { workflowAutomationsContract } from "@okouai/api-contracts/client/workflows";
import {
  PROACTIVE_LEARNING_BLUEPRINT_KEY,
  PROACTIVE_LEARNING_DEFINITION_NAME,
} from "@okouai/api-contracts/contracts/proactive";
import type { WorkflowAutomationSummary } from "@okouai/api-contracts/contracts/workflows";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { command, computed, state } from "ccstate";
import { accept } from "../../../lib/accept.ts";
import { defaultAgentId$ } from "../../agent.ts";
import { apiClient$ } from "../../api-client.ts";
import { featureSwitch$ } from "../../external/feature-switch.ts";
import { NEVER_RESOLVED_PROMISE, onRef } from "../../utils.ts";
import { settingsActionSignal$ } from "./settings-dialog.ts";

export const debugLearningEnabled$ = computed(async (get) => {
  const features = await get(featureSwitch$);
  return (
    features[FeatureSwitchKey.OkouDebug] &&
    features[FeatureSwitchKey.ProactiveLearning]
  );
});

const discovery$ = state<Promise<WorkflowAutomationSummary | null>>(
  NEVER_RESOLVED_PROMISE,
);
export const debugLearningAutomation$ = computed((get) => {
  return get(discovery$);
});

const discoverDebugLearning$ = command(async ({ get }, signal: AbortSignal) => {
  const defaultAgentId = await get(defaultAgentId$);
  signal.throwIfAborted();
  const result = await accept(
    get(apiClient$)(workflowAutomationsContract).listWorkspace({
      fetchOptions: { signal },
    }),
    [200],
    signal,
  );
  return (
    result.body.find((entry) => {
      return (
        entry.workflow.agentId === defaultAgentId &&
        entry.workflow.official?.definitionName ===
          PROACTIVE_LEARNING_DEFINITION_NAME &&
        entry.workflow.official.installationState === "installed" &&
        entry.workflow.official.definitionLifecycle === "active" &&
        entry.automation.official?.blueprintKey ===
          PROACTIVE_LEARNING_BLUEPRINT_KEY
      );
    })?.automation ?? null
  );
});

export const learningRunCardRef$ = onRef(
  command(
    async ({ get, set }, _element: HTMLElement, refSignal: AbortSignal) => {
      const settingsSignal = get(settingsActionSignal$);
      if (!settingsSignal || !(await get(debugLearningEnabled$))) {
        return;
      }
      const signal = AbortSignal.any([settingsSignal, refSignal]);
      signal.throwIfAborted();
      const request = set(discoverDebugLearning$, signal);
      set(discovery$, request);
      await request;
    },
  ),
);

export const runDebugLearning$ = command(
  async ({ get }, automationId: string, signal: AbortSignal) => {
    const result = await accept(
      get(apiClient$)(workflowAutomationsContract).run({
        params: { id: automationId },
        fetchOptions: { signal },
      }),
      [201],
      signal,
    );
    return result.body;
  },
);
