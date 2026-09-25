import type {
  BankingAccount,
  BankingAccountsResponse,
  BankingBalance,
  BankingBalancesRequest,
  BankingBalancesResponse,
  BankingTransaction,
  BankingTransactionsRequest,
  BankingTransactionsResponse,
} from "@okouai/api-contracts/contracts/banking";
import {
  bankingAccessAuditEvents,
  bankingAccounts,
  bankingAgentEnablements,
  bankingConnections,
  type BankingOperationScope,
} from "@okouai/db/schema/banking";
import { agentRuns } from "@okouai/db/runtime/agent-run";
import { agentSessions } from "@okouai/db/schema/agent-session";
import { command } from "ccstate";
import {
  and,
  eq,
  gt,
  inArray,
  isNull,
  or,
  type InferSelectModel,
} from "drizzle-orm";

import { env } from "../../lib/env";
import { singleton } from "../../lib/singleton";
import { now, nowDate } from "../../lib/time";
import type { AgentAuthContext } from "../../types/auth";
import { type Db, writeDb$ } from "../external/db";
import { safeJsonParse } from "../utils";

const APP_TOKEN_REFRESH_MS = 90 * 60 * 1000;
const FINICITY_BASE_URL = "https://api.finicity.com";
const PROVIDER = "finicity";

type BankingAuth = Extract<AgentAuthContext, { readonly orgId: string }>;
type BankingAccountRow = InferSelectModel<typeof bankingAccounts>;

interface CachedFinicityAppToken {
  readonly token: string;
  readonly refreshAfterMs: number;
}

interface BankingGatewayArgs<TBody> {
  readonly auth: BankingAuth;
  readonly body: TBody;
}

type ErrorStatus = 400 | 403 | 502 | 503;

export interface BankingErrorResponse {
  readonly status: ErrorStatus;
  readonly body: {
    readonly error: {
      readonly message: string;
      readonly code: string;
    };
  };
}

interface AuthorizedBankingAccess {
  readonly connectionId: string;
  readonly providerCustomerId: string;
  readonly runId: string;
  readonly agentId: string;
  readonly accounts: readonly BankingAccountRow[];
  readonly account?: BankingAccountRow;
}

type BankingAccessResult =
  | { readonly ok: true; readonly access: AuthorizedBankingAccess }
  | { readonly ok: false; readonly response: BankingErrorResponse };

interface BankingRunContext {
  readonly runId: string;
  readonly agentId: string;
  readonly triggerSource: string | null;
}

interface BankingGrantContext {
  readonly connectionId: string;
  readonly providerCustomerId: string;
  readonly accountProviderIds: readonly string[];
  readonly operationScopes: readonly BankingOperationScope[];
  readonly allowAutomationRuns: boolean;
}

const finicityAppTokenCache = singleton(
  (): { value: CachedFinicityAppToken | null } => {
    return { value: null };
  },
);

function errorResponse(
  status: ErrorStatus,
  code: string,
  message: string,
): BankingErrorResponse {
  return { status, body: { error: { code, message } } };
}

function badRequest(message: string): BankingErrorResponse {
  return errorResponse(400, "BAD_REQUEST", message);
}

function forbidden(message: string, code = "BANKING_ACCESS_DENIED") {
  return errorResponse(403, code, message);
}

function badGateway(message: string, code = "FINICITY_ERROR") {
  return errorResponse(502, code, message);
}

function serviceUnavailable(message: string, code = "NOT_CONFIGURED") {
  return errorResponse(503, code, message);
}

function isUnattendedTriggerSource(triggerSource: string | null): boolean {
  return (
    triggerSource === "automation-schedule" ||
    triggerSource === "automation-event"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function nullableString(value: unknown): string | null {
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }
  return null;
}

function nullableNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

async function readResponseBody(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) {
    return null;
  }

  const parsed = safeJsonParse(text);
  return parsed === undefined ? text : parsed;
}

