import * as z from "zod";

import { authHeadersSchema, initContract } from "./base";
import { apiErrorSchema } from "./errors";

const c = initContract();

const dateOnlySchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Date must be formatted as YYYY-MM-DD");

export const bankingProviderSchema = z.literal("finicity");

export const bankingAccountSchema = z.object({
  id: z.string(),
  name: z.string().nullable(),
  institutionName: z.string().nullable(),
  type: z.string().nullable(),
  last4: z.string().nullable(),
  status: z.string().nullable(),
  currency: z.string().nullable(),
});

export const bankingBalanceSchema = z.object({
  accountId: z.string(),
  name: z.string().nullable(),
  type: z.string().nullable(),
  balance: z.number().nullable(),
  availableBalance: z.number().nullable(),
  currency: z.string().nullable(),
  balanceDate: z.number().nullable(),
});

export const bankingTransactionSchema = z.object({
  id: z.string(),
  accountId: z.string(),
  amount: z.number().nullable(),
  description: z.string().nullable(),
  memo: z.string().nullable(),
  postedDate: z.number().nullable(),
  transactionDate: z.number().nullable(),
  status: z.string().nullable(),
  categorization: z.string().nullable(),
  merchant: z.string().nullable(),
});

export const bankingAccountsResponseSchema = z.object({
  operation: z.literal("accounts"),
  provider: bankingProviderSchema,
  accounts: z.array(bankingAccountSchema),
});

export const bankingBalancesRequestSchema = z.object({
  accountId: z.string().trim().min(1),
});

export const bankingBalancesResponseSchema = z.object({
  operation: z.literal("balances"),
  provider: bankingProviderSchema,
  balance: bankingBalanceSchema,
});

export const bankingTransactionsRequestSchema = z.object({
  accountId: z.string().trim().min(1),
  from: dateOnlySchema,
  to: dateOnlySchema,
  limit: z.number().int().min(1).max(1000).default(100),
});

export const bankingTransactionsResponseSchema = z.object({
  operation: z.literal("transactions"),
  provider: bankingProviderSchema,
  accountId: z.string(),
  transactions: z.array(bankingTransactionSchema),
});

export const bankingGrantDurationSchema = z.enum(["1h", "24h", "7d", "30d"]);

export const bankingConnectionAccountSchema = z.object({
  id: z.uuid(),
  name: z.string().nullable(),
  institutionName: z.string().nullable(),
  type: z.string().nullable(),
  last4: z.string().nullable(),
  repairRequired: z.boolean(),
});

export const bankingRepairInstitutionSchema = z.object({
  institutionLoginId: z.string(),
  institutionName: z.string().nullable(),
});

export const bankingAccessRequestStatusResponseSchema = z.object({
  agent: z.object({
    id: z.uuid(),
    name: z.string(),
  }),
  connection: z
    .object({
      id: z.uuid(),
      status: z.enum(["active", "repair_required"]),
      accounts: z.array(bankingConnectionAccountSchema),
      repairInstitutions: z.array(bankingRepairInstitutionSchema),
    })
    .nullable(),
  session: z
    .object({
      id: z.uuid(),
      mode: z.enum(["connect", "fix"]),
      status: z.enum([
        "pending",
        "completed",
        "cancelled",
        "failed",
        "superseded",
      ]),
      institutionLoginId: z.string().nullable(),
    })
    .nullable(),
  grant: z
    .object({
      status: z.enum(["active", "expired", "revoked"]),
      accountIds: z.array(z.uuid()),
      purpose: z.string().nullable(),
      expiresAt: z.iso.datetime().nullable(),
    })
    .nullable(),
});

export const bankingConnectSessionRequestSchema = z
  .object({
    agentId: z.uuid(),
    mode: z.enum(["connect", "fix"]),
    institutionLoginId: z.string().trim().min(1).max(128).optional(),
  })
  .superRefine((value, context) => {
    if (value.mode === "fix" && !value.institutionLoginId) {
      context.addIssue({
        code: "custom",
        path: ["institutionLoginId"],
        message: "institutionLoginId is required for a fix session",
      });
    }
    if (value.mode === "connect" && value.institutionLoginId) {
      context.addIssue({
        code: "custom",
        path: ["institutionLoginId"],
        message: "institutionLoginId is only valid for a fix session",
      });
    }
  });

export const bankingConnectSessionResponseSchema = z.object({
  sessionId: z.uuid(),
  url: z.url(),
});

export const bankingAgentGrantRequestSchema = z.object({
  agentId: z.uuid(),
  accountIds: z.array(z.uuid()).min(1),
  duration: bankingGrantDurationSchema,
  purpose: z.string().trim().min(1).max(500),
});

export const bankingAgentGrantRevokeRequestSchema = z.object({
  agentId: z.uuid(),
});

const bankingAccountsResponses = {
  200: bankingAccountsResponseSchema,
  400: apiErrorSchema,
  401: apiErrorSchema,
  403: apiErrorSchema,
  502: apiErrorSchema,
  503: apiErrorSchema,
} as const;

