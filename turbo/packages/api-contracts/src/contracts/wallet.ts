import {
  array,
  boolean,
  coerce,
  discriminatedUnion,
  iso,
  literal,
  number,
  object,
  record,
  string,
  uuid,
  enum as zEnum,
  url as zUrl,
  type infer as zInfer,
} from "zod";

import { authHeadersSchema, initContract } from "./base";
import { apiErrorSchema } from "./errors";
import { connectorOauthCallbackResultSchema } from "./connectors-slug-callback";
import { scopeDiffResponseSchema } from "./connector-schemas";

const c = initContract();

export const walletConnectStatusSchema = discriminatedUnion("status", [
  object({ status: literal("authorized"), authorizationId: uuid() }),
  object({
    status: zEnum(["pending", "expired", "failed", "unavailable"]),
  }),
]);
export type WalletConnectStatus = zInfer<typeof walletConnectStatusSchema>;

export const walletSpendStatusSchema = zEnum([
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

export const walletCreateSpendSchema = object({
  intentId: uuid(),
  amount: number().int().positive().max(2_147_483_647),
  currency: literal("usd").default("usd"),
  merchantName: string().trim().min(1).max(256),
  merchantUrl: zUrl().refine((value) => {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password;
  }, "Merchant URL must use HTTPS without credentials"),
  context: string().trim().min(100).max(2000),
  test: boolean().default(false),
});

export const walletAuthorizationDetailsSchema = array(
  object({
    type: string(),
    actions: array(string()),
  }),
);

const walletPaymentSchema = object({
  outcome: string(),
  amount: number().int().safe(),
  currency: string(),
  code: string().nullable().optional(),
  declineCode: string().nullable().optional(),
  created: number().nullable().optional(),
  refund: object({
    amount: number().int().safe(),
    currency: string(),
    state: string(),
    created: number(),
  })
    .nullable()
    .optional(),
});

const walletDateFilters = {
  startDate: iso.date().optional(),
  endDate: iso.date().optional(),
};
function orderedDates(value: { startDate?: string; endDate?: string }) {
  return !value.startDate || !value.endDate || value.startDate <= value.endDate;
}
export const walletSpendListQuerySchema = object({
  ...walletDateFilters,
  limit: coerce.number().int().min(1).max(100).optional(),
  startingAfter: uuid().optional(),
  status: walletSpendStatusSchema.optional(),
  mode: zEnum(["all", "live", "test"]).optional(),
})
  .strict()
  .refine(orderedDates, "startDate must not be after endDate");
export type WalletSpendListQuery = zInfer<typeof walletSpendListQuerySchema>;

const walletProviderIdSchema = string().regex(/^[A-Za-z0-9_-]{1,256}$/);
export const walletTransactionsQuerySchema = object({
  ...walletDateFilters,
  origin: literal("link").optional(),
  category: string().min(1).max(100).optional(),
  limit: coerce.number().int().min(1).max(100).optional(),
  startingAfter: walletProviderIdSchema.optional(),
})
  .strict()
  .refine(orderedDates, "startDate must not be after endDate");
export type WalletTransactionsQuery = zInfer<
  typeof walletTransactionsQuerySchema
>;

export const walletTransactionSchema = object({
  id: walletProviderIdSchema,
  sourceId: string().nullable(),
  amount: number().int().safe(),
  currency: string(),
  date: iso.date(),
  description: string(),
  origin: literal("link"),
  category: string().nullable(),
  status: string(),
});
export type WalletTransaction = zInfer<typeof walletTransactionSchema>;

export const walletPaymentMethodSchema = object({
  id: walletProviderIdSchema,
  type: string(),
  name: string(),
  nickname: string().nullable().optional(),
  isDefault: boolean(),
  card: object({
    brand: string(),
    last4: string().regex(/^\d{4}$/),
    expMonth: number().int().min(1).max(12),
    expYear: number().int(),
  })
    .nullable()
    .optional(),
  bankAccount: object({
    last4: string().regex(/^\d{4}$/),
    bankName: string().nullable().optional(),
  })
    .nullable()
    .optional(),
  capabilities: record(
    string(),
    object({
      eligible: boolean(),
      ineligibilityReasons: array(string()),
    }),
  )
    .nullable()
    .optional(),
});
export type WalletPaymentMethod = zInfer<typeof walletPaymentMethodSchema>;

const walletLimitSchema = object({
  limit: number().int().nullable(),
  used: number().int().optional(),
  remaining: number().int().nullable().optional(),
});
export const walletUserInfoSchema = object({
  id: string().optional(),
  name: string().nullable().optional(),
  email: string().nullable().optional(),
  defaultCurrency: string().optional(),
  spendLimits: object({
    perTransaction: walletLimitSchema,
    daily: walletLimitSchema,
    thirtyDay: walletLimitSchema,
  }).optional(),
  verification: object({
    status: string(),
    actionUrl: zUrl().nullable(),
  }).optional(),
});

export const walletSpendSchema = object({
  id: uuid(),
  intentId: uuid(),
  status: walletSpendStatusSchema,
  amount: number().int(),
  currency: literal("usd"),
  merchantName: string(),
  merchantUrl: zUrl(),
  context: string(),
  test: boolean(),
  createdAt: iso.datetime(),
  payment: walletPaymentSchema.nullable().optional(),
  paymentHistory: array(walletPaymentSchema).optional(),
  approvalUrl: zUrl().nullable(),
  expiresAt: iso.datetime(),
  // A watch is bounded by expiresAt, never a payment promise.
  autoContinue: boolean(),
  nextAction: zEnum([
    "wait_for_user",
    "check_status",
    "retrieve_credentials",
    "payment_pending",
    "verify_order",
    "stop",
    "new_approval_required",
  ]),
  action: object({
    type: string(),
    resolution: zEnum([
      "auto_resume",
      "create_new_spend_request",
      "create_new_spend_request_after_completion",
    ]),
    url: zUrl().nullable(),
  }).nullable(),
});

export type WalletCreateSpend = zInfer<typeof walletCreateSpendSchema>;
export type WalletSpend = zInfer<typeof walletSpendSchema>;

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
  .extend({ createdAt: iso.datetime() });
export type WalletPurchaseHistoryEntry = zInfer<
  typeof walletPurchaseHistoryEntrySchema
>;

export const walletCardSchema = object({
  brand: string().regex(/^[a-zA-Z_-]{1,32}$/),
  number: string().regex(/^\d{12,19}$/),
  cvc: string()
    .regex(/^\d{3,4}$/)
    .optional(),
  expMonth: number().int().min(1).max(12),
  expYear: number().int().min(2000).max(9999),
  billingAddress: object({
    name: string(),
    line1: string(),
    line2: string().optional(),
    city: string().optional(),
    state: string().optional(),
    postalCode: string().optional(),
    country: string().regex(/^[A-Z]{2}$/),
  }).optional(),
  validUntil: iso.datetime({ offset: true }).optional(),
});

export const walletSpendCredentialsSchema = object({
  spend: walletSpendSchema.extend({ status: literal("approved") }),
  card: walletCardSchema,
});
export type WalletSpendCredentials = zInfer<
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
const spendParams = object({ id: uuid() });

export const walletContract = c.router({
  status: {
    method: "GET",
    path: "/api/wallet/status",
    headers: authHeadersSchema,
    responses: {
      200: object({
        connected: boolean(),
        // Purchase readiness retains the enum understood by captured CLI builds.
        // Read availability is expressed by the additive authorization fields.
        nextAction: zEnum(["connect", "create_spend"]),
        authorization: object({
          known: boolean(),
          scopes: array(string()),
          sourceActions: array(string()),
          capabilities: object({
            payments: boolean(),
            spendHistory: boolean(),
            paymentMethods: boolean(),
            userInfo: boolean(),
            transactions: boolean(),
          }),
          missingPermissions: array(string()),
        }),
        checkoutAvailable: literal(false),
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
    body: object({}).strict(),
    responses: {
      200: object({ url: zUrl(), expiresAt: iso.datetime() }),
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
    body: object({}),
    responses: {
      200: object({ disconnected: literal(true) }),
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
    query: object({}).strict(),
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
      200: object({
        data: array(
          object({
            id: uuid(),
            status: walletSpendStatusSchema,
            amount: number().int(),
            currency: literal("usd"),
            merchantName: string(),
            test: boolean(),
            createdAt: iso.datetime(),
            statusSource: literal("recorded"),
            canRefresh: boolean(),
          }),
        ),
        hasMore: boolean(),
        nextCursor: uuid().nullable(),
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
      200: object({
        data: array(walletTransactionSchema),
        hasMore: boolean().nullable(),
        nextCursor: walletProviderIdSchema.nullable(),
      }),
    },
  },
  paymentMethods: {
    method: "GET",
    path: "/api/wallet/payment-methods",
    headers: authHeadersSchema,
    query: object({}).strict(),
    responses: {
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
      409: apiErrorSchema,
      502: apiErrorSchema,
      503: apiErrorSchema,
      200: object({ data: array(walletPaymentMethodSchema) }),
    },
  },
  paymentMethod: {
    method: "GET",
    path: "/api/wallet/payment-methods/:id",
    headers: authHeadersSchema,
    pathParams: object({ id: walletProviderIdSchema }),
    query: object({}).strict(),
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
    query: object({}).strict(),
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
    body: object({}),
    responses: walletSpendResponses,
  },
  spendCredentials: {
    method: "POST",
    path: "/api/wallet/spend/:id/credentials",
    headers: authHeadersSchema,
    pathParams: spendParams,
    body: object({}).strict(),
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
    query: object({
      state: string().min(43).max(128),
      code: string().min(1).max(8192).optional(),
      error: string().max(256).optional(),
      responseMode: literal("json").optional(),
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
    body: object({
      agentId: uuid(),
      threadId: uuid(),
      approvalUrl: zUrl().max(8192),
    }),
    responses: {
      200: object({
        status: zEnum([
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
    query: object({
      cursor: uuid().optional(),
      limit: coerce.number().int().min(1).max(100).default(20),
    }),
    responses: {
      200: object({
        transactions: array(walletPurchaseHistoryEntrySchema),
        nextCursor: uuid().nullable(),
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
        revocationPending: boolean(),
        connectionStatus: zEnum([
          "not-connected",
          "connected",
          "reconnect-required",
          "scope-mismatch",
        ]),
        scopeChange: scopeDiffResponseSchema
          .extend({
            reason: literal("permissions_changed"),
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
    body: object({
      agentId: uuid().optional(),
      state: string().min(43).max(128),
    }),
    responses: {
      200: walletConnectStatusSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
    },
  },
});

export type WalletConnectionStatus = zInfer<
  (typeof walletUserContract.status.responses)[200]
>;
