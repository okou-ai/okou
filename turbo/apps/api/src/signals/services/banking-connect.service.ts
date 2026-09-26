import { createHash, createHmac, timingSafeEqual } from "node:crypto";

import type {
  BankingAccessRequestStatusResponse,
  BankingAgentGrantRequest,
  BankingConnectSessionRequest,
  BankingGrantDuration,
} from "@okouai/api-contracts/contracts/banking";
import { agents } from "@okouai/db/schema/agent";
import {
  bankingAccounts,
  bankingAgentEnablements,
  bankingConnections,
  bankingConnectEvents,
  bankingConnectSessions,
} from "@okouai/db/schema/banking";
import { command } from "ccstate";
import {
  and,
  desc,
  eq,
  inArray,
  isNotNull,
  isNull,
  or,
  sql,
  type InferSelectModel,
} from "drizzle-orm";

import { env } from "../../lib/env";
import { nowDate } from "../../lib/time";
import { type Db, writeDb$ } from "../external/db";
import { safeJsonParse } from "../utils";
import {
  fetchFinicityJson,
  isBankingErrorResponse,
  type BankingErrorResponse,
} from "./banking.service";

const PROVIDER = "finicity";
const BANKING_OPERATION_SCOPES = [
  "accounts.read",
  "balances.read",
  "transactions.read",
] as const;

interface BankingOwner {
  readonly orgId: string;
  readonly userId: string;
}

type BankingConnectionRow = InferSelectModel<typeof bankingConnections>;
type BankingConnectSessionRow = InferSelectModel<typeof bankingConnectSessions>;

type UserErrorStatus = 400 | 403 | 404 | 409 | 502 | 503;

interface UserErrorResponse {
  readonly status: UserErrorStatus;
  readonly body: {
    readonly error: {
      readonly code: string;
      readonly message: string;
    };
  };
}

interface ProviderAccount {
  readonly providerAccountId: string;
  readonly displayName: string | null;
  readonly institutionName: string | null;
  readonly institutionLoginId: string | null;
  readonly accountType: string | null;
  readonly accountNumberLast4: string | null;
  readonly repairRequired: boolean;
}

type BankingWebhookResult =
  | { readonly kind: "ok" }
  | { readonly kind: "bad_request" }
  | { readonly kind: "processing_failed" };

function userError(
  status: UserErrorStatus,
  code: string,
  message: string,
): UserErrorResponse {
  return { status, body: { error: { code, message } } };
}

