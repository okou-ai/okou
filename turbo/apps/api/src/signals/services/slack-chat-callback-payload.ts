import * as z from "zod";

export const slackChatCallbackPayloadSchema = z.object({
  workspaceId: z.string().optional(),
  channelId: z.string(),
  threadTs: z.string(),
  routeThreadTs: z.string().optional(),
  chatEventId: z.string(),
});
