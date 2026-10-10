import type { SupportedFramework } from "@okouai/core/frameworks";
import type { FeatureSwitchContext } from "@okouai/core/feature-switch";
import { computed, type Computed } from "ccstate";
import {
  agentRunSourceAnnotation,
  projectUserMessage,
  requiredUserMessageForEvent,
} from "../chat-user-message.service";
import { resolveIntegrationNotePrompt } from "../integration-note-prompt.service";
import { buildWebChatAppendSystemPrompt } from "../web-chat-session-prompt.service";
import type { RunPromptAndSkills } from "../run-prompt-and-skills";
import type { PickedThreadInputEvent } from "./types";

const CODEX_WEB_IMAGE_GENERATION_UPLOAD_PROMPT =
  "If you use the built-in image generation tool and it saves generated output image file(s) to local paths, upload each output file you intend to show with `okou web upload-file -f <path>` before telling the web chat user the image is available. Quote the path when needed. Do not provide only sandbox-local paths, because users cannot open local files.";

export function createWebThreadPrompt(
  pickedEvent$: Computed<Promise<PickedThreadInputEvent | null>>,
  featureSwitches$: Computed<Promise<FeatureSwitchContext>>,
  framework$: Computed<Promise<SupportedFramework>>,
): Computed<Promise<RunPromptAndSkills | null>> {
  return computed(async (get) => {
    const pickedEvent = await get(pickedEvent$);
    if (
      !pickedEvent ||
      (pickedEvent.contextType !== "web" &&
        pickedEvent.contextType !== "agent_run")
    ) {
      return null;
    }
    const message = requiredUserMessageForEvent(
      "input.prompt",
      pickedEvent.userMessage,
    );
    if (!message) {
      throw new Error("Queued input event is missing userMessage");
    }
    const [framework, featureSwitchContext] = await Promise.all([
      get(framework$),
      get(featureSwitches$),
    ]);
    const triggerSource =
      pickedEvent.contextType === "agent_run" ? "agent" : "web";
    return {
      userPromptVariables: { message: projectUserMessage(message).agentPrompt },
      systemPromptVariables: {
        ...(framework === "codex" && pickedEvent.chatThreadId
          ? { codexImageUpload: CODEX_WEB_IMAGE_GENERATION_UPLOAD_PROMPT }
          : {}),
        integrationContext: buildWebChatAppendSystemPrompt({
          threadId: pickedEvent.chatThreadId,
          incompleteContext: "",
          priorContext: "",
          context: {
            generationTemplatePrompt: "",
            computerUseHostDisplayName: null,
            triggerSource,
            agentRunSource: agentRunSourceAnnotation(message),
            integrationNote: resolveIntegrationNotePrompt({
              triggerSource,
              featureSwitchContext,
            }),
          },
        }),
      },
      skillVolumes: [],
    };
  });
}