function isUserErrorResponse(value: unknown): value is UserErrorResponse {
  return (
    isRecord(value) &&
    typeof value.status === "number" &&
    isRecord(value.body) &&
    isRecord(value.body.error)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nullableString(value: unknown): string | null {
  if (typeof value === "string" && value.length > 0) {
    return value;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }
  return null;
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
    value,
  );
}

function providerResponseError(
  response: BankingErrorResponse,
): UserErrorResponse {
  return response;
}

async function findAgent(
  db: Db,
  owner: BankingOwner,
  agentId: string,
): Promise<{ readonly id: string; readonly name: string } | null> {
  const [agent] = await db
    .select({
      id: agents.id,
      name: agents.name,
      displayName: agents.displayName,
    })
    .from(agents)
    .where(and(eq(agents.id, agentId), eq(agents.orgId, owner.orgId)))
    .limit(1);

  return agent ? { id: agent.id, name: agent.displayName ?? agent.name } : null;
}

async function findConnection(
  db: Db,
  owner: BankingOwner,
): Promise<BankingConnectionRow | null> {
  const [connection] = await db
    .select()
    .from(bankingConnections)
    .where(
      and(
        eq(bankingConnections.orgId, owner.orgId),
        eq(bankingConnections.userId, owner.userId),
        eq(bankingConnections.provider, PROVIDER),
        isNull(bankingConnections.revokedAt),
        isNull(bankingConnections.deletedAt),
        or(
          eq(bankingConnections.status, "active"),
          eq(bankingConnections.status, "repair_required"),
        ),
      ),
    )
    .limit(1);

  return connection ?? null;
}

function finicityCustomerId(body: unknown): string | null {
  return isRecord(body) ? nullableString(body.id) : null;
}

function finicityConnectUrl(body: unknown): string | null {
  if (!isRecord(body)) {
    return null;
  }
  return nullableString(body.link) ?? nullableString(body.url);
}

function deterministicCustomerUsername(owner: BankingOwner): string {
  const digest = createHash("sha256")
    .update(`${owner.orgId}\u0000${owner.userId}`)
    .digest("hex")
    .slice(0, 40);
  return `zero-${digest}`;
}

async function createTestingCustomer(
  owner: BankingOwner,
  signal: AbortSignal,
): Promise<string | UserErrorResponse> {
  const result = await fetchFinicityJson(
    "/aggregation/v2/customers/testing",
    signal,
    {
      method: "POST",
      body: {
        username: deterministicCustomerUsername(owner),
        firstName: "Okou",
        lastName: "Banking",
      },
    },
  );
  if (isBankingErrorResponse(result)) {
    return providerResponseError(result);
  }
  const customerId = finicityCustomerId(result);
  return (
    customerId ??
    userError(
      502,
      "FINICITY_INVALID_RESPONSE",
      "Mastercard customer creation returned an invalid response",
    )
  );
}

async function ensureConnection(
  db: Db,
  owner: BankingOwner,
  signal: AbortSignal,
): Promise<BankingConnectionRow | UserErrorResponse> {
  const existing = await findConnection(db, owner);
  if (existing) {
    return existing;
  }

  const customerId = await createTestingCustomer(owner, signal);
  signal.throwIfAborted();
  if (typeof customerId !== "string") {
    return customerId;
  }

  await db
    .insert(bankingConnections)
    .values({
      orgId: owner.orgId,
      userId: owner.userId,
      provider: PROVIDER,
      providerCustomerId: customerId,
      status: "active",
    })
    .onConflictDoNothing({
      target: [
        bankingConnections.orgId,
        bankingConnections.userId,
        bankingConnections.provider,
      ],
    });

  const connection = await findConnection(db, owner);
  return (
    connection ??
    userError(
      409,
      "BANKING_CONNECTION_CONFLICT",
      "The banking connection changed while the request was starting",
    )
  );
}

async function latestSession(
  db: Db,
  owner: BankingOwner,
  connectionId: string,
): Promise<BankingConnectSessionRow | null> {
  const [session] = await db
    .select()
    .from(bankingConnectSessions)
    .where(
      and(
        eq(bankingConnectSessions.orgId, owner.orgId),
        eq(bankingConnectSessions.userId, owner.userId),
        eq(bankingConnectSessions.connectionId, connectionId),
      ),
    )
    .orderBy(desc(bankingConnectSessions.createdAt))
    .limit(1);
  return session ?? null;
}

async function statusResponse(
  db: Db,
  owner: BankingOwner,
  agentId: string,
): Promise<BankingAccessRequestStatusResponse | UserErrorResponse> {
  const agent = await findAgent(db, owner, agentId);
  if (!agent) {
    return userError(404, "AGENT_NOT_FOUND", "Agent not found");
  }

  const connection = await findConnection(db, owner);
  if (!connection) {
    return { agent, connection: null, session: null, grant: null };
  }

  const [accountRows, session, grantRows] = await Promise.all([
    db
      .select()
      .from(bankingAccounts)
      .where(
        and(
          eq(bankingAccounts.connectionId, connection.id),
          eq(bankingAccounts.orgId, owner.orgId),
          eq(bankingAccounts.userId, owner.userId),
          eq(bankingAccounts.enabled, true),
        ),
      ),
    latestSession(db, owner, connection.id),
    db
      .select()
      .from(bankingAgentEnablements)
      .where(
        and(
          eq(bankingAgentEnablements.orgId, owner.orgId),
          eq(bankingAgentEnablements.userId, owner.userId),
          eq(bankingAgentEnablements.agentId, agentId),
          eq(bankingAgentEnablements.connectionId, connection.id),
        ),
      )
      .limit(1),
  ]);

  const accountIdByProviderId = new Map(
    accountRows.map((account) => {
      return [account.providerAccountId, account.id] as const;
    }),
  );
  const grant = grantRows[0];
  const grantStatus = grant
    ? grant.revokedAt
      ? "revoked"
      : !grant.expiresAt || grant.expiresAt.getTime() <= nowDate().getTime()
        ? "expired"
        : "active"
    : null;
  const repairInstitutions = new Map<
    string,
    {
      readonly institutionLoginId: string;
      readonly institutionName: string | null;
    }
  >();
  for (const account of accountRows) {
    if (account.repairRequiredAt && account.institutionLoginId) {
      repairInstitutions.set(account.institutionLoginId, {
        institutionLoginId: account.institutionLoginId,
        institutionName: account.institutionName,
      });
    }
  }

  return {
    agent,
    connection: {
      id: connection.id,
      status: repairInstitutions.size > 0 ? "repair_required" : "active",
      accounts: accountRows.map((account) => {
        return {
          id: account.id,
          name: account.displayName,
          institutionName: account.institutionName,
          type: account.accountType,
          last4: account.accountNumberLast4,
          repairRequired: account.repairRequiredAt !== null,
        };
      }),
      repairInstitutions: [...repairInstitutions.values()],
    },
    session: session
      ? {
          id: session.id,
          mode: session.mode,
          status: session.status,
          institutionLoginId: session.institutionLoginId,
        }
      : null,
    grant:
      grant && grantStatus
        ? {
            status: grantStatus,
            accountIds: grant.accountProviderIds.flatMap((providerId) => {
              const accountId = accountIdByProviderId.get(providerId);
              return accountId ? [accountId] : [];
            }),
            purpose: grant.purpose,
            expiresAt: grant.expiresAt?.toISOString() ?? null,
          }
        : null,
  };
}

export const bankingAccessRequestStatus$ = command(
  async (
    { set },
    args: { readonly owner: BankingOwner; readonly agentId: string },
  ) => {
    const status = await statusResponse(
      set(writeDb$),
      args.owner,
      args.agentId,
    );
    return isUserErrorResponse(status)
      ? status
      : { status: 200 as const, body: status };
  },
);

function connectSessionBody(args: {
  readonly connection: BankingConnectionRow;
  readonly session: BankingConnectSessionRow;
  readonly redirectOrigin: string;
  readonly webhookOrigin: string;
}): Record<string, unknown> | UserErrorResponse {
  const partnerId = env("FINICITY_PARTNER_ID");
  if (!partnerId) {
    return userError(
      503,
      "NOT_CONFIGURED",
      "Mastercard Open Finance is not configured",
    );
  }
  const webhookData = {
    uniqueCustomerId: args.connection.id,
    uniqueRequestId: args.session.id,
  };
  return {
    partnerId,
    customerId: args.connection.providerCustomerId,
    language: "en",
    redirectUri: new URL(
      "/banking/connect/return",
      args.redirectOrigin,
    ).toString(),
    webhook: new URL("/api/webhooks/finicity", args.webhookOrigin).toString(),
    webhookContentType: "application/json",
    webhookData,
    singleUseUrl: true,
    ...(args.session.mode === "fix"
      ? { institutionLoginId: args.session.institutionLoginId }
      : {}),
  };
}

export const startBankingConnectSession$ = command(
  async (
    { set },
    args: {
      readonly owner: BankingOwner;
      readonly body: BankingConnectSessionRequest;
      readonly redirectOrigin: string;
      readonly webhookOrigin: string;
    },
    signal: AbortSignal,
  ) => {
    const db = set(writeDb$);
    const agent = await findAgent(db, args.owner, args.body.agentId);
    signal.throwIfAborted();
    if (!agent) {
      return userError(404, "AGENT_NOT_FOUND", "Agent not found");
    }

    const connection = await ensureConnection(db, args.owner, signal);
    signal.throwIfAborted();
    if (isUserErrorResponse(connection)) {
      return connection;
    }

    if (args.body.mode === "fix") {
      const [affectedAccount] = await db
        .select({ id: bankingAccounts.id })
        .from(bankingAccounts)
        .where(
          and(
            eq(bankingAccounts.connectionId, connection.id),
            eq(bankingAccounts.orgId, args.owner.orgId),
            eq(bankingAccounts.userId, args.owner.userId),
            eq(
              bankingAccounts.institutionLoginId,
              args.body.institutionLoginId ?? "",
            ),
            eq(bankingAccounts.enabled, true),
            isNotNull(bankingAccounts.repairRequiredAt),
          ),
        )
        .limit(1);
      signal.throwIfAborted();
      if (!affectedAccount) {
        return userError(
          404,
          "BANKING_INSTITUTION_NOT_FOUND",
          "The institution to repair was not found",
        );
      }
    }

    const [session] = await db.transaction(async (tx) => {
      await tx.execute(
        // eslint-disable-next-line api/no-new-advisory-lock -- 2026-09-26 前存量；禁止新增 advisory lock
        sql`SELECT pg_advisory_xact_lock(hashtextextended(${`banking_connect:${connection.id}`}, 0))`,
      );
      await tx
        .update(bankingConnectSessions)
        .set({ status: "superseded", updatedAt: nowDate() })
        .where(
          and(
            eq(bankingConnectSessions.orgId, args.owner.orgId),
            eq(bankingConnectSessions.userId, args.owner.userId),
            eq(bankingConnectSessions.connectionId, connection.id),
            eq(bankingConnectSessions.status, "pending"),
          ),
        );
      return await tx
        .insert(bankingConnectSessions)
        .values({
          orgId: args.owner.orgId,
          userId: args.owner.userId,
          connectionId: connection.id,
          mode: args.body.mode,
          institutionLoginId: args.body.institutionLoginId ?? null,
        })
        .returning();
    });
    signal.throwIfAborted();
    if (!session) {
      return userError(
        409,
        "BANKING_SESSION_NOT_CREATED",
        "The banking session could not be created",
      );
    }

    const providerBody = connectSessionBody({
      connection,
      session,
      redirectOrigin: args.redirectOrigin,
      webhookOrigin: args.webhookOrigin,
    });
    if (isUserErrorResponse(providerBody)) {
      await db
        .update(bankingConnectSessions)
        .set({ status: "failed", completedAt: nowDate(), updatedAt: nowDate() })
        .where(eq(bankingConnectSessions.id, session.id));
      signal.throwIfAborted();
      return providerBody;
    }
    const providerResult = await fetchFinicityJson(
      session.mode === "fix"
        ? "/connect/v2/generate/fix"
        : "/connect/v2/generate",
      signal,
      { method: "POST", body: providerBody },
    );
    signal.throwIfAborted();
    if (isBankingErrorResponse(providerResult)) {
      await db
        .update(bankingConnectSessions)
        .set({ status: "failed", completedAt: nowDate(), updatedAt: nowDate() })
        .where(eq(bankingConnectSessions.id, session.id));
      signal.throwIfAborted();
      return providerResponseError(providerResult);
    }
    const url = finicityConnectUrl(providerResult);
    if (!url) {
      await db
        .update(bankingConnectSessions)
        .set({ status: "failed", completedAt: nowDate(), updatedAt: nowDate() })
        .where(eq(bankingConnectSessions.id, session.id));
      signal.throwIfAborted();
      return userError(
        502,
        "FINICITY_INVALID_RESPONSE",
        "Mastercard Data Connect returned an invalid response",
      );
    }

    return { status: 200 as const, body: { sessionId: session.id, url } };
  },
);

const DURATION_MS: Readonly<Record<BankingGrantDuration, number>> = {
  "1h": 60 * 60 * 1000,
  "24h": 24 * 60 * 60 * 1000,
  "7d": 7 * 24 * 60 * 60 * 1000,
  "30d": 30 * 24 * 60 * 60 * 1000,
};

export const saveBankingAgentGrant$ = command(
  async (
    { set },
    args: {
      readonly owner: BankingOwner;
      readonly body: BankingAgentGrantRequest;
    },
  ) => {
    const db = set(writeDb$);
    const agent = await findAgent(db, args.owner, args.body.agentId);
    if (!agent) {
      return userError(404, "AGENT_NOT_FOUND", "Agent not found");
    }
    const connection = await findConnection(db, args.owner);
    if (!connection) {
      return userError(
        409,
        "BANKING_CONNECTION_REQUIRED",
        "Connect a bank before granting access",
      );
    }

    const accountIds = [...new Set(args.body.accountIds)];
    const accountRows = await db
      .select({
        id: bankingAccounts.id,
        providerAccountId: bankingAccounts.providerAccountId,
      })
      .from(bankingAccounts)
      .where(
        and(
          eq(bankingAccounts.connectionId, connection.id),
          eq(bankingAccounts.orgId, args.owner.orgId),
          eq(bankingAccounts.userId, args.owner.userId),
          eq(bankingAccounts.enabled, true),
          isNull(bankingAccounts.repairRequiredAt),
          inArray(bankingAccounts.id, accountIds),
        ),
      );
    if (accountRows.length !== accountIds.length) {
      return userError(
        400,
        "BANKING_ACCOUNT_NOT_AVAILABLE",
        "Select only active accounts from this banking connection",
      );
    }

    const expiresAt = new Date(
      nowDate().getTime() + DURATION_MS[args.body.duration],
    );
    await db
      .insert(bankingAgentEnablements)
      .values({
        orgId: args.owner.orgId,
        userId: args.owner.userId,
        agentId: args.body.agentId,
        connectionId: connection.id,
        accountProviderIds: accountRows.map((account) => {
          return account.providerAccountId;
        }),
        operationScopes: [...BANKING_OPERATION_SCOPES],
        allowAutomationRuns: false,
        purpose: args.body.purpose,
        expiresAt,
        revokedAt: null,
      })
      .onConflictDoUpdate({
        target: [
          bankingAgentEnablements.orgId,
          bankingAgentEnablements.userId,
          bankingAgentEnablements.agentId,
          bankingAgentEnablements.connectionId,
        ],
        set: {
          accountProviderIds: accountRows.map((account) => {
            return account.providerAccountId;
          }),
          operationScopes: [...BANKING_OPERATION_SCOPES],
          allowAutomationRuns: false,
          purpose: args.body.purpose,
          expiresAt,
          revokedAt: null,
          updatedAt: nowDate(),
        },
      });

    const status = await statusResponse(db, args.owner, args.body.agentId);
    return isUserErrorResponse(status)
      ? status
      : { status: 200 as const, body: status };
  },
);

export const revokeBankingAgentGrant$ = command(
  async (
    { set },
    args: { readonly owner: BankingOwner; readonly agentId: string },
  ) => {
    const db = set(writeDb$);
    const connection = await findConnection(db, args.owner);
    if (connection) {
      await db
        .update(bankingAgentEnablements)
        .set({ revokedAt: nowDate(), updatedAt: nowDate() })
        .where(
          and(
            eq(bankingAgentEnablements.orgId, args.owner.orgId),
            eq(bankingAgentEnablements.userId, args.owner.userId),
            eq(bankingAgentEnablements.agentId, args.agentId),
            eq(bankingAgentEnablements.connectionId, connection.id),
            isNull(bankingAgentEnablements.revokedAt),
          ),
        );
    }
    const status = await statusResponse(db, args.owner, args.agentId);
    return isUserErrorResponse(status)
      ? status
      : { status: 200 as const, body: status };
  },
);

function finicityAccounts(body: unknown): readonly Record<string, unknown>[] {
  if (!isRecord(body) || !Array.isArray(body.accounts)) {
    return [];
  }
  return body.accounts.filter(isRecord);
}

function providerAccount(
  account: Record<string, unknown>,
): ProviderAccount | null {
  const providerAccountId = nullableString(account.id);
  if (!providerAccountId) {
    return null;
  }
  const status = nullableString(account.status)?.toLowerCase() ?? null;
  const aggregationStatusCode =
    typeof account.aggregationStatusCode === "number"
      ? account.aggregationStatusCode
      : null;
  return {
    providerAccountId,
    displayName: nullableString(account.name),
    institutionName: nullableString(account.institutionName),
    institutionLoginId: nullableString(account.institutionLoginId),
    accountType: nullableString(account.type),
    accountNumberLast4: nullableString(account.realAccountNumberLast4),
    repairRequired:
      status === "error" ||
      status === "inactive" ||
      (aggregationStatusCode !== null && aggregationStatusCode !== 0),
  };
}

async function fetchCustomerAccounts(
  connection: BankingConnectionRow,
  signal: AbortSignal,
): Promise<readonly ProviderAccount[] | BankingErrorResponse> {
  const result = await fetchFinicityJson(
    `/aggregation/v1/customers/${encodeURIComponent(
      connection.providerCustomerId,
    )}/accounts`,
    signal,
  );
  if (isBankingErrorResponse(result)) {
    return result;
  }
  return finicityAccounts(result).flatMap((account) => {
    const parsed = providerAccount(account);
    return parsed ? [parsed] : [];
  });
}

async function syncCustomerAccounts(
  db: Db,
  connection: BankingConnectionRow,
  owner: BankingOwner,
  providerAccounts: readonly ProviderAccount[],
): Promise<void> {
  const providerIds = new Set(
    providerAccounts.map((account) => {
      return account.providerAccountId;
    }),
  );
  await db.transaction(async (tx) => {
    for (const account of providerAccounts) {
      const repairRequiredAt = account.repairRequired ? nowDate() : null;
      await tx
        .insert(bankingAccounts)
        .values({
          connectionId: connection.id,
          orgId: owner.orgId,
          userId: owner.userId,
          providerAccountId: account.providerAccountId,
          displayName: account.displayName,
          institutionName: account.institutionName,
          institutionLoginId: account.institutionLoginId,
          accountType: account.accountType,
          accountNumberLast4: account.accountNumberLast4,
          enabled: true,
          repairRequiredAt,
        })
        .onConflictDoUpdate({
          target: [
            bankingAccounts.connectionId,
            bankingAccounts.providerAccountId,
          ],
          set: {
            displayName: account.displayName,
            institutionName: account.institutionName,
            institutionLoginId: account.institutionLoginId,
            accountType: account.accountType,
            accountNumberLast4: account.accountNumberLast4,
            enabled: true,
            repairRequiredAt,
            updatedAt: nowDate(),
          },
        });
    }

    const existing = await tx
      .select({
        id: bankingAccounts.id,
        providerAccountId: bankingAccounts.providerAccountId,
      })
      .from(bankingAccounts)
      .where(
        and(
          eq(bankingAccounts.connectionId, connection.id),
          eq(bankingAccounts.orgId, owner.orgId),
          eq(bankingAccounts.userId, owner.userId),
          eq(bankingAccounts.enabled, true),
        ),
      );
    const removedIds = existing
      .filter((account) => {
        return !providerIds.has(account.providerAccountId);
      })
      .map((account) => {
        return account.id;
      });
    if (removedIds.length > 0) {
      await tx
        .update(bankingAccounts)
        .set({ enabled: false, updatedAt: nowDate() })
        .where(inArray(bankingAccounts.id, removedIds));
    }

    const hasRepairRequired = providerAccounts.some((account) => {
      return account.repairRequired;
    });
    await tx
      .update(bankingConnections)
      .set({
        status: hasRepairRequired ? "repair_required" : "active",
        repairRequiredAt: hasRepairRequired ? nowDate() : null,
        updatedAt: nowDate(),
      })
      .where(eq(bankingConnections.id, connection.id));
  });
}

function webhookData(
  payload: Record<string, unknown>,
): Record<string, unknown> | null {
  if (isRecord(payload.webhookData)) {
    return payload.webhookData;
  }
  if (typeof payload.webhookData !== "string") {
    return null;
  }
  const parsed = safeJsonParse(payload.webhookData);
  return isRecord(parsed) ? parsed : null;
}

function providerOccurredAt(payload: Record<string, unknown>): Date | null {
  const value = payload.eventTimestamp;
  if (typeof value === "number" && Number.isFinite(value)) {
    return new Date(value < 10_000_000_000 ? value * 1000 : value);
  }
  if (typeof value !== "string") {
    return null;
  }
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) ? new Date(milliseconds) : null;
}

