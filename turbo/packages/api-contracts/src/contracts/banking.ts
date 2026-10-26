import {
  array,
  boolean,
  iso,
  literal,
  number,
  object,
  string,
  url,
  uuid,
  enum as zEnum,
  unknown as zUnknown,
  type infer as zInfer,
} from "zod";

import { authHeadersSchema, initContract } from "./base";
import { apiErrorSchema } from "./errors";

const c = initContract();

const dateOnlySchema = string().regex(
  /^\d{4}-\d{2}-\d{2}$/,
  "Date must be formatted as YYYY-MM-DD",
);

export const bankingProviderSchema = literal("finicity");

export const bankingAccountSchema = object({
  id: string(),
  name: string().nullable(),
  institutionName: string().nullable(),
  type: string().nullable(),
  last4: string().nullable(),
  status: string().nullable(),
  currency: string().nullable(),
});

export const bankingBalanceSchema = object({
  accountId: string(),
  name: string().nullable(),
  type: string().nullable(),
  balance: number().nullable(),
  availableBalance: number().nullable(),
  currency: string().nullable(),
  balanceDate: number().nullable(),
});

export const bankingTransactionSchema = object({
  id: string(),
  accountId: string(),
  amount: number().nullable(),
  description: string().nullable(),
  memo: string().nullable(),
  postedDate: number().nullable(),
  transactionDate: number().nullable(),
  status: string().nullable(),
  categorization: string().nullable(),
  merchant: string().nullable(),
});

export const bankingAccountsResponseSchema = object({
  operation: literal("accounts"),
  provider: bankingProviderSchema,
  accounts: array(bankingAccountSchema),
});

export const bankingBalancesRequestSchema = object({
  accountId: string().trim().min(1),
});

export const bankingBalancesResponseSchema = object({
  operation: literal("balances"),
  provider: bankingProviderSchema,
  balance: bankingBalanceSchema,
});

export const bankingTransactionsRequestSchema = object({
  accountId: string().trim().min(1),
  from: dateOnlySchema,
  to: dateOnlySchema,
  limit: number().int().min(1).max(1000).default(100),
});

export const bankingTransactionsResponseSchema = object({
  operation: literal("transactions"),
  provider: bankingProviderSchema,
  accountId: string(),
  transactions: array(bankingTransactionSchema),
});

export const bankingGrantDurationSchema = zEnum(["1h", "24h", "7d", "30d"]);

export const bankingConnectionAccountSchema = object({
  id: uuid(),
  name: string().nullable(),
  institutionName: string().nullable(),
  type: string().nullable(),
  last4: string().nullable(),
  repairRequired: boolean(),
});

export const bankingRepairInstitutionSchema = object({
  institutionLoginId: string(),
  institutionName: string().nullable(),
});

export const bankingAccessRequestStatusResponseSchema = object({
  agent: object({
    id: uuid(),
    name: string(),
  }),
  connection: object({
    id: uuid(),
    status: zEnum(["active", "repair_required"]),
    accounts: array(bankingConnectionAccountSchema),
    repairInstitutions: array(bankingRepairInstitutionSchema),
  }).nullable(),
  session: object({
    id: uuid(),
    mode: zEnum(["connect", "fix"]),
    status: zEnum([
      "pending",
      "completed",
      "cancelled",
      "failed",
      "superseded",
    ]),
    institutionLoginId: string().nullable(),
  }).nullable(),
  grant: object({
    status: zEnum(["active", "expired", "revoked"]),
    accountIds: array(uuid()),
    purpose: string().nullable(),
    expiresAt: iso.datetime().nullable(),
  }).nullable(),
});

export const bankingConnectSessionRequestSchema = object({
  agentId: uuid(),
  mode: zEnum(["connect", "fix"]),
  institutionLoginId: string().trim().min(1).max(128).optional(),
}).superRefine((value, context) => {
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

export const bankingConnectSessionResponseSchema = object({
  sessionId: uuid(),
  url: url(),
});

export const bankingAgentGrantRequestSchema = object({
  agentId: uuid(),
  accountIds: array(uuid()).min(1),
  duration: bankingGrantDurationSchema,
  purpose: string().trim().min(1).max(500),
});

export const bankingAgentGrantRevokeRequestSchema = object({
  agentId: uuid(),
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
    body: object({}),
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
    pathParams: object({ agentId: uuid() }),
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
      200: c.otherResponse({ contentType: "text/html", body: zUnknown() }),
    },
    summary: "Return a Mastercard Data Connect popup to Chat",
  },
  finicityWebhook: {
    method: "POST",
    path: "/api/webhooks/finicity",
    headers: object({ "x-finicity-signature": string() }),
    body: c.type<string>(),
    responses: {
      200: string(),
      400: object({ error: string() }),
      401: object({ error: string() }),
      500: object({ error: string() }),
      503: object({ error: string() }),
    },
    summary: "Handle signed Mastercard Open Finance webhooks",
  },
});

export type BankingContract = typeof bankingContract;
export type BankingUserContract = typeof bankingUserContract;
export type BankingPublicContract = typeof bankingPublicContract;
export type BankingAccount = zInfer<typeof bankingAccountSchema>;
export type BankingBalance = zInfer<typeof bankingBalanceSchema>;
export type BankingTransaction = zInfer<typeof bankingTransactionSchema>;
export type BankingAccountsResponse = zInfer<
  typeof bankingAccountsResponseSchema
>;
export type BankingBalancesRequest = zInfer<
  typeof bankingBalancesRequestSchema
>;
export type BankingBalancesResponse = zInfer<
  typeof bankingBalancesResponseSchema
>;
export type BankingTransactionsRequest = zInfer<
  typeof bankingTransactionsRequestSchema
>;
export type BankingTransactionsResponse = zInfer<
  typeof bankingTransactionsResponseSchema
>;
export type BankingGrantDuration = zInfer<typeof bankingGrantDurationSchema>;
export type BankingAccessRequestStatusResponse = zInfer<
  typeof bankingAccessRequestStatusResponseSchema
>;
export type BankingConnectSessionRequest = zInfer<
  typeof bankingConnectSessionRequestSchema
>;
export type BankingConnectSessionResponse = zInfer<
  typeof bankingConnectSessionResponseSchema
>;
export type BankingAgentGrantRequest = zInfer<
  typeof bankingAgentGrantRequestSchema
>;