function finicityErrorMessage(body: unknown): string {
  if (isRecord(body)) {
    if (typeof body.message === "string") {
      return body.message;
    }
    const error = body.error;
    if (isRecord(error) && typeof error.message === "string") {
      return error.message;
    }
    if (typeof body.code === "string") {
      return `Finicity request failed with code ${body.code}`;
    }
  }
  if (typeof body === "string" && body.trim()) {
    return body;
  }
  return "Finicity request failed";
}

function finicityCredentials():
  | {
      readonly appKey: string;
      readonly appSecret: string;
      readonly partnerId: string;
    }
  | BankingErrorResponse {
  const appKey = env("FINICITY_APP_KEY");
  const appSecret = env("FINICITY_APP_SECRET");
  const partnerId = env("FINICITY_PARTNER_ID");
  if (!appKey || !appSecret || !partnerId) {
    return serviceUnavailable("Finicity app credentials are not configured");
  }
  return { appKey, appSecret, partnerId };
}

async function getFinicityAppToken(
  signal: AbortSignal,
): Promise<string | BankingErrorResponse> {
  const cache = finicityAppTokenCache();
  if (cache.value && cache.value.refreshAfterMs > now()) {
    return cache.value.token;
  }

  const credentials = finicityCredentials();
  if ("status" in credentials) {
    return credentials;
  }

  const response = await fetch(
    `${FINICITY_BASE_URL}/aggregation/v2/partners/authentication`,
    {
      method: "POST",
      signal,
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        "Finicity-App-Key": credentials.appKey,
      },
      body: JSON.stringify({
        partnerId: credentials.partnerId,
        partnerSecret: credentials.appSecret,
      }),
    },
  );
  const body = await readResponseBody(response);
  if (!response.ok) {
    return badGateway(finicityErrorMessage(body), "FINICITY_AUTH_FAILED");
  }
  if (!isRecord(body) || typeof body.token !== "string") {
    return badGateway("Finicity authentication returned an invalid response");
  }

  cache.value = {
    token: body.token,
    refreshAfterMs: now() + APP_TOKEN_REFRESH_MS,
  };
  return body.token;
}

export async function fetchFinicityJson(
  path: string,
  signal: AbortSignal,
  request: {
    readonly method?: "GET" | "POST";
    readonly body?: unknown;
  } = {},
): Promise<unknown | BankingErrorResponse> {
  const credentials = finicityCredentials();
  if ("status" in credentials) {
    return credentials;
  }
  const appToken = await getFinicityAppToken(signal);
  if (typeof appToken !== "string") {
    return appToken;
  }

  const response = await fetch(`${FINICITY_BASE_URL}${path}`, {
    method: request.method ?? "GET",
    signal,
    headers: {
      Accept: "application/json",
      ...(request.body === undefined
        ? {}
        : { "Content-Type": "application/json" }),
      "Finicity-App-Key": credentials.appKey,
      "Finicity-App-Token": appToken,
    },
    ...(request.body === undefined
      ? {}
      : { body: JSON.stringify(request.body) }),
  });
  const body = await readResponseBody(response);
  return response.ok ? body : badGateway(finicityErrorMessage(body));
}

function finicityAccounts(body: unknown): readonly Record<string, unknown>[] {
  if (!isRecord(body) || !Array.isArray(body.accounts)) {
    return [];
  }
  return body.accounts.filter(isRecord);
}

function finicityTransactions(
  body: unknown,
): readonly Record<string, unknown>[] {
  if (!isRecord(body) || !Array.isArray(body.transactions)) {
    return [];
  }
  return body.transactions.filter(isRecord);
}

function providerAccountId(account: Record<string, unknown>): string | null {
  return nullableString(account.id);
}

function providerTransactionId(
  transaction: Record<string, unknown>,
): string | null {
  return nullableString(transaction.id);
}

