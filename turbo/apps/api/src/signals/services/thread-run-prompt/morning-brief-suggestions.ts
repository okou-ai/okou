import { computed, type Computed } from "ccstate";
import { isFeatureEnabled } from "@okouai/core/feature-switch";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import type { AgentRunContextSignals } from "../agent-run-context.signals";
import type { ThreadAutomationTarget } from "../thread-context.signals";
import type { RunPromptAndSkills } from "../run-prompt-and-skills";
import type { PickedThreadInputEvent } from "./types";

const MORNING_BRIEF_SUGGESTION_INSTRUCTION = `## Curate next-step suggestions when available

If this run has the suggestion capability and \`okou suggestion\` is available, use \`okou suggestion list --json\` to inspect the user's active suggestions and recent consumed/removed identities. Only Okou, the primary Agent, manages this user-owned pool. Retain useful actions, update changed content or priority, withdraw obsolete actions, and create verified new actions. There may be zero to ten active suggestions; do not fill a quota or replace the pool by calendar date. Larger integer priorities appear first, with no requirement for consecutive or unique values.

Use \`okou suggestion create --file suggestion.json --json\`, \`okou suggestion update <id> --file changes.json --json\`, and \`okou suggestion delete <id> --json\`. A creation file contains a stable UUID \`id\`, concise \`title\` and \`rationale\`, integer \`priority\`, nullable \`threadId\`, and \`draft\` in the normal saved composer format: \`{ "draftUserMessage": { "version": 1, "parts": [{ "type": "text", "text": "A self-contained next-step prompt" }] }, "draftAttachments": null }\`. Existing authorized conversations use their exact thread ID; new conversations use null and are handled by Okou. Include verified background and source references in the draft. Do not modify the user's live composer or execute suggested work.

Preserve the same UUID and exact creation file after an uncertain result. A consumed/removed identity is terminal; do not replay it to restore an item. A genuinely new next action needs a new UUID. If the pool is full, explicitly decide which item to withdraw before creating another. Missing/disabled commands or capabilities leave suggestion publication unavailable; continue producing the useful briefing and its normal email decision without another publication channel.`;

/**
 * Temporary AgentSuggestion rollout (#39591): at GA, fold this guidance back
 * into the shared MORNING_BRIEF_INSTRUCTION, then remove this contribution,
 * the morningBriefSuggestions prompt variable, and its composer wiring.
 * Keep primary-Agent authorization and immutable captured revisions intact.
 */
export function createMorningBriefSuggestionsPrompt(
  event$: Computed<Promise<PickedThreadInputEvent | null>>,
  agent$: AgentRunContextSignals["agent$"],
  featureSwitches$: AgentRunContextSignals["featureSwitches$"],
  target$: Computed<Promise<ThreadAutomationTarget | null>>,
): Computed<Promise<RunPromptAndSkills>> {
  return computed(async (get): Promise<RunPromptAndSkills> => {
    const event = await get(event$);
    let guidance = "";
    if (
      event?.contextType === "automation" &&
      event.eventType === "input.automation"
    ) {
      const [agent, featureSwitchContext, target] = await Promise.all([
        get(agent$),
        get(featureSwitches$),
        get(target$),
      ]);
      if (
        agent !== null &&
        agent.id === agent.defaultAgentId &&
        target?.workflow.officialDefinitionName === "morning-brief" &&
        isFeatureEnabled(FeatureSwitchKey.AgentSuggestion, featureSwitchContext)
      ) {
        guidance = [
          "# Morning Brief Suggestions",
          "After preparing the briefing, curate verified next steps for the user.",
          MORNING_BRIEF_SUGGESTION_INSTRUCTION,
        ].join("\n\n");
      }
    }
    return {
      systemPromptVariables: { morningBriefSuggestions: guidance },
      userPromptVariables: {},
      skillVolumes: [],
    };
  });
}