export function verifyFinicityWebhookSignature(
  rawBody: string,
  signature: string,
): boolean {
  const secret = env("FINICITY_APP_SECRET");
  if (!secret || !/^[a-f0-9]{64}$/iu.test(signature)) {
    return false;
  }
  const expected = createHmac("sha256", secret).update(rawBody).digest();
  const received = Buffer.from(signature, "hex");
  return (
    received.length === expected.length && timingSafeEqual(received, expected)
  );
}

type ParsedFinicityWebhook =
  | { readonly kind: "invalid" }
  | { readonly kind: "ping" }
  | {
      readonly kind: "event";
      readonly payload: Record<string, unknown>;
      readonly eventType: string;
      readonly eventId: string;
      readonly customerId: string;
      readonly connectionId: string;
      readonly sessionId: string;
    };

function parseFinicityWebhook(rawBody: string): ParsedFinicityWebhook {
  const payload = safeJsonParse(rawBody);
  if (!isRecord(payload)) {
    return { kind: "invalid" };
  }
  const eventType = nullableString(payload.eventType)?.toLowerCase();
  if (eventType === "ping") {
    return { kind: "ping" };
  }
  const eventId = nullableString(payload.eventId);
  const customerId = nullableString(payload.customerId);
  const data = webhookData(payload);
  const connectionId = data ? nullableString(data.uniqueCustomerId) : null;
  const sessionId = data ? nullableString(data.uniqueRequestId) : null;
  if (
    !eventType ||
    eventType.length > 64 ||
    !eventId ||
    eventId.length > 128 ||
    !customerId ||
    customerId.length > 128 ||
    !connectionId ||
    !isUuid(connectionId) ||
    !sessionId ||
    !isUuid(sessionId)
  ) {
    return { kind: "invalid" };
  }
  return {
    kind: "event",
    payload,
    eventType,
    eventId,
    customerId,
    connectionId,
    sessionId,
  };
}

