import { z } from "zod";

import { initContract } from "./base";
import { publicBrandSchema } from "./public-brand";

const c = initContract();

export const testSlackStateErrorSchema = z.object({
  error: z.string(),
});

export const testSlackStateDeleteResponseSchema = z.object({
  ok: z.literal(true),
});

export const testSlackStatePostBodySchema = z.object({
  team_id: z.string().optional(),
  slack_user_id: z.string().optional(),
  org_id: z.string().optional(),
  user_id: z.string().optional(),
  workspace_name: z.string().optional(),
  bot_user_id: z.string().optional(),
  bot_scopes: z.string().nullable().optional(),
  bot_token: z.string().optional(),
  public_brand: publicBrandSchema.optional(),
  installation_org_id: z.string().nullable().optional(),
  email: z.string().optional(),
  seed_connection: z.boolean().optional(),
  delete_connection: z.boolean().optional(),
  seed_default_agent: z.boolean().optional(),
  default_agent_name: z.string().optional(),
  default_agent_display_name: z.string().nullable().optional(),
  org_name: z.string().optional(),
  seed_secret_names: z.array(z.string()).optional(),
  seed_variables: z.record(z.string(), z.string()).optional(),
});

export const testSlackStatePostResponseSchema = z.object({
  ok: z.literal(true),
  team_id: z.string(),
  org_id: z.string(),
  user_id: z.string(),
  connection_id: z.string().nullable(),
  default_agent_id: z.string().nullable(),
});

export const testSlackStateResponseSchema = z.object({
  installation: z
    .object({
      slackWorkspaceId: z.string(),
      slackWorkspaceName: z.string().nullable(),
      orgId: z.string().nullable(),
      botUserId: z.string(),
      botScopes: z.string().nullable(),
      installedByUserId: z.string().nullable(),
      publicBrand: publicBrandSchema,
      createdAt: z.string(),
    })
    .nullable(),
  connections: z.array(
    z.object({
      id: z.string(),
      slackUserId: z.string(),
      userId: z.string(),
      dmWelcomeSent: z.boolean(),
      createdAt: z.string(),
    }),
  ),
  chat_thread_routes: z.array(
    z.object({
      id: z.string(),
      connectionId: z.string(),
      channelId: z.string(),
      threadTs: z.string(),
      userId: z.string(),
      chatThreadId: z.string(),
      createdAt: z.string(),
    }),
  ),
  chat_ingress: z.array(
    z.object({
      id: z.string(),
      routeId: z.string(),
      eventId: z.string(),
      payload: z.string(),
      publicBrand: publicBrandSchema,
      status: z.enum([
        "pending",
        "processing",
        "retryable",
        "processed",
        "failed",
        "terminal",
      ]),
      retryCount: z.number(),
      processingAttemptCount: z.number(),
      retryAt: z.string().nullable(),
      lastErrorClass: z.string().nullable(),
      lastError: z.string().nullable(),
      createdAt: z.string(),
      updatedAt: z.string(),
    }),
  ),
  pending_chat_events: z.array(
    z.object({
      id: z.string(),
      chatThreadId: z.string(),
      eventType: z.enum(["input.prompt", "input.automation"]),
      createdAt: z.string(),
    }),
  ),
  recent_runs: z.array(
    z.object({
      id: z.string(),
      status: z.string(),
      createdAt: z.string(),
      triggerSource: z.string().nullable(),
      userId: z.string(),
      error: z.string().nullable(),
      promptPreview: z.string().nullable(),
    }),
  ),
  org_metadata: z
    .object({
      orgId: z.string(),
      defaultAgentId: z.string().nullable(),
      credits: z.number(),
      tier: z.string(),
    })
    .nullable(),
  default_agent: z
    .object({
      id: z.string(),
      name: z.string(),
      orgId: z.string(),
    })
    .nullable(),
});

export const testSlackStateContract = c.router({
  get: {
    method: "GET",
    path: "/api/test/slack-state",
    query: z.object({
      team_id: z.string().optional(),
      empty_team_id: z.literal("1").optional(),
      org_id: z.string().optional(),
    }),
    responses: {
      200: testSlackStateResponseSchema,
      400: testSlackStateErrorSchema,
      404: z.string(),
    },
    summary: "Read Slack API integration test state",
  },
  post: {
    method: "POST",
    path: "/api/test/slack-state",
    body: testSlackStatePostBodySchema,
    responses: {
      200: testSlackStatePostResponseSchema,
      400: testSlackStateErrorSchema,
      404: z.string(),
    },
    summary: "Seed Slack API integration test state",
  },
  delete: {
    method: "DELETE",
    path: "/api/test/slack-state",
    query: z.object({
      team_id: z.string().optional(),
      org_id: z.string().optional(),
    }),
    responses: {
      200: testSlackStateDeleteResponseSchema,
      400: testSlackStateErrorSchema,
      404: z.string(),
    },
    summary: "Clear Slack API integration test state",
  },
});

export type TestSlackStateContract = typeof testSlackStateContract;
export type TestSlackStateDeleteResponse = z.infer<
  typeof testSlackStateDeleteResponseSchema
>;
export type TestSlackStatePostBody = z.infer<
  typeof testSlackStatePostBodySchema
>;
export type TestSlackStatePostResponse = z.infer<
  typeof testSlackStatePostResponseSchema
>;
export type TestSlackStateResponse = z.infer<
  typeof testSlackStateResponseSchema
>;
