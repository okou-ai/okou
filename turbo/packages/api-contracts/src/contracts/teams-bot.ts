import * as z from "zod";

import { initContract } from "./base";
import { apiErrorSchema } from "./errors";

const c = initContract();

const teamsActorSchema = z.object({
  id: z.string(),
  name: z.string().nullable(),
  aadObjectId: z.string().nullable(),
  userPrincipalName: z.string().nullable(),
});

const teamsInboundAttachmentSchema = z.object({
  id: z.string().nullable(),
  contentType: z.string().nullable(),
  contentUrl: z.string().nullable(),
  name: z.string().nullable(),
  content: z.record(z.string(), z.unknown()).nullable(),
});

const teamsActivityBaseSchema = z.object({
  activityId: z.string().nullable(),
  tenantId: z.string(),
  tenantName: z.string().nullable(),
  teamsAppId: z.string().nullable(),
  serviceUrl: z.string(),
  conversationId: z.string(),
  conversationType: z.string().nullable(),
  teamId: z.string().nullable(),
  teamAadGroupId: z.string().nullable(),
  teamName: z.string().nullable(),
  channelId: z.string().nullable(),
  timestamp: z.string().nullable(),
  idempotencyKey: z.string(),
});

export const teamsInboundMessageActivitySchema = teamsActivityBaseSchema.extend(
  {
    kind: z.literal("message"),
    threadId: z.string(),
    sender: teamsActorSchema,
    recipient: teamsActorSchema.nullable(),
    rawText: z.string(),
    text: z.string(),
    value: z.record(z.string(), z.unknown()).nullable(),
    mentionsRecipient: z.boolean(),
    attachments: z.array(teamsInboundAttachmentSchema),
  },
);

export const teamsConversationUpdateActivitySchema =
  teamsActivityBaseSchema.extend({
    kind: z.literal("conversation_update"),
    action: z.enum(["members_added", "members_removed", "unknown"]),
    sender: teamsActorSchema,
    recipient: teamsActorSchema,
    membersAdded: z.array(teamsActorSchema),
    membersRemoved: z.array(teamsActorSchema),
  });

export const teamsBotRemovedActivitySchema = teamsActivityBaseSchema.extend({
  kind: z.literal("bot_removed"),
  reason: z.enum(["members_removed", "installation_remove"]),
  recipient: teamsActorSchema.nullable(),
  membersRemoved: z.array(teamsActorSchema),
});

export const teamsInstallationUpdateActivitySchema =
  teamsActivityBaseSchema.extend({
    kind: z.literal("installation_update"),
    action: z.enum(["add", "unknown"]),
    sender: teamsActorSchema,
    recipient: teamsActorSchema.nullable(),
  });

export const teamsUnsupportedActivitySchema = z.object({
  kind: z.literal("unsupported"),
  activityType: z.string(),
  idempotencyKey: z.string().nullable(),
});

export const teamsInboundActivitySchema = z.discriminatedUnion("kind", [
  teamsInboundMessageActivitySchema,
  teamsConversationUpdateActivitySchema,
  teamsBotRemovedActivitySchema,
  teamsInstallationUpdateActivitySchema,
  teamsUnsupportedActivitySchema,
]);

const teamsBotDispatchResponseSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("ignored") }),
  z.object({
    kind: z.literal("notice"),
    replyText: z.string(),
    connectUrl: z.string().optional(),
    card: z.record(z.string(), z.unknown()).optional(),
  }),
  z.object({
    kind: z.literal("accepted"),
    runId: z.string(),
  }),
  z.object({
    kind: z.literal("queued"),
    runId: z.string(),
  }),
  z.object({
    kind: z.literal("failed"),
    replyText: z.string(),
    runId: z.string().optional(),
  }),
]);

export const teamsBotIngressResponseSchema = z.object({
  ok: z.literal(true),
  activity: teamsInboundActivitySchema,
  connectUrl: z.string().nullable().optional(),
  dispatch: teamsBotDispatchResponseSchema.optional(),
});

export const teamsBotContract = c.router({
  post: {
    method: "POST",
    path: "/api/webhooks/teams/bot",
    body: z.unknown(),
    responses: {
      200: teamsBotIngressResponseSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      503: apiErrorSchema,
    },
    summary: "Handle Microsoft Teams Bot Framework activities",
  },
});

export type TeamsActor = z.infer<typeof teamsActorSchema>;
export type TeamsInboundAttachment = z.infer<
  typeof teamsInboundAttachmentSchema
>;
export type TeamsInboundActivity = z.infer<typeof teamsInboundActivitySchema>;
export type TeamsBotIngressResponse = z.infer<
  typeof teamsBotIngressResponseSchema
>;
export type TeamsBotDispatchResponse = z.infer<
  typeof teamsBotDispatchResponseSchema
>;
export type TeamsBotContract = typeof teamsBotContract;