type FinicityWebhookEvent = Extract<
  ParsedFinicityWebhook,
  { readonly kind: "event" }
>;

async function persistFinicityWebhookEvent(
  db: Db,
  row: {
    readonly session: BankingConnectSessionRow;
    readonly connection: BankingConnectionRow;
  },
  event: FinicityWebhookEvent,
  providerAccounts: readonly ProviderAccount[],
): Promise<void> {
  const endReason =
    nullableString(event.payload.eventTrigger) ??
    nullableString(event.payload.reason);
  await db.transaction(async (tx) => {
    const inserted = await tx
      .insert(bankingConnectEvents)
      .values({
        eventId: event.eventId,
        sessionId: row.session.id,
        orgId: row.session.orgId,
        userId: row.session.userId,
        connectionId: row.connection.id,
        eventType: event.eventType,
        endReason: endReason?.slice(0, 64) ?? null,
        providerOccurredAt: providerOccurredAt(event.payload),
      })
      .onConflictDoNothing()
      .returning({ eventId: bankingConnectEvents.eventId });
    if (inserted.length === 0) {
      return;
    }

    if (event.eventType === "added") {
      await tx
        .update(bankingConnectSessions)
        .set({ addedAt: nowDate(), updatedAt: nowDate() })
        .where(
          and(
            eq(bankingConnectSessions.id, row.session.id),
            eq(bankingConnectSessions.status, "pending"),
          ),
        );
      return;
    }
    if (event.eventType !== "done") {
      return;
    }

    const [latestSession] = await tx
      .select({ addedAt: bankingConnectSessions.addedAt })
      .from(bankingConnectSessions)
      .where(eq(bankingConnectSessions.id, row.session.id))
      .limit(1);
    const healthy = providerAccounts.some((account) => {
      return (
        !account.repairRequired &&
        (row.session.mode !== "fix" ||
          account.institutionLoginId === row.session.institutionLoginId)
      );
    });
    const completed =
      row.session.mode === "fix"
        ? healthy
        : (row.session.addedAt ?? latestSession?.addedAt ?? null) !== null &&
          healthy;
    const completedAt = nowDate();
    await tx
      .update(bankingConnectSessions)
      .set({
        status: completed ? "completed" : "cancelled",
        doneAt: completedAt,
        completedAt,
        endReason: endReason?.slice(0, 64) ?? null,
        updatedAt: completedAt,
      })
      .where(
        and(
          eq(bankingConnectSessions.id, row.session.id),
          eq(bankingConnectSessions.status, "pending"),
        ),
      );
  });
}

