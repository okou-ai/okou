import { db$ } from "../../external/db";
import { projects } from "@okouai/db/schema/project";
import { and, eq, inArray } from "drizzle-orm";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { isFeatureEnabled } from "@okouai/core/feature-switch";
import type { BootstrapFeatureSwitchContext } from "../agent-run-context.signals";
import type { SupportedFramework } from "@okouai/core/frameworks";
import { computed, type Computed } from "ccstate";
import {
  agentRunSourceAnnotation,
  projectUserMessage,
  requiredUserMessageForEvent,
  userMessageReferences,
} from "../chat-user-message.service";
import { resolveIntegrationNotePrompt } from "../integration-note-prompt.service";
import { buildWebChatAppendSystemPrompt } from "../web-chat-session-prompt.service";
import type { RunPromptAndSkills } from "../run-prompt-and-skills";
import type { PickedThreadInputEvent } from "./types";

const CODEX_WEB_IMAGE_GENERATION_UPLOAD_PROMPT =
  "If you use the built-in image generation tool and it saves generated output image file(s) to local paths, upload each output file you intend to show with `okou web upload-file -f <path>` before telling the web chat user the image is available. Quote the path when needed. Do not provide only sandbox-local paths, because users cannot open local files.";

export function createWebThreadPrompt(
  pickedEvent$: Computed<Promise<PickedThreadInputEvent | null>>,
  featureSwitches$: Computed<Promise<BootstrapFeatureSwitchContext>>,
  framework$: Computed<Promise<SupportedFramework>>,
  singleAgent$: Computed<Promise<boolean>>,
): Computed<Promise<RunPromptAndSkills | null>> {
  const projectContext$ = computed(async (get) => {
    const picked = await get(pickedEvent$);
    const owner = await get(featureSwitches$);
    if (!picked || !isFeatureEnabled(FeatureSwitchKey.Projects, owner)) {
      return "";
    }
    const db = get(db$);
    const refs = picked.userMessage
      ? userMessageReferences(picked.userMessage).projects
      : [];
    const ids = [
      ...new Set([
        ...refs.map((ref) => {
          return ref.projectId;
        }),
        ...(picked.thread.projectId ? [picked.thread.projectId] : []),
      ]),
    ];
    const rows = ids.length
      ? await db
          .select({ id: projects.id, name: projects.name })
          .from(projects)
          .where(
            and(
              eq(projects.userId, owner.userId),
              eq(projects.orgId, owner.orgId),
              inArray(projects.id, ids),
            ),
          )
      : [];
    const current = rows.find((project) => {
      return project.id === picked.thread.projectId;
    });
    const lines = [
      "# Current Run Project context",
      "This block replaces Project context from earlier rounds. Membership is resolved for this Run; later changes apply to the next Run.",
      current?.id
        ? `Current Project: ${JSON.stringify(current.name)} (PROJECT_ID=${current.id})`
        : "This conversation is currently unassigned to a Project.",
    ];
    for (const ref of refs) {
      const available = rows.find((p) => {
        return p.id === ref.projectId;
      });
      lines.push(
        available
          ? `Mentioned Project ${JSON.stringify(ref.nameSnapshot)}: PROJECT_ID=${available.id}; current name=${JSON.stringify(available.name)}`
          : `Mentioned Project ${JSON.stringify(ref.nameSnapshot)} (${ref.projectId}) is unavailable. Do not substitute another Project.`,
      );
    }
    lines.push(
      (await get(singleAgent$))
        ? "Discover ALL related conversations with `okou chat list --project-id <PROJECT_ID> --limit all --json`, including your authorized archived and muted chats. Read relevant history with `okou chat messages --thread-id <id> --output-dir threads`. Check current availability with `okou project get <PROJECT_ID> --json`. Each call checks ownership and membership. A mention does not move this conversation, change its execution context, or grant access to accounts, credentials, Instructions or private data."
        : "Discover ALL related conversations with `okou chat list --project-id <PROJECT_ID> --limit all --json`, including archived and muted chats across Agents. Read relevant history with `okou chat messages --thread-id <id> --output-dir threads`. Check current availability with `okou project get <PROJECT_ID> --json`. Each call checks live ownership and membership. A mention does not move this conversation, switch its Agent, or grant another Agent's instructions, connectors, credentials, or execution identity.",
    );
    return lines.join("\n\n");
  });
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
    const projectContext = await get(projectContext$);
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
            singleAgent: await get(singleAgent$),
            projectContext,
            generationTemplatePrompt: "",
            computerUseHostDisplayName: null,
            triggerSource,
            agentRunSource: agentRunSourceAnnotation(message),
            references: userMessageReferences(message),
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
