import { computed, type Computed } from "ccstate";
import { settle } from "../../utils";
import type { AgentRunContextSignals } from "../agent-run-context.signals";
import type { ThreadContext } from "../thread-context.signals";
import type { RunPrompt } from "../run-prompt-and-skills";
import { createSuggestionFeedbackContext } from "../suggestion-feedback-context.service";
import { SUGGESTION_FEEDBACK_INSTRUCTION } from "../suggestion-feedback-instructions";
import type { PickedThreadInputEvent } from "./types";

export function createSuggestionsPrompt(
  bootstrap: AgentRunContextSignals,
  pickedEvent$: Computed<Promise<PickedThreadInputEvent | null>>,
  threadContext: ThreadContext,
): Computed<Promise<RunPrompt>> {
  const feedback$ = createSuggestionFeedbackContext(bootstrap, pickedEvent$);
  return computed(async (get) => {
    const empty: RunPrompt = {
      systemPromptVariables: {},
      userPromptVariables: {},
    };
    const event = await get(pickedEvent$);
    if (
      event?.contextType !== "proactive" ||
      !(await get(threadContext.proactiveInput$))?.suggestionsEnabled
    ) {
      return empty;
    }
    const result = await settle(get(feedback$));
    return {
      systemPromptVariables: {
        suggestionFeedback: [
          "# Suggestions feedback context",
          SUGGESTION_FEEDBACK_INSTRUCTION,
          result.ok
            ? JSON.stringify(result.value)
            : "Feedback context is unavailable. Skip Suggestions maintenance and feedback-based profile updates in this Run; continue other authorized work.",
        ].join("\n\n"),
      },
      userPromptVariables: {},
    };
  });
}
