import {
  array,
  boolean,
  discriminatedUnion,
  literal,
  number,
  object,
  string,
  enum as zEnum,
  unknown as zUnknown,
  type infer as zInfer,
} from "zod";

import { OFFICIAL_TELEGRAM_BOT_ID } from "../validators/integrations-telegram";
import { authHeadersSchema, initContract } from "./base";
import { apiErrorSchema } from "./errors";

const c = initContract();

export { OFFICIAL_TELEGRAM_BOT_ID };

const telegramTokenStatusSchema = zEnum(["valid", "invalid", "unknown"]);

const telegramConnectedUserSchema = object({
  telegramUserId: string(),
  telegramUsername: string().nullable(),
  telegramDisplayName: string().nullable(),
});

const telegramBotSchema = object({
  id: string(),
  kind: literal("official").optional(),
  username: string().nullable(),
  avatarUrl: string().nullable(),
  agent: object({ id: string(), name: string() }).nullable(),
  isOwner: boolean(),
  isConnected: boolean(),
  connectedUser: telegramConnectedUserSchema.nullable().optional(),
  tokenStatus: telegramTokenStatusSchema,
  official: object({
    configured: boolean(),
    usesDefaultAgent: boolean(),
    linkedTelegramUserId: string().nullable(),
  }).optional(),
});

const telegramListResponseSchema = object({
  bots: array(telegramBotSchema),
});

const telegramLinkStatusResponseSchema = discriminatedUnion("linked", [
  object({
    linked: literal(true),
    telegramUserId: string(),
    botUsername: string().optional(),
  }),
  object({
    linked: literal(false),
    readinessError: zEnum([
      "bot_not_configured",
      "domain_not_verified",
      "domain_check_failed",
    ]).optional(),
    installation: object({
      id: string(),
      botUsername: string(),
      loginBotId: string().optional(),
      domainConfigured: boolean().optional(),
    }).optional(),
  }),
]);

const telegramConnectSignatureSchema = object({
  telegramUserId: string().min(1),
  telegramUsername: string().max(255).optional(),
  telegramDisplayName: string().max(255).optional(),
  timestamp: number(),
  signature: string().min(1),
});

const telegramAuthSchema = object({
  id: number(),
  first_name: string().optional(),
  last_name: string().optional(),
  username: string().optional(),
  photo_url: string().optional(),
  auth_date: number(),
  hash: string(),
});

const telegramLinkBodySchema = object({
  telegramBotId: string().min(1),
  telegramAuth: telegramAuthSchema.optional(),
  connectSignature: telegramConnectSignatureSchema.optional(),
});

const telegramLinkResponseSchema = object({
  botUsername: string(),
  telegramUserId: string(),
});

const telegramWebhookPathParamsSchema = object({
  telegramBotId: string().min(1),
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
    query: object({ botId: string().optional() }),
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
    query: object({
      botId: string().optional(),
      origin: string().optional(),
      source: zEnum(["onboarding", "works", "connect_page"]).optional(),
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
    pathParams: object({ botId: string().min(1) }),
    query: object({
      exp: string().optional(),
      sig: string().optional(),
    }),
    responses: {
      200: c.otherResponse({
        contentType: "application/octet-stream",
        body: zUnknown(),
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
    query: object({
      targetOrigin: string().optional(),
      // Validate explicit versions in the HTML boundary so rejected callbacks
      // can also scrub provider proof from browser history.
      callbackProtocol: string().optional(),
      operationId: string().optional(),
      bot: string().optional(),
    }),
    responses: {
      200: c.otherResponse({
        contentType: "text/html",
        body: zUnknown(),
      }),
      400: c.otherResponse({
        contentType: "text/plain",
        body: string(),
      }),
      // Explicit v2 context errors render guidance and scrub provider proof.
      422: c.otherResponse({
        contentType: "text/html",
        body: string(),
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
    body: zUnknown(),
    responses: {
      200: c.otherResponse({
        contentType: "text/plain",
        body: string(),
      }),
      400: c.otherResponse({
        contentType: "text/plain",
        body: string(),
      }),
      401: c.otherResponse({
        contentType: "text/plain",
        body: string(),
      }),
      404: c.otherResponse({
        contentType: "text/plain",
        body: string(),
      }),
    },
    summary: "Handle Telegram bot webhook updates",
  },
});

export type IntegrationsTelegramContract = typeof integrationsTelegramContract;
export type TelegramBot = zInfer<typeof telegramBotSchema>;
export type TelegramBotStatus = zInfer<typeof telegramBotSchema> & {
  readonly domainConfigured: boolean;
  readonly environment: {
    readonly requiredSecrets: string[];
    readonly requiredVars: string[];
    readonly missingSecrets: string[];
    readonly missingVars: string[];
  };
};
export type TelegramListResponse = zInfer<typeof telegramListResponseSchema>;
export type TelegramLinkStatusResponse = zInfer<
  typeof telegramLinkStatusResponseSchema
>;

// The authenticated initiating App owns binding. These messages carry no
// redirect URL, session token or claim that provider consent itself linked.
export const TELEGRAM_AUTH_CALLBACK_OUTCOMES = [
  "linked",
  "cancelled",
  "failed",
  "conflict",
  "expired",
  "interrupted",
  "prerequisite",
] as const;

type TelegramAuthCallbackContext = {
  readonly protocol: 2;
  readonly operationId: string;
  readonly bot: typeof OFFICIAL_TELEGRAM_BOT_ID;
};

export type TelegramAuthCallbackMessage = TelegramAuthCallbackContext &
  (
    | { readonly type: "telegram-auth-bridge-ready" | "telegram-auth-ready" }
    | {
        readonly type: "telegram-auth";
        readonly data: Readonly<
          Record<"id" | "auth_date" | "hash", string> &
            Partial<
              Record<
                "first_name" | "last_name" | "username" | "photo_url",
                string
              >
            >
        >;
      }
    | {
        readonly type: "telegram-auth-ack";
        readonly stage: "identity" | "result";
      }
    | {
        readonly type: "telegram-auth-result";
        readonly status: (typeof TELEGRAM_AUTH_CALLBACK_OUTCOMES)[number];
      }
  );
