import { computed, type Computed } from "ccstate";
import {
  agentRunSourceAnnotation,
  projectUserMessage,
  requiredUserMessageForEvent,
} from "../chat-user-message.service";
import { resolveIntegrationNotePrompt } from "../integration-note-prompt.service";
import { buildWebChatAppendSystemPrompt } from "../web-chat-session-prompt.service";
import type { RunPromptAndSkills } from "../run-prompt-and-skills";
import type { ThreadPromptSource } from "./types";

export function createWebThreadPrompt(
  source$: Computed<Promise<ThreadPromptSource | null>>,
): Computed<Promise<RunPromptAndSkills | null>> {
  return computed(async (get) => {
    const source = await get(source$);
    if (
      !source ||
      (source.event.contextType !== "web" &&
        source.event.contextType !== "agent_run")
    ) {
      return null;
    }
    const message = requiredUserMessageForEvent(
      "input.prompt",
      source.event.userMessage,
    );
    if (!message) {
      throw new Error("Queued input event is missing userMessage");
    }
    const triggerSource =
      source.event.contextType === "agent_run" ? "agent" : "web";
    return {
      userPromptVariables: { message: projectUserMessage(message).agentPrompt },
      systemPromptVariables: {
        integrationContext: buildWebChatAppendSystemPrompt({
          threadId: source.chatThreadId,
          incompleteContext: "",
          priorContext: "",
          context: {
            generationTemplatePrompt: "",
            computerUseHostDisplayName: null,
            triggerSource,
            agentRunSource: agentRunSourceAnnotation(message),
            integrationNote: resolveIntegrationNotePrompt({
              triggerSource,
              featureSwitchContext: source.featureSwitchContext,
            }),
          },
        }),
      },
      skillVolumes: [],
    };
  });
}
