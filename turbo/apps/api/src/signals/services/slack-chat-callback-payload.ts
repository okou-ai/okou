import { z } from "zod";

export const slackChatCallbackPayloadSchema = z.object({
  channelId: z.string(),
  threadTs: z.string(),
  routeThreadTs: z.string().optional(),
  chatEventId: z.string(),
});
