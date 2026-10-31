import { array, object, string, uuid, type infer as zInfer } from "zod";

import { teamsFileTokenPayloadSchema } from "./teams-file-token";

const teamsChatCallbackFileSchema = teamsFileTokenPayloadSchema.extend({
  fileId: string().min(1),
});

export const teamsDeliveryTargetSchema = object({
  tenantId: string().min(1),
  tenantName: string().nullable(),
  teamId: string().nullable(),
  teamName: string().nullable(),
  channelId: string().nullable(),
  conversationId: string().min(1),
  conversationType: string().nullable(),
  threadId: string().min(1),
  activityId: string().nullable(),
  serviceUrl: string(),
  connectionId: string().min(1),
  teamsUserId: string().min(1),
  teamsUserDisplayName: string().nullable(),
  teamsUserPrincipalName: string().nullable(),
  botId: string().nullable(),
  botName: string().nullable(),
  files: array(teamsChatCallbackFileSchema).optional(),
});

export type TeamsDeliveryTarget = zInfer<typeof teamsDeliveryTargetSchema>;

export const teamsChatCallbackPayloadSchema = teamsDeliveryTargetSchema.extend({
  chatEventId: uuid(),
});