function toBankingAccount(
  row: BankingAccountRow,
  providerAccount: Record<string, unknown> | undefined,
): BankingAccount {
  return {
    id: row.providerAccountId,
    name: stringValue(providerAccount?.name) ?? row.displayName,
    institutionName: row.institutionName,
    type: stringValue(providerAccount?.type) ?? row.accountType,
    last4:
      nullableString(providerAccount?.realAccountNumberLast4) ??
      row.accountNumberLast4,
    status: stringValue(providerAccount?.status),
    currency: stringValue(providerAccount?.currency),
  };
}

function toBankingBalance(
  row: BankingAccountRow,
  providerAccount: Record<string, unknown>,
): BankingBalance {
  return {
    accountId: row.providerAccountId,
    name: stringValue(providerAccount.name) ?? row.displayName,
    type: stringValue(providerAccount.type) ?? row.accountType,
    balance: nullableNumber(providerAccount.balance),
    availableBalance: nullableNumber(providerAccount.availableBalance),
    currency: stringValue(providerAccount.currency),
    balanceDate: nullableNumber(providerAccount.balanceDate),
  };
}

function toBankingTransaction(
  accountId: string,
  transaction: Record<string, unknown>,
): BankingTransaction | null {
  const id = providerTransactionId(transaction);
  if (!id) {
    return null;
  }
  return {
    id,
    accountId,
    amount: nullableNumber(transaction.amount),
    description: stringValue(transaction.description),
    memo: stringValue(transaction.memo),
    postedDate: nullableNumber(transaction.postedDate),
    transactionDate: nullableNumber(transaction.transactionDate),
    status: stringValue(transaction.status),
    categorization: stringValue(transaction.categorization),
    merchant: stringValue(transaction.merchant),
  };
}

function accountById(
  accounts: readonly Record<string, unknown>[],
  accountId: string,
): Record<string, unknown> | undefined {
  return accounts.find((account) => {
    return providerAccountId(account) === accountId;
  });
}

function epochSecondsForDateOnly(value: string, endOfDay: boolean): number {
  const [yearRaw, monthRaw, dayRaw] = value.split("-");
  const year = Number(yearRaw);
  const month = Number(monthRaw);
  const day = Number(dayRaw);
  const seconds = Math.floor(Date.UTC(year, month - 1, day) / 1000);
  return endOfDay ? seconds + 86_399 : seconds;
}

async function recordBankingAudit(
  db: Db,
  args: {
    readonly orgId: string;
    readonly userId: string;
    readonly runId: string;
    readonly action: BankingOperationScope;
    readonly status: "allowed" | "denied";
    readonly agentId?: string;
    readonly connectionId?: string;
    readonly providerAccountId?: string;
    readonly failureCode?: string;
  },
): Promise<void> {
  await db.insert(bankingAccessAuditEvents).values({
    orgId: args.orgId,
    userId: args.userId,
    runId: args.runId,
    agentId: args.agentId ?? null,
    connectionId: args.connectionId ?? null,
    providerAccountId: args.providerAccountId ?? null,
    action: args.action,
    status: args.status,
    failureCode: args.failureCode ?? null,
  });
}

async function findBankingRun(
  db: Db,
  auth: BankingAuth,
): Promise<BankingRunContext | null> {
  const [run] = await db
    .select({
      runId: agentRuns.id,
      agentId: agentSessions.agentId,
      triggerSource: agentRuns.triggerSource,
    })
    .from(agentRuns)
    .innerJoin(agentSessions, eq(agentRuns.sessionId, agentSessions.id))
    .where(
      and(
        eq(agentRuns.id, auth.runId),
        eq(agentRuns.orgId, auth.orgId),
        eq(agentRuns.userId, auth.userId),
      ),
    )
    .limit(1);

  return run?.agentId ? { ...run, agentId: run.agentId } : null;
}

