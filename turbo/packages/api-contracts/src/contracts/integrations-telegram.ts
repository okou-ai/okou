import { z } from "zod";
import { authHeadersSchema, initContract } from "./base";
import { apiErrorSchema } from "./errors";

const c = initContract();

export const OFFICIAL_TELEGRAM_BOT_ID = "official" as const;

const telegramTokenStatusSchema = z.enum(["valid", "invalid", "unknown"]);

const telegramConnectedUserSchema = z.object({
  telegramUserId: z.string(),
  telegramUsername: z.string().nullable(),
  telegramDisplayName: z.string().nullable(),
});

const telegramBotSchema = z.object({
  id: z.string(),
  kind: z.literal("official").optional(),
  username: z.string().nullable(),
  avatarUrl: z.string().nullable(),
  agent: z.object({ id: z.string(), name: z.string() }).nullable(),
  isOwner: z.boolean(),
  isConnected: z.boolean(),
  connectedUser: telegramConnectedUserSchema.nullable().optional(),
  tokenStatus: telegramTokenStatusSchema,
  official: z
    .object({
      configured: z.boolean(),
      usesDefaultAgent: z.boolean(),
      linkedTelegramUserId: z.string().nullable(),
    })
    .optional(),
});

const telegramListResponseSchema = z.object({
  bots: z.array(telegramBotSchema),
});

const telegramLinkStatusResponseSchema = z.discriminatedUnion("linked", [
  z.object({
    linked: z.literal(true),
    telegramUserId: z.string(),
    botUsername: z.string().optional(),
  }),
  z.object({
    linked: z.literal(false),
    installation: z
      .object({
        id: z.string(),
        botUsername: z.string(),
        loginBotId: z.string().optional(),
        domainConfigured: z.boolean().optional(),
      })
      .optional(),
  }),
]);

const telegramConnectSignatureSchema = z.object({
  telegramUserId: z.string().min(1),
  telegramUsername: z.string().max(255).optional(),
  telegramDisplayName: z.string().max(255).optional(),
  timestamp: z.number(),
  signature: z.string().min(1),
});

const telegramAuthSchema = z.object({
  id: z.number(),
  first_name: z.string().optional(),
  last_name: z.string().optional(),
  username: z.string().optional(),
  photo_url: z.string().optional(),
  auth_date: z.number(),
  hash: z.string(),
});

const telegramLinkBodySchema = z.object({
  telegramBotId: z.string().min(1),
  telegramAuth: telegramAuthSchema.optional(),
  connectSignature: telegramConnectSignatureSchema.optional(),
});

const telegramLinkResponseSchema = z.object({
  botUsername: z.string(),
  telegramUserId: z.string(),
});

const telegramWebhookPathParamsSchema = z.object({
  telegramBotId: z.string().min(1),
});

/**
 * Integrations Telegram contract
 * Covers all Telegram integration endpoints.
 *
 * These endpoints use the current /api/integrations/ and /api/telegram/ paths.
 */
export const integrationsTelegramContract = c.router({
  list: {
    method: "GET",
    path: "/api/integrations/telegram",
    headers: authHeadersSchema,
    responses: {
      200: telegramListResponseSchema,
      401: apiErrorSchema,
    },
    summary: "List Telegram bot integrations in the authenticated user's org",
  },
  unlink: {
    method: "DELETE",
    path: "/api/integrations/telegram/link",
    headers: authHeadersSchema,
    body: c.noBody(),
    query: z.object({ botId: z.string().optional() }),
    responses: {
      204: c.noBody(),
      401: apiErrorSchema,
      404: apiErrorSchema,
    },
    summary: "Disconnect the authenticated user's Telegram account link",
  },
  getLinkStatus: {
    method: "GET",
    path: "/api/integrations/telegram/link",
    headers: authHeadersSchema,
    query: z.object({
      botId: z.string().optional(),
      origin: z.string().optional(),
    }),
    responses: {
      200: telegramLinkStatusResponseSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
    },
    summary: "Check if the authenticated user is linked to a Telegram bot",
  },
  avatar: {
    method: "GET",
    path: "/api/integrations/telegram/:botId/avatar",
    headers: authHeadersSchema,
    pathParams: z.object({ botId: z.string().min(1) }),
    query: z.object({
      exp: z.string().optional(),
      sig: z.string().optional(),
    }),
    responses: {
      200: c.otherResponse({
        contentType: "application/octet-stream",
        body: z.unknown(),
      }),
      401: apiErrorSchema,
      404: apiErrorSchema,
      413: apiErrorSchema,
      502: apiErrorSchema,
    },
    summary: "Proxy a Telegram bot avatar",
  },
  authCallback: {
    method: "GET",
    path: "/api/integrations/telegram/auth-callback",
    query: z.object({ targetOrigin: z.string().optional() }),
    responses: {
      200: c.otherResponse({
        contentType: "text/html",
        body: z.unknown(),
      }),
      400: c.otherResponse({
        contentType: "text/plain",
        body: z.string(),
      }),
    },
    summary: "Return the Telegram auth callback bridge page",
  },
  link: {
    method: "POST",
    path: "/api/integrations/telegram/link",
    headers: authHeadersSchema,
    body: telegramLinkBodySchema,
    responses: {
      200: telegramLinkResponseSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
      409: apiErrorSchema,
    },
    summary: "Link the authenticated product user to a Telegram user",
  },
  webhook: {
    method: "POST",
    path: "/api/telegram/webhook/:telegramBotId",
    pathParams: telegramWebhookPathParamsSchema,
    body: z.unknown(),
    responses: {
      200: c.otherResponse({
        contentType: "text/plain",
        body: z.string(),
      }),
      400: c.otherResponse({
        contentType: "text/plain",
        body: z.string(),
      }),
      401: c.otherResponse({
        contentType: "text/plain",
        body: z.string(),
      }),
      404: c.otherResponse({
        contentType: "text/plain",
        body: z.string(),
      }),
    },
    summary: "Handle Telegram bot webhook updates",
  },
});

export type IntegrationsTelegramContract = typeof integrationsTelegramContract;
export type TelegramBot = z.infer<typeof telegramBotSchema>;
export type TelegramBotStatus = z.infer<typeof telegramBotSchema> & {
  readonly domainConfigured: boolean;
  readonly environment: {
    readonly requiredSecrets: string[];
    readonly requiredVars: string[];
    readonly missingSecrets: string[];
    readonly missingVars: string[];
  };
};
export type TelegramListResponse = z.infer<typeof telegramListResponseSchema>;
export type TelegramLinkStatusResponse = z.infer<
  typeof telegramLinkStatusResponseSchema
>;
