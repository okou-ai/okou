import { z } from "zod";

import { teamsFileTokenPayloadSchema } from "./teams-file-token";

const teamsChatCallbackFileSchema = teamsFileTokenPayloadSchema.extend({
  fileId: z.string().min(1),
});

export const teamsDeliveryTargetSchema = z.object({
  tenantId: z.string().min(1),
  tenantName: z.string().nullable(),
  teamId: z.string().nullable(),
  teamName: z.string().nullable(),
  channelId: z.string().nullable(),
  conversationId: z.string().min(1),
  conversationType: z.string().nullable(),
  threadId: z.string().min(1),
  activityId: z.string().nullable(),
  serviceUrl: z.string(),
  connectionId: z.string().min(1),
  teamsUserId: z.string().min(1),
  teamsUserDisplayName: z.string().nullable(),
  teamsUserPrincipalName: z.string().nullable(),
  botId: z.string().nullable(),
  botName: z.string().nullable(),
  files: z.array(teamsChatCallbackFileSchema).optional(),
});

export type TeamsDeliveryTarget = z.infer<typeof teamsDeliveryTargetSchema>;

export const teamsChatCallbackPayloadSchema = teamsDeliveryTargetSchema.extend({
  chatEventId: z.string().uuid(),
});