async function findBankingGrant(
  db: Db,
  auth: BankingAuth,
  agentId: string,
): Promise<BankingGrantContext | null> {
  const nowValue = nowDate();
  const [grant] = await db
    .select({
      connectionId: bankingConnections.id,
      providerCustomerId: bankingConnections.providerCustomerId,
      accountProviderIds: bankingAgentEnablements.accountProviderIds,
      operationScopes: bankingAgentEnablements.operationScopes,
      allowAutomationRuns: bankingAgentEnablements.allowAutomationRuns,
    })
    .from(bankingConnections)
    .innerJoin(
      bankingAgentEnablements,
      eq(bankingAgentEnablements.connectionId, bankingConnections.id),
    )
    .where(
      and(
        eq(bankingConnections.orgId, auth.orgId),
        eq(bankingConnections.userId, auth.userId),
        eq(bankingConnections.provider, PROVIDER),
        or(
          eq(bankingConnections.status, "active"),
          eq(bankingConnections.status, "repair_required"),
        ),
        isNull(bankingConnections.revokedAt),
        isNull(bankingConnections.deletedAt),
        or(
          isNull(bankingConnections.consentExpiresAt),
          gt(bankingConnections.consentExpiresAt, nowValue),
        ),
        eq(bankingAgentEnablements.orgId, auth.orgId),
        eq(bankingAgentEnablements.userId, auth.userId),
        eq(bankingAgentEnablements.agentId, agentId),
        isNull(bankingAgentEnablements.revokedAt),
        gt(bankingAgentEnablements.expiresAt, nowValue),
      ),
    )
    .limit(1);

  return grant ?? null;
}

async function denyBankingAccess(
  db: Db,
  auth: BankingAuth,
  action: BankingOperationScope,
  providerAccountId: string | undefined,
  args: {
    readonly failureCode: string;
    readonly message: string;
    readonly agentId?: string;
    readonly connectionId?: string;
  },
): Promise<BankingAccessResult> {
  await recordBankingAudit(db, {
    orgId: auth.orgId,
    userId: auth.userId,
    runId: auth.runId,
    action,
    status: "denied",
    agentId: args.agentId,
    connectionId: args.connectionId,
    providerAccountId,
    failureCode: args.failureCode,
  });
  return {
    ok: false,
    response: forbidden(args.message),
  };
}

async function enabledBankingAccounts(
  db: Db,
  auth: BankingAuth,
  grant: BankingGrantContext,
): Promise<readonly BankingAccountRow[]> {
  return await db
    .select()
    .from(bankingAccounts)
    .where(
      and(
        eq(bankingAccounts.connectionId, grant.connectionId),
        eq(bankingAccounts.orgId, auth.orgId),
        eq(bankingAccounts.userId, auth.userId),
        eq(bankingAccounts.enabled, true),
        isNull(bankingAccounts.repairRequiredAt),
        inArray(bankingAccounts.providerAccountId, grant.accountProviderIds),
      ),
    );
}