const bankingBalancesResponses = {
  200: bankingBalancesResponseSchema,
  400: apiErrorSchema,
  401: apiErrorSchema,
  403: apiErrorSchema,
  502: apiErrorSchema,
  503: apiErrorSchema,
} as const;

const bankingTransactionsResponses = {
  200: bankingTransactionsResponseSchema,
  400: apiErrorSchema,
  401: apiErrorSchema,
  403: apiErrorSchema,
  502: apiErrorSchema,
  503: apiErrorSchema,
} as const;

export const bankingContract = c.router({
  accounts: {
    method: "POST",
    path: "/api/banking/accounts",
    headers: authHeadersSchema,
    body: z.object({}),
    responses: bankingAccountsResponses,
    summary: "List accounts through the managed banking gateway",
  },
  balances: {
    method: "POST",
    path: "/api/banking/balances",
    headers: authHeadersSchema,
    body: bankingBalancesRequestSchema,
    responses: bankingBalancesResponses,
    summary: "Read an account balance through the managed banking gateway",
  },
  transactions: {
    method: "POST",
    path: "/api/banking/transactions",
    headers: authHeadersSchema,
    body: bankingTransactionsRequestSchema,
    responses: bankingTransactionsResponses,
    summary: "Read account transactions through the managed banking gateway",
  },
});

const bankingUserMutationResponses = {
  200: bankingAccessRequestStatusResponseSchema,
  400: apiErrorSchema,
  401: apiErrorSchema,
  403: apiErrorSchema,
  404: apiErrorSchema,
  409: apiErrorSchema,
  502: apiErrorSchema,
  503: apiErrorSchema,
} as const;

export const bankingUserContract = c.router({
  accessRequestStatus: {
    method: "GET",
    path: "/api/banking/access-requests/:agentId",
    headers: authHeadersSchema,
    pathParams: z.object({ agentId: z.uuid() }),
    responses: {
      200: bankingAccessRequestStatusResponseSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
    },
    summary: "Read the live state for a banking access request card",
  },
  createConnectSession: {
    method: "POST",
    path: "/api/banking/connect-sessions",
    headers: authHeadersSchema,
    body: bankingConnectSessionRequestSchema,
    responses: {
      200: bankingConnectSessionResponseSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
      409: apiErrorSchema,
      502: apiErrorSchema,
      503: apiErrorSchema,
    },
    summary: "Start a Mastercard Data Connect or repair session",
  },
  saveAgentGrant: {
    method: "POST",
    path: "/api/banking/agent-grants",
    headers: authHeadersSchema,
    body: bankingAgentGrantRequestSchema,
    responses: bankingUserMutationResponses,
    summary: "Create or replace a banking grant for an agent",
  },
  revokeAgentGrant: {
    method: "POST",
    path: "/api/banking/agent-grants/revoke",
    headers: authHeadersSchema,
    body: bankingAgentGrantRevokeRequestSchema,
    responses: bankingUserMutationResponses,
    summary: "Revoke an agent banking grant",
  },
});

export const bankingPublicContract = c.router({
  connectReturn: {
    method: "GET",
    path: "/api/banking/connect/return",
    responses: {
      200: c.otherResponse({ contentType: "text/html", body: z.unknown() }),
    },
    summary: "Return a Mastercard Data Connect popup to Chat",
  },
  finicityWebhook: {
    method: "POST",
    path: "/api/webhooks/finicity",
    headers: z.object({ "x-finicity-signature": z.string() }),
    body: c.type<string>(),
    responses: {
      200: z.string(),
      400: z.object({ error: z.string() }),
      401: z.object({ error: z.string() }),
      500: z.object({ error: z.string() }),
      503: z.object({ error: z.string() }),
    },
    summary: "Handle signed Mastercard Open Finance webhooks",
  },
});

export type BankingContract = typeof bankingContract;
export type BankingUserContract = typeof bankingUserContract;
export type BankingPublicContract = typeof bankingPublicContract;
export type BankingAccount = z.infer<typeof bankingAccountSchema>;
export type BankingBalance = z.infer<typeof bankingBalanceSchema>;
export type BankingTransaction = z.infer<typeof bankingTransactionSchema>;
export type BankingAccountsResponse = z.infer<
  typeof bankingAccountsResponseSchema
>;
export type BankingBalancesRequest = z.infer<
  typeof bankingBalancesRequestSchema
>;
export type BankingBalancesResponse = z.infer<
  typeof bankingBalancesResponseSchema
>;
export type BankingTransactionsRequest = z.infer<
  typeof bankingTransactionsRequestSchema
>;
export type BankingTransactionsResponse = z.infer<
  typeof bankingTransactionsResponseSchema
>;
export type BankingGrantDuration = z.infer<typeof bankingGrantDurationSchema>;
export type BankingAccessRequestStatusResponse = z.infer<
  typeof bankingAccessRequestStatusResponseSchema
>;
export type BankingConnectSessionRequest = z.infer<
  typeof bankingConnectSessionRequestSchema
>;
export type BankingConnectSessionResponse = z.infer<
  typeof bankingConnectSessionResponseSchema
>;
export type BankingAgentGrantRequest = z.infer<
  typeof bankingAgentGrantRequestSchema
>;
