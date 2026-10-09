import { computed, type Computed } from "ccstate";
import { resolveIntegrationNotePrompt } from "../integration-note-prompt.service";
import { appendTeamsFilesToPrompt, buildTeamsPrompt } from "../teams-prompt";
import type { TeamsThreadContext } from "../thread-run-context.service";
import type { RunPromptAndSkills } from "../run-prompt-and-skills";
import type { ThreadPromptSource } from "./types";

export function createTeamsThreadPrompt(
  source$: Computed<Promise<ThreadPromptSource | null>>,
  context$: Computed<Promise<TeamsThreadContext>>,
): Computed<Promise<RunPromptAndSkills | null>> {
  return computed(async (get) => {
    const source = await get(source$);
    if (source?.event.contextType !== "teams") {
      return null;
    }
    const context = await get(context$);
    if (!context) {
      return null;
    }
    // The context also retains history attachments for delivery; the user
    // prompt includes only attachments from the current input message.
    const files = context.messageFiles.filter((file) => {
      return file.inCurrentMessage;
    });
    const threadId =
      context.conversationType === "personal" &&
      context.activityId &&
      context.threadId.startsWith("direct-message:")
        ? context.activityId
        : context.threadId;
    const identity: string[] = [];
    if (context.senderDisplayName) {
      identity.push(`Teams display name: ${context.senderDisplayName}`);
    }
    if (context.senderPrincipalName) {
      identity.push(
        `Teams user principal name: ${context.senderPrincipalName}`,
      );
    }
    if (context.senderUserId) {
      identity.push(`Teams user ID: ${context.senderUserId}`);
    }
    return {
      userPromptVariables: {
        message: appendTeamsFilesToPrompt(context.messageText, files),
      },
      systemPromptVariables: {
        integrationContext: buildTeamsPrompt({
          tenantId: context.tenantId,
          tenantName: context.tenantName,
          teamId: context.teamId,
          teamName: context.teamName,
          channelId: context.channelId,
          conversationId: context.conversationId,
          conversationType: context.conversationType,
          threadId,
          activityId: context.activityId,
          teamsAppId: context.teamsAppId,
          botId: context.installationBotId,
          botName: context.installationBotName,
          integrationNote: resolveIntegrationNotePrompt({
            triggerSource: "teams",
            featureSwitchContext: source.featureSwitchContext,
          }),
          threadContext: context.threadContext,
        }),
        channelUserIdentity: identity.join("\n"),
      },
      skillVolumes: [],
    };
  });
}