async function authorizeBankingAccess(
  db: Db,
  auth: BankingAuth,
  action: BankingOperationScope,
  providerAccountId: string | undefined,
): Promise<BankingAccessResult> {
  const run = await findBankingRun(db, auth);
  if (!run) {
    return await denyBankingAccess(db, auth, action, providerAccountId, {
      failureCode: "RUN_NOT_FOUND",
      message: "Banking access requires a current Okou run",
    });
  }

  const grant = await findBankingGrant(db, auth, run.agentId);
  if (!grant) {
    return await denyBankingAccess(db, auth, action, providerAccountId, {
      agentId: run.agentId,
      failureCode: "NO_ACTIVE_GRANT",
      message: "Banking is not enabled for this agent",
    });
  }

  if (!grant.operationScopes.includes(action)) {
    return await denyBankingAccess(db, auth, action, providerAccountId, {
      agentId: run.agentId,
      connectionId: grant.connectionId,
      failureCode: "SCOPE_NOT_ALLOWED",
      message: `Banking operation is not enabled: ${action}`,
    });
  }

  if (
    isUnattendedTriggerSource(run.triggerSource) &&
    !grant.allowAutomationRuns
  ) {
    // Historical audit rows persist the former "SCHEDULE_NOT_ALLOWED" code;
    // nothing filters on the literal, so new denials emit the automation name.
    return await denyBankingAccess(db, auth, action, providerAccountId, {
      agentId: run.agentId,
      connectionId: grant.connectionId,
      failureCode: "AUTOMATION_NOT_ALLOWED",
      message: "Banking is not enabled for automation runs",
    });
  }

  if (
    providerAccountId &&
    !grant.accountProviderIds.includes(providerAccountId)
  ) {
    return await denyBankingAccess(db, auth, action, providerAccountId, {
      agentId: run.agentId,
      connectionId: grant.connectionId,
      failureCode: "ACCOUNT_NOT_ALLOWED",
      message: "Banking account is not enabled for this agent",
    });
  }

  if (grant.accountProviderIds.length === 0) {
    return {
      ok: true,
      access: {
        connectionId: grant.connectionId,
        providerCustomerId: grant.providerCustomerId,
        runId: run.runId,
        agentId: run.agentId,
        accounts: [],
      },
    };
  }

  const accounts = await enabledBankingAccounts(db, auth, grant);
  const account = providerAccountId
    ? accounts.find((row) => {
        return row.providerAccountId === providerAccountId;
      })
    : undefined;
  if (providerAccountId && !account) {
    return await denyBankingAccess(db, auth, action, providerAccountId, {
      agentId: run.agentId,
      connectionId: grant.connectionId,
      failureCode: "ACCOUNT_NOT_ACTIVE",
      message: "Banking account is not active",
    });
  }

  return {
    ok: true,
    access: {
      connectionId: grant.connectionId,
      providerCustomerId: grant.providerCustomerId,
      runId: run.runId,
      agentId: run.agentId,
      accounts,
      account,
    },
  };
}

export const bankingAccounts$ = command(
  async (
    { set },
    args: BankingGatewayArgs<Record<string, never>>,
    signal: AbortSignal,
  ) => {
    const db = set(writeDb$);
    const auth = await authorizeBankingAccess(
      db,
      args.auth,
      "accounts.read",
      undefined,
    );
    signal.throwIfAborted();
    if (!auth.ok) {
      return auth.response;
    }
    if (auth.access.accounts.length === 0) {
      const body: BankingAccountsResponse = {
        operation: "accounts",
        provider: PROVIDER,
        accounts: [],
      };

      await recordBankingAudit(db, {
        orgId: args.auth.orgId,
        userId: args.auth.userId,
        runId: auth.access.runId,
        action: "accounts.read",
        status: "allowed",
        agentId: auth.access.agentId,
        connectionId: auth.access.connectionId,
      });
      signal.throwIfAborted();
      return { status: 200 as const, body };
    }

    const providerResult = await fetchFinicityJson(
      `/aggregation/v1/customers/${encodeURIComponent(
        auth.access.providerCustomerId,
      )}/accounts`,
      signal,
    );
    signal.throwIfAborted();
    if (isBankingErrorResponse(providerResult)) {
      return providerResult;
    }

    const allowedAccountIds = new Set(
      auth.access.accounts.map((account) => {
        return account.providerAccountId;
      }),
    );
    const providerAccounts = finicityAccounts(providerResult).filter(
      (account) => {
        const id = providerAccountId(account);
        return id !== null && allowedAccountIds.has(id);
      },
    );
    const body: BankingAccountsResponse = {
      operation: "accounts",
      provider: PROVIDER,
      accounts: auth.access.accounts.map((row) => {
        return toBankingAccount(
          row,
          accountById(providerAccounts, row.providerAccountId),
        );
      }),
    };

    await recordBankingAudit(db, {
      orgId: args.auth.orgId,
      userId: args.auth.userId,
      runId: auth.access.runId,
      action: "accounts.read",
      status: "allowed",
      agentId: auth.access.agentId,
      connectionId: auth.access.connectionId,
    });
    signal.throwIfAborted();
    return { status: 200 as const, body };
  },
);

