import { z } from "zod";

import { authHeadersSchema, initContract } from "./base";
import { apiErrorSchema } from "./errors";
import { connectorOauthCallbackResultSchema } from "./connectors-slug-callback";
import { scopeDiffResponseSchema } from "./connector-schemas";

const c = initContract();

export const walletConnectStatusSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("authorized"), authorizationId: z.uuid() }),
  z.object({
    status: z.enum(["pending", "expired", "failed", "unavailable"]),
  }),
]);
export type WalletConnectStatus = z.infer<typeof walletConnectStatusSchema>;

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

// Retain explicit modes for captured older CLI builds until their Runner and
// rollback artifacts are retired (#40206). Current clients use unified consent.
export const walletConnectSchema = z
  .object({
    readOnly: z.boolean().optional(),
    transactions: z.boolean().optional(),
  })
  .strict();
export type WalletConnect = z.infer<typeof walletConnectSchema>;

export const walletAuthorizationDetailsSchema = z.array(
  z.object({
    type: z.string(),
    actions: z.array(z.string()),
  }),
);

const walletPaymentSchema = z.object({
  outcome: z.string(),
  amount: z.number().int().safe(),
  currency: z.string(),
  code: z.string().nullable().optional(),
  declineCode: z.string().nullable().optional(),
  created: z.number().nullable().optional(),
  refund: z
    .object({
      amount: z.number().int().safe(),
      currency: z.string(),
      state: z.string(),
      created: z.number(),
    })
    .nullable()
    .optional(),
});

const walletDateFilters = {
  startDate: z.iso.date().optional(),
  endDate: z.iso.date().optional(),
};
function orderedDates(value: { startDate?: string; endDate?: string }) {
  return !value.startDate || !value.endDate || value.startDate <= value.endDate;
}
export const walletSpendListQuerySchema = z
  .object({
    ...walletDateFilters,
    limit: z.coerce.number().int().min(1).max(100).optional(),
    startingAfter: z.uuid().optional(),
    status: walletSpendStatusSchema.optional(),
    mode: z.enum(["all", "live", "test"]).optional(),
  })
  .strict()
  .refine(orderedDates, "startDate must not be after endDate");
export type WalletSpendListQuery = z.infer<typeof walletSpendListQuerySchema>;

const walletProviderIdSchema = z.string().regex(/^[A-Za-z0-9_-]{1,256}$/);
export const walletTransactionsQuerySchema = z
  .object({
    ...walletDateFilters,
    origin: z.literal("link").optional(),
    category: z.string().min(1).max(100).optional(),
    limit: z.coerce.number().int().min(1).max(100).optional(),
    startingAfter: walletProviderIdSchema.optional(),
  })
  .strict()
  .refine(orderedDates, "startDate must not be after endDate");
export type WalletTransactionsQuery = z.infer<
  typeof walletTransactionsQuerySchema
>;

export const walletTransactionSchema = z.object({
  id: walletProviderIdSchema,
  sourceId: z.string().nullable(),
  amount: z.number().int().safe(),
  currency: z.string(),
  date: z.iso.date(),
  description: z.string(),
  origin: z.literal("link"),
  category: z.string().nullable(),
  status: z.string(),
});
export type WalletTransaction = z.infer<typeof walletTransactionSchema>;

export const walletPaymentMethodSchema = z.object({
  id: walletProviderIdSchema,
  type: z.string(),
  name: z.string(),
  nickname: z.string().nullable().optional(),
  isDefault: z.boolean(),
  card: z
    .object({
      brand: z.string(),
      last4: z.string().regex(/^\d{4}$/),
      expMonth: z.number().int().min(1).max(12),
      expYear: z.number().int(),
    })
    .nullable()
    .optional(),
  bankAccount: z
    .object({
      last4: z.string().regex(/^\d{4}$/),
      bankName: z.string().nullable().optional(),
    })
    .nullable()
    .optional(),
  capabilities: z
    .record(
      z.string(),
      z.object({
        eligible: z.boolean(),
        ineligibilityReasons: z.array(z.string()),
      }),
    )
    .nullable()
    .optional(),
});
export type WalletPaymentMethod = z.infer<typeof walletPaymentMethodSchema>;

