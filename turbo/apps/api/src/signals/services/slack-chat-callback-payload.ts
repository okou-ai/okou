import { object, string } from "zod";

export const slackChatCallbackPayloadSchema = object({
  workspaceId: string().optional(),
  channelId: string(),
  threadTs: string(),
  routeThreadTs: string().optional(),
  chatEventId: string(),
});
