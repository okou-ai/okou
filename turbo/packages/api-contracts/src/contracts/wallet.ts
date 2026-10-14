import { z } from "zod";

import { authHeadersSchema, initContract } from "./base";
import { apiErrorSchema } from "./errors";
import { connectorOauthCallbackResultSchema } from "./connectors-slug-callback";

const c = initContract();

export const walletConnectStatusSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("authorized"), authorizationId: z.uuid() }),
  z.object({
    status: z.enum(["pending", "expired", "failed", "unavailable"]),
  }),
]);
export type WalletConnectStatus = z.infer<typeof walletConnectStatusSchema>;

export const walletUserContract = c.router({
  connectStatus: {
    method: "POST",
    path: "/api/wallet/connect/status",
    headers: authHeadersSchema,
    body: z.object({ agentId: z.uuid(), state: z.string().min(43).max(128) }),
    responses: {
      200: walletConnectStatusSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
    },
  },
});

export const walletSpendStatusSchema = z.enum([
  "creating",
  "created",
  "pending_approval",
  "requires_action",
  "approved",
  "submitted",
  "succeeded",
  "failed",
  "denied",
  "expired",
  "canceled",
]);

export const walletCreateSpendSchema = z.object({
  intentId: z.uuid(),
  amount: z.number().int().positive().max(2_147_483_647),
  currency: z.literal("usd").default("usd"),
  merchantName: z.string().trim().min(1).max(256),
  merchantUrl: z.url().refine((value) => {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password;
  }, "Merchant URL must use HTTPS without credentials"),
  context: z.string().trim().min(100).max(2000),
  test: z.boolean().default(false),
});

export const walletSpendSchema = z.object({
  id: z.uuid(),
  intentId: z.uuid(),
  status: walletSpendStatusSchema,
  amount: z.number().int(),
  currency: z.literal("usd"),
  merchantName: z.string(),
  merchantUrl: z.url(),
  context: z.string(),
  test: z.boolean(),
  approvalUrl: z.url().nullable(),
  expiresAt: z.iso.datetime(),
  nextAction: z.enum([
    "wait_for_user",
    "check_status",
    "secure_checkout_unavailable",
    "payment_pending",
    "verify_order",
    "stop",
    "new_approval_required",
  ]),
  action: z
    .object({
      type: z.string(),
      resolution: z.enum([
        "auto_resume",
        "create_new_spend_request",
        "create_new_spend_request_after_completion",
      ]),
      url: z.url().nullable(),
    })
    .nullable(),
});

export type WalletCreateSpend = z.infer<typeof walletCreateSpendSchema>;
export type WalletSpend = z.infer<typeof walletSpendSchema>;

const walletSpendResponses = {
  200: walletSpendSchema,
  400: apiErrorSchema,
  401: apiErrorSchema,
  403: apiErrorSchema,
  404: apiErrorSchema,
  409: apiErrorSchema,
  502: apiErrorSchema,
  503: apiErrorSchema,
} as const;
const spendParams = z.object({ id: z.uuid() });

export const walletContract = c.router({
  status: {
    method: "GET",
    path: "/api/wallet/status",
    headers: authHeadersSchema,
    responses: {
      200: z.object({
        connected: z.boolean(),
        nextAction: z.enum(["connect", "create_spend"]),
        checkoutAvailable: z.literal(false),
      }),
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
      409: apiErrorSchema,
      502: apiErrorSchema,
      503: apiErrorSchema,
    },
  },
  connect: {
    method: "POST",
    path: "/api/wallet/connect",
    headers: authHeadersSchema,
    body: z.object({}),
    responses: {
      200: z.object({ url: z.url(), expiresAt: z.iso.datetime() }),
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
      409: apiErrorSchema,
      502: apiErrorSchema,
      503: apiErrorSchema,
    },
  },
  disconnect: {
    method: "POST",
    path: "/api/wallet/disconnect",
    headers: authHeadersSchema,
    body: z.object({}),
    responses: {
      200: z.object({ disconnected: z.literal(true) }),
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
      409: apiErrorSchema,
      502: apiErrorSchema,
      503: apiErrorSchema,
    },
  },
  createSpend: {
    method: "POST",
    path: "/api/wallet/spend",
    headers: authHeadersSchema,
    body: walletCreateSpendSchema,
    responses: walletSpendResponses,
  },
  getSpend: {
    method: "GET",
    path: "/api/wallet/spend/:id",
    headers: authHeadersSchema,
    pathParams: spendParams,
    query: z.object({}).strict(),
    responses: walletSpendResponses,
  },
  cancelSpend: {
    method: "POST",
    path: "/api/wallet/spend/:id/cancel",
    headers: authHeadersSchema,
    pathParams: spendParams,
    body: z.object({}),
    responses: walletSpendResponses,
  },
});

// The registered App callback keeps its existing URL and rendering contract.
export const walletCallbackContract = c.router({
  callback: {
    method: "GET",
    path: "/api/connectors/link/callback",
    headers: authHeadersSchema,
    query: z.object({
      state: z.string().min(43).max(128),
      code: z.string().min(1).max(8192).optional(),
      error: z.string().max(256).optional(),
      responseMode: z.literal("json").optional(),
    }),
    responses: {
      200: connectorOauthCallbackResultSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
      409: apiErrorSchema,
      502: apiErrorSchema,
      503: apiErrorSchema,
    },
  },
});
