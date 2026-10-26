import {
  array,
  boolean,
  discriminatedUnion,
  literal,
  object,
  record,
  string,
  enum as zEnum,
  unknown as zUnknown,
  type infer as zInfer,
} from "zod";

import { initContract } from "./base";
import { apiErrorSchema } from "./errors";

const c = initContract();

const teamsActorSchema = object({
  id: string(),
  name: string().nullable(),
  aadObjectId: string().nullable(),
  userPrincipalName: string().nullable(),
});

const teamsInboundAttachmentSchema = object({
  id: string().nullable(),
  contentType: string().nullable(),
  contentUrl: string().nullable(),
  name: string().nullable(),
  content: record(string(), zUnknown()).nullable(),
});

const teamsActivityBaseSchema = object({
  activityId: string().nullable(),
  tenantId: string(),
  tenantName: string().nullable(),
  teamsAppId: string().nullable(),
  serviceUrl: string(),
  conversationId: string(),
  conversationType: string().nullable(),
  teamId: string().nullable(),
  teamAadGroupId: string().nullable(),
  teamName: string().nullable(),
  channelId: string().nullable(),
  timestamp: string().nullable(),
  idempotencyKey: string(),
});

export const teamsInboundMessageActivitySchema = teamsActivityBaseSchema.extend(
  {
    kind: literal("message"),
    threadId: string(),
    sender: teamsActorSchema,
    recipient: teamsActorSchema.nullable(),
    rawText: string(),
    text: string(),
    value: record(string(), zUnknown()).nullable(),
    mentionsRecipient: boolean(),
    attachments: array(teamsInboundAttachmentSchema),
  },
);

export const teamsConversationUpdateActivitySchema =
  teamsActivityBaseSchema.extend({
    kind: literal("conversation_update"),
    action: zEnum(["members_added", "members_removed", "unknown"]),
    sender: teamsActorSchema,
    recipient: teamsActorSchema,
    membersAdded: array(teamsActorSchema),
    membersRemoved: array(teamsActorSchema),
  });

export const teamsBotRemovedActivitySchema = teamsActivityBaseSchema.extend({
  kind: literal("bot_removed"),
  reason: zEnum(["members_removed", "installation_remove"]),
  recipient: teamsActorSchema.nullable(),
  membersRemoved: array(teamsActorSchema),
});

export const teamsInstallationUpdateActivitySchema =
  teamsActivityBaseSchema.extend({
    kind: literal("installation_update"),
    action: zEnum(["add", "unknown"]),
    sender: teamsActorSchema,
    recipient: teamsActorSchema.nullable(),
  });

export const teamsUnsupportedActivitySchema = object({
  kind: literal("unsupported"),
  activityType: string(),
  idempotencyKey: string().nullable(),
});

export const teamsInboundActivitySchema = discriminatedUnion("kind", [
  teamsInboundMessageActivitySchema,
  teamsConversationUpdateActivitySchema,
  teamsBotRemovedActivitySchema,
  teamsInstallationUpdateActivitySchema,
  teamsUnsupportedActivitySchema,
]);

const teamsBotDispatchResponseSchema = discriminatedUnion("kind", [
  object({ kind: literal("ignored") }),
  object({
    kind: literal("notice"),
    replyText: string(),
    connectUrl: string().optional(),
    card: record(string(), zUnknown()).optional(),
  }),
  object({
    kind: literal("accepted"),
    runId: string(),
  }),
  object({
    kind: literal("queued"),
    runId: string(),
  }),
  object({
    kind: literal("failed"),
    replyText: string(),
    runId: string().optional(),
  }),
]);

export const teamsBotIngressResponseSchema = object({
  ok: literal(true),
  activity: teamsInboundActivitySchema,
  connectUrl: string().nullable().optional(),
  dispatch: teamsBotDispatchResponseSchema.optional(),
});

export const teamsBotContract = c.router({
  post: {
    method: "POST",
    path: "/api/webhooks/teams/bot",
    body: zUnknown(),
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

export type TeamsActor = zInfer<typeof teamsActorSchema>;
export type TeamsInboundAttachment = zInfer<
  typeof teamsInboundAttachmentSchema
>;
export type TeamsInboundActivity = zInfer<typeof teamsInboundActivitySchema>;
export type TeamsBotIngressResponse = zInfer<
  typeof teamsBotIngressResponseSchema
>;
export type TeamsBotDispatchResponse = zInfer<
  typeof teamsBotDispatchResponseSchema
>;
export type TeamsBotContract = typeof teamsBotContract;
