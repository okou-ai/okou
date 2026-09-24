import type { ChatTeamsMessageFile } from "@okouai/db/jsonb-contracts/chat-teams-context";
import { CONVERSATION_GUIDANCE } from "../../lib/conversation-guidance";

type TeamsPromptFile = Pick<
  ChatTeamsMessageFile,
  "fileId" | "sourceId" | "name" | "contentType" | "canonicalAsset"
>;

export function formatTeamsFileForContext(file: TeamsPromptFile): string {
  return [
    `[Teams file] ${file.name} (${file.contentType})`,
    ...(file.sourceId ? [`   [Teams attachment ID] ${file.sourceId}`] : []),
    `   [ID] ${file.fileId}`,
  ].join("\n");
}

function optionalLine(
  label: string,
  value: string | null | undefined,
): string[] {
  return value ? [`${label}: ${value}`] : [];
}

export function buildTeamsPrompt(args: {
  readonly tenantId: string;
  readonly tenantName: string | null;
  readonly teamId: string | null;
  readonly teamName: string | null;
  readonly channelId: string | null;
  readonly conversationId: string;
  readonly conversationType: string | null;
  readonly threadId: string;
  readonly activityId: string | null;
  readonly teamsAppId: string | null;
  readonly botId: string | null;
  readonly botName: string | null;
  readonly integrationNote: string;
  readonly threadContext: string;
}): string {
  const currentIntegration = [
    "# Current Integration",
    "You are currently running inside: Microsoft Teams",
    `Tenant ID: ${args.tenantId}`,
    ...optionalLine("Tenant name", args.tenantName),
    ...optionalLine("Team ID", args.teamId),
    ...optionalLine("Team name", args.teamName),
    ...optionalLine("Channel ID", args.channelId),
    `Conversation ID: ${args.conversationId}`,
    ...optionalLine("Conversation type", args.conversationType),
    `Thread ID: ${args.threadId}`,
    ...optionalLine("Activity ID", args.activityId),
    ...optionalLine("Teams app ID", args.teamsAppId),
    ...optionalLine("Bot ID", args.botId),
    ...optionalLine("Bot name", args.botName),
  ]
    .filter((line): line is string => {
      return line.length > 0;
    })
    .join("\n");
  return [
    CONVERSATION_GUIDANCE,
    currentIntegration,
    args.integrationNote,
    args.threadContext,
  ]
    .filter((part): part is string => {
      return part.length > 0;
    })
    .join("\n\n");
}