const walletLimitSchema = z.object({
  limit: z.number().int().nullable(),
  used: z.number().int().optional(),
  remaining: z.number().int().nullable().optional(),
});
export const walletUserInfoSchema = z.object({
  id: z.string().optional(),
  name: z.string().nullable().optional(),
  email: z.string().nullable().optional(),
  defaultCurrency: z.string().optional(),
  spendLimits: z
    .object({
      perTransaction: walletLimitSchema,
      daily: walletLimitSchema,
      thirtyDay: walletLimitSchema,
    })
    .optional(),
  verification: z
    .object({
      status: z.string(),
      actionUrl: z.url().nullable(),
    })
    .optional(),
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
  createdAt: z.iso.datetime(),
  payment: walletPaymentSchema.nullable().optional(),
  paymentHistory: z.array(walletPaymentSchema).optional(),
  approvalUrl: z.url().nullable(),
  expiresAt: z.iso.datetime(),
  // Absent on older APIs. A watch is bounded by expiresAt, never a payment promise.
  autoContinue: z.boolean().optional(),
  nextAction: z.enum([
    "wait_for_user",
    "check_status",
    "retrieve_credentials",
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

// A history entry deliberately excludes approval links and payment credentials.
export const walletPurchaseHistoryEntrySchema = walletSpendSchema
  .pick({
    id: true,
    status: true,
    amount: true,
    currency: true,
    merchantName: true,
    test: true,
  })
  .extend({ createdAt: z.iso.datetime() });
export type WalletPurchaseHistoryEntry = z.infer<
  typeof walletPurchaseHistoryEntrySchema
>;

export const walletCardSchema = z.object({
  brand: z.string().regex(/^[a-zA-Z_-]{1,32}$/),
  number: z.string().regex(/^\d{12,19}$/),
  cvc: z
    .string()
    .regex(/^\d{3,4}$/)
    .optional(),
  expMonth: z.number().int().min(1).max(12),
  expYear: z.number().int().min(2000).max(9999),
  billingAddress: z
    .object({
      name: z.string(),
      line1: z.string(),
      line2: z.string().optional(),
      city: z.string().optional(),
      state: z.string().optional(),
      postalCode: z.string().optional(),
      country: z.string().regex(/^[A-Z]{2}$/),
    })
    .optional(),
  validUntil: z.iso.datetime({ offset: true }).optional(),
});

export const walletSpendCredentialsSchema = z.object({
  spend: walletSpendSchema.extend({ status: z.literal("approved") }),
  card: walletCardSchema,
});
export type WalletSpendCredentials = z.infer<
  typeof walletSpendCredentialsSchema
>;

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
        // Purchase readiness retains the enum understood by captured CLI builds.
        // Read availability is expressed by the additive authorization fields.
        nextAction: z.enum(["connect", "create_spend"]),
        authorization: z.object({
          known: z.boolean(),
          scopes: z.array(z.string()),
          sourceActions: z.array(z.string()),
          capabilities: z.object({
            payments: z.boolean(),
            spendHistory: z.boolean(),
            paymentMethods: z.boolean(),
            userInfo: z.boolean(),
            transactions: z.boolean(),
          }),
          missingPermissions: z.array(z.string()),
        }),
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
    body: walletConnectSchema,
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
  listSpends: {
    method: "GET",
    path: "/api/wallet/spend",
    headers: authHeadersSchema,
    query: walletSpendListQuerySchema,
    responses: {
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
      409: apiErrorSchema,
      502: apiErrorSchema,
      503: apiErrorSchema,
      200: z.object({
        data: z.array(
          z.object({
            id: z.uuid(),
            status: walletSpendStatusSchema,
            amount: z.number().int(),
            currency: z.literal("usd"),
            merchantName: z.string(),
            test: z.boolean(),
            createdAt: z.iso.datetime(),
            statusSource: z.literal("recorded"),
            canRefresh: z.boolean(),
          }),
        ),
        hasMore: z.boolean(),
        nextCursor: z.uuid().nullable(),
      }),
    },
  },
  transactions: {
    method: "GET",
    path: "/api/wallet/transactions",
    headers: authHeadersSchema,
    query: walletTransactionsQuerySchema,
    responses: {
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
      409: apiErrorSchema,
      502: apiErrorSchema,
      503: apiErrorSchema,
      200: z.object({
        data: z.array(walletTransactionSchema),
        hasMore: z.boolean().nullable(),
        nextCursor: walletProviderIdSchema.nullable(),
      }),
    },
  },
  paymentMethods: {
    method: "GET",
    path: "/api/wallet/payment-methods",
    headers: authHeadersSchema,
    query: z.object({}).strict(),
    responses: {
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
      409: apiErrorSchema,
      502: apiErrorSchema,
      503: apiErrorSchema,
      200: z.object({ data: z.array(walletPaymentMethodSchema) }),
    },
  },
  paymentMethod: {
    method: "GET",
    path: "/api/wallet/payment-methods/:id",
    headers: authHeadersSchema,
    pathParams: z.object({ id: walletProviderIdSchema }),
    query: z.object({}).strict(),
    responses: {
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
      409: apiErrorSchema,
      502: apiErrorSchema,
      503: apiErrorSchema,
      200: walletPaymentMethodSchema,
    },
  },
  userInfo: {
    method: "GET",
    path: "/api/wallet/user-info",
    headers: authHeadersSchema,
    query: z.object({}).strict(),
    responses: {
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
      409: apiErrorSchema,
      502: apiErrorSchema,
      503: apiErrorSchema,
      200: walletUserInfoSchema,
    },
  },
  cancelSpend: {
    method: "POST",
    path: "/api/wallet/spend/:id/cancel",
    headers: authHeadersSchema,
    pathParams: spendParams,
    body: z.object({}),
    responses: walletSpendResponses,
  },
  spendCredentials: {
    method: "POST",
    path: "/api/wallet/spend/:id/credentials",
    headers: authHeadersSchema,
    pathParams: spendParams,
    body: z.object({}).strict(),
    responses: {
      200: c.otherResponse({
        contentType: "application/octet-stream",
        body: c.type<Blob>(),
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

export const walletUserContract = c.router({
  paymentMethods: {
    ...walletContract.paymentMethods,
    path: "/api/wallet/connection/payment-methods",
  },
  spendStatus: {
    method: "POST",
    path: "/api/wallet/spend/status",
    headers: authHeadersSchema,
    body: z.object({
      agentId: z.uuid(),
      threadId: z.uuid(),
      approvalUrl: z.url().max(8192),
    }),
    responses: {
      200: z.object({
        status: z.enum([
          "pending",
          "approved",
          "continued",
          "stopped",
          "unavailable",
        ]),
      }),
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
    },
  },
  activity: {
    ...walletContract.transactions,
    path: "/api/wallet/connection/transactions",
  },
  transactions: {
    method: "GET",
    path: "/api/wallet/purchases",
    headers: authHeadersSchema,
    query: z.object({
      cursor: z.uuid().optional(),
      limit: z.coerce.number().int().min(1).max(100).default(20),
    }),
    responses: {
      200: z.object({
        transactions: z.array(walletPurchaseHistoryEntrySchema),
        nextCursor: z.uuid().nullable(),
      }),
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
    },
  },
  status: {
    ...walletContract.status,
    path: "/api/wallet/connection",
    responses: {
      ...walletContract.status.responses,
      200: walletContract.status.responses[200].extend({
        revocationPending: z.boolean(),
        connectionStatus: z.enum([
          "not-connected",
          "connected",
          "reconnect-required",
          "scope-mismatch",
        ]),
        scopeChange: scopeDiffResponseSchema
          .extend({
            reason: z.literal("permissions_changed"),
          })
          .nullable(),
      }),
    },
  },
  connect: {
    ...walletContract.connect,
    path: "/api/wallet/connection/connect",
  },
  disconnect: {
    ...walletContract.disconnect,
    path: "/api/wallet/connection/disconnect",
  },
  connectStatus: {
    method: "POST",
    path: "/api/wallet/connect/status",
    headers: authHeadersSchema,
    body: z.object({
      agentId: z.uuid().optional(),
      state: z.string().min(43).max(128),
    }),
    responses: {
      200: walletConnectStatusSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
    },
  },
});

export type WalletConnectionStatus = z.infer<
  (typeof walletUserContract.status.responses)[200]
>;