export const handleFinicityWebhook$ = command(
  async (
    { set },
    rawBody: string,
    signal: AbortSignal,
  ): Promise<BankingWebhookResult> => {
    const event = parseFinicityWebhook(rawBody);
    if (event.kind === "invalid") {
      return { kind: "bad_request" };
    }
    if (event.kind === "ping") {
      return { kind: "ok" };
    }
    const { eventType, eventId, customerId, connectionId, sessionId } = event;

    const db = set(writeDb$);
    const [existingEvent] = await db
      .select({ eventId: bankingConnectEvents.eventId })
      .from(bankingConnectEvents)
      .where(eq(bankingConnectEvents.eventId, eventId))
      .limit(1);
    signal.throwIfAborted();
    if (existingEvent) {
      return { kind: "ok" };
    }

    const [row] = await db
      .select({
        session: bankingConnectSessions,
        connection: bankingConnections,
      })
      .from(bankingConnectSessions)
      .innerJoin(
        bankingConnections,
        eq(bankingConnections.id, bankingConnectSessions.connectionId),
      )
      .where(eq(bankingConnectSessions.id, sessionId))
      .limit(1);
    signal.throwIfAborted();
    if (
      !row ||
      row.session.status !== "pending" ||
      row.connection.id !== connectionId ||
      row.connection.providerCustomerId !== customerId
    ) {
      return { kind: "ok" };
    }

    let providerAccounts: readonly ProviderAccount[] = [];
    if (eventType === "added" || eventType === "done") {
      const providerResult = await fetchCustomerAccounts(
        row.connection,
        signal,
      );
      signal.throwIfAborted();
      if (isBankingErrorResponse(providerResult)) {
        return { kind: "processing_failed" };
      }
      providerAccounts = providerResult;
      await syncCustomerAccounts(
        db,
        row.connection,
        { orgId: row.session.orgId, userId: row.session.userId },
        providerAccounts,
      );
      signal.throwIfAborted();
    }

    await persistFinicityWebhookEvent(db, row, event, providerAccounts);
    signal.throwIfAborted();

    return { kind: "ok" };
  },
);
