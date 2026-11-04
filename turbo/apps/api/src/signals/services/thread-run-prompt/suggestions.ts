import { computed, type Computed } from "ccstate";
import { and, eq } from "drizzle-orm";
import { isFeatureEnabled } from "@okouai/core/feature-switch";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { orgMembersMetadata } from "@okouai/db/runtime/org-members-metadata";
import { PROACTIVE_LEARNING_DEFINITION_NAME } from "@okouai/api-contracts/contracts/proactive-nightly";
import { PROACTIVE_SUGGESTIONS_DEFINITION_NAME } from "@okouai/api-contracts/contracts/proactive-suggestions";
import { isMorningBriefDefinitionName } from "@okouai/api-contracts/contracts/morning-brief-preference";
import { db$ } from "../../external/db";
import { settle } from "../../utils";
import type { AgentRunContextSignals } from "../agent-run-context.signals";
import type { ThreadContext } from "../thread-context.signals";
import type { RunPromptAndSkills } from "../run-prompt-and-skills";
import { createSuggestionFeedbackContext } from "../suggestion-feedback-context.service";
import { SUGGESTION_FEEDBACK_INSTRUCTION } from "../suggestion-feedback-instructions";
import type { PickedThreadInputEvent } from "./types";

export function createSuggestionsPrompt(
  bootstrap: AgentRunContextSignals,
  pickedEvent$: Computed<Promise<PickedThreadInputEvent | null>>,
  threadContext: ThreadContext,
): Computed<Promise<RunPromptAndSkills>> {
  const feedback$ = createSuggestionFeedbackContext(bootstrap, pickedEvent$);
  return computed(async (get) => {
    const empty: RunPromptAndSkills = {
      systemPromptVariables: {},
      userPromptVariables: {},
      skillVolumes: [],
    };
    const [agent, features] = await Promise.all([
      get(bootstrap.agent$),
      get(bootstrap.featureSwitches$),
    ]);
    if (
      !agent ||
      agent.id !== agent.defaultAgentId ||
      !isFeatureEnabled(FeatureSwitchKey.AgentSuggestion, features)
    ) {
      return empty;
    }
    const [event, workflows] = await Promise.all([
      get(pickedEvent$),
      get(threadContext.officialWorkflowObservation$),
    ]);
    const definitions = workflows?.definitions ?? [];
    if (
      definitions.some((item) => {
        return item.name === PROACTIVE_LEARNING_DEFINITION_NAME;
      })
    ) {
      return empty;
    }
    if (
      event?.contextType === "automation" &&
      definitions.some((item) => {
        return (
          item.name === PROACTIVE_SUGGESTIONS_DEFINITION_NAME ||
          isMorningBriefDefinitionName(item.name)
        );
      })
    ) {
      const [member] = await get(db$)
        .select({ enabled: orgMembersMetadata.proactiveSuggestionsEnabled })
        .from(orgMembersMetadata)
        .where(
          and(
            eq(orgMembersMetadata.orgId, bootstrap.orgId),
            eq(orgMembersMetadata.userId, bootstrap.userId),
          ),
        )
        .limit(1);
      if (!member?.enabled) {
        return empty;
      }
    }
    const result = await settle(get(feedback$));
    return {
      systemPromptVariables: {
        suggestionFeedback: [
          "# Suggestions feedback context",
          SUGGESTION_FEEDBACK_INSTRUCTION,
          result.ok
            ? JSON.stringify(result.value)
            : "Feedback context is unavailable. Skip Suggestions maintenance in this Run; continue other authorized work.",
        ].join("\n\n"),
      },
      userPromptVariables: {},
      skillVolumes: [],
    };
  });
}
