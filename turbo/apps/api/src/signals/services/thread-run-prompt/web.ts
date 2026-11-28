import type { BootstrapFeatureSwitchContext } from "../agent-run-context.signals";
import type { LaunchFramework } from "../launch-framework";
import { computed, type Computed } from "ccstate";
import { voiceModeForFramework } from "../../../lib/conversation-guidance";
import {
  chatRunSourceAnnotation,
  projectUserMessage,
  requiredUserMessageForEvent,
  userMessageReferences,
} from "../chat-user-message.service";
import { resolveIntegrationNotePrompt } from "../integration-note-prompt.service";
import { buildWebChatAppendSystemPrompt } from "../web-chat-session-prompt.service";
import type { RunPrompt } from "../run-prompt-and-skills";
import type { PickedThreadInputEvent } from "./types";
import type { ThreadProjectContext } from "../thread-project-context.service";

const CODEX_WEB_IMAGE_GENERATION_UPLOAD_PROMPT =
  "If you use the built-in image generation tool and it saves generated output image file(s) to local paths, upload each output file you intend to show with `okou web upload-file -f <path>` before telling the web chat user the image is available. Quote the path when needed. Do not provide only sandbox-local paths, because users cannot open local files.";

export function createWebThreadPrompt(
  pickedEvent$: Computed<Promise<PickedThreadInputEvent | null>>,
  featureSwitches$: Computed<Promise<BootstrapFeatureSwitchContext>>,
  framework$: Computed<Promise<LaunchFramework>>,
  projectContext$: Computed<Promise<ThreadProjectContext | null>>,
): Computed<Promise<RunPrompt | null>> {
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
    const [framework, featureSwitchContext, projectContext] = await Promise.all(
      [get(framework$), get(featureSwitches$), get(projectContext$)],
    );
    const voiceMode = voiceModeForFramework(framework);
    const triggerSource =
      pickedEvent.contextType === "agent_run" ? "agent" : "web";
    return {
      userPromptVariables: {
        message: projectUserMessage(message, { voiceMode }).agentPrompt,
      },
      systemPromptVariables: {
        ...(framework === "codex" && pickedEvent.chatThreadId
          ? { codexImageUpload: CODEX_WEB_IMAGE_GENERATION_UPLOAD_PROMPT }
          : {}),
        integrationContext: buildWebChatAppendSystemPrompt({
          threadId: pickedEvent.chatThreadId,
          incompleteContext: "",
          priorContext: "",
          context: {
            projectContext: buildProjectContext(projectContext),
            generationTemplatePrompt: "",
            computerUseHostDisplayName: null,
            triggerSource,
            chatRunSource: chatRunSourceAnnotation(message),
            references: userMessageReferences(message),
            integrationNote: resolveIntegrationNotePrompt({
              triggerSource,
              featureSwitchContext,
            }),
            voiceMode,
          },
        }),
      },
    };
  });
}

function buildProjectContext(context: ThreadProjectContext | null): string {
  if (!context) {
    return "";
  }
  const { current, references } = context;
  const lines = [
    "# Current Run Project context",
    "This block replaces Project context from earlier rounds. Membership is resolved for this Run; later changes apply to the next Run.",
    current
      ? `Current Project: ${JSON.stringify(current.name)} (PROJECT_ID=${current.id})`
      : "This conversation is currently unassigned to a Project.",
  ];
  for (const ref of references) {
    lines.push(
      ref.currentName !== null
        ? `Mentioned Project ${JSON.stringify(ref.nameSnapshot)}: PROJECT_ID=${ref.projectId}; current name=${JSON.stringify(ref.currentName)}`
        : `Mentioned Project ${JSON.stringify(ref.nameSnapshot)} (${ref.projectId}) is unavailable. Do not substitute another Project.`,
    );
  }
  lines.push(
    "Discover ALL related conversations with `okou chat list --project-id <PROJECT_ID> --limit all --json`, including your authorized archived and muted chats. Read relevant history with `okou chat messages --thread-id <id> --output-dir /tmp/okou-chat-history`. Check current availability with `okou project get <PROJECT_ID> --json`. Each call checks ownership and membership. A mention does not move this conversation, change its execution context, or grant access to accounts, credentials, Instructions or private data.",
  );
  return lines.join("\n\n");
}