export const bankingBalances$ = command(
  async (
    { set },
    args: BankingGatewayArgs<BankingBalancesRequest>,
    signal: AbortSignal,
  ) => {
    const db = set(writeDb$);
    const auth = await authorizeBankingAccess(
      db,
      args.auth,
      "balances.read",
      args.body.accountId,
    );
    signal.throwIfAborted();
    if (!auth.ok) {
      return auth.response;
    }
    if (!auth.access.account) {
      return forbidden("Banking account is not active");
    }

    const providerResult = await fetchFinicityJson(
      `/aggregation/v1/customers/${encodeURIComponent(
        auth.access.providerCustomerId,
      )}/accounts`,
      signal,
    );
    signal.throwIfAborted();
    if (isBankingErrorResponse(providerResult)) {
      return providerResult;
    }

    const providerAccount = accountById(
      finicityAccounts(providerResult),
      args.body.accountId,
    );
    if (!providerAccount) {
      return badGateway("Finicity account was not found", "FINICITY_NOT_FOUND");
    }

    const body: BankingBalancesResponse = {
      operation: "balances",
      provider: PROVIDER,
      balance: toBankingBalance(auth.access.account, providerAccount),
    };

    await recordBankingAudit(db, {
      orgId: args.auth.orgId,
      userId: args.auth.userId,
      runId: auth.access.runId,
      action: "balances.read",
      status: "allowed",
      agentId: auth.access.agentId,
      connectionId: auth.access.connectionId,
      providerAccountId: args.body.accountId,
    });
    signal.throwIfAborted();
    return { status: 200 as const, body };
  },
);

export const bankingTransactions$ = command(
  async (
    { set },
    args: BankingGatewayArgs<BankingTransactionsRequest>,
    signal: AbortSignal,
  ) => {
    const db = set(writeDb$);
    const auth = await authorizeBankingAccess(
      db,
      args.auth,
      "transactions.read",
      args.body.accountId,
    );
    signal.throwIfAborted();
    if (!auth.ok) {
      return auth.response;
    }
    if (!auth.access.account) {
      return forbidden("Banking account is not active");
    }

    const fromDate = epochSecondsForDateOnly(args.body.from, false);
    const toDate = epochSecondsForDateOnly(args.body.to, true);
    if (fromDate > toDate) {
      return badRequest("from must be before or equal to to");
    }

    const params = new URLSearchParams({
      fromDate: String(fromDate),
      toDate: String(toDate),
      start: "1",
      limit: String(args.body.limit),
      sort: "desc",
      includePending: "false",
    });
    const providerResult = await fetchFinicityJson(
      `/aggregation/v3/customers/${encodeURIComponent(
        auth.access.providerCustomerId,
      )}/accounts/${encodeURIComponent(args.body.accountId)}/transactions?${params.toString()}`,
      signal,
    );
    signal.throwIfAborted();
    if (isBankingErrorResponse(providerResult)) {
      return providerResult;
    }

    const body: BankingTransactionsResponse = {
      operation: "transactions",
      provider: PROVIDER,
      accountId: args.body.accountId,
      transactions: finicityTransactions(providerResult).flatMap(
        (transaction) => {
          const mapped = toBankingTransaction(args.body.accountId, transaction);
          return mapped ? [mapped] : [];
        },
      ),
    };

    await recordBankingAudit(db, {
      orgId: args.auth.orgId,
      userId: args.auth.userId,
      runId: auth.access.runId,
      action: "transactions.read",
      status: "allowed",
      agentId: auth.access.agentId,
      connectionId: auth.access.connectionId,
      providerAccountId: args.body.accountId,
    });
    signal.throwIfAborted();
    return { status: 200 as const, body };
  },
);

export function isBankingErrorResponse(
  value: unknown,
): value is BankingErrorResponse {
  if (!isRecord(value)) {
    return false;
  }

  return (
    (value.status === 400 ||
      value.status === 403 ||
      value.status === 502 ||
      value.status === 503) &&
    isRecord(value.body) &&
    isRecord(value.body.error)
  );
}
