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
import { agentRuns } from "@okouai/db/runtime/agent-run";
import {
  bankingAccessAuditEvents,
  bankingAccounts,
  bankingAgentEnablements,
  bankingConnections,
  type BankingOperationScope,
} from "@okouai/db/schema/banking";
import type { AgentAuthContext } from "../../types/auth";
import { nowDate } from "../../lib/time";
import { db$, writeDb$ } from "../external/db";
import type { BankingErrorResponse } from "./banking.service";

const PROVIDER = "finicity";
export type BankingAuth = Extract<AgentAuthContext, { readonly orgId: string }>;

export type BankingAccountRow = InferSelectModel<typeof bankingAccounts>;

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

function forbidden(message: string): BankingErrorResponse {
  return {
    status: 403,
    body: { error: { code: "BANKING_ACCESS_DENIED", message } },
  };
}
function isUnattendedTriggerSource(triggerSource: string | null): boolean {
  return (
    triggerSource === "automation-schedule" ||
    triggerSource === "automation-event"
  );
}

/** Authorization and audits finish before their gateway observes cancellation. */
export const recordBankingAudit$ = command(
  async (
    { set },
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
  ): Promise<void> => {
    const db = set(writeDb$);

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
  },
);

function bankingRunColumns() {
  return {
    runId: agentRuns.id,
    agentId: agentRuns.agentId,
    triggerSource: agentRuns.triggerSource,
  };
}

function bankingRunPredicate(auth: BankingAuth) {
  return and(
    eq(agentRuns.id, auth.runId),
    eq(agentRuns.orgId, auth.orgId),
    eq(agentRuns.userId, auth.userId),
  );
}

function bankingGrantColumns() {
  return {
    connectionId: bankingConnections.id,
    providerCustomerId: bankingConnections.providerCustomerId,
    accountProviderIds: bankingAgentEnablements.accountProviderIds,
    operationScopes: bankingAgentEnablements.operationScopes,
    allowAutomationRuns: bankingAgentEnablements.allowAutomationRuns,
  };
}

function bankingGrantPredicate(
  auth: BankingAuth,
  agentId: string,
  nowValue: Date,
) {
  return and(
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
  );
}

const denyBankingAccess$ = command(
  async (
    { set },
    auth: BankingAuth,
    action: BankingOperationScope,
    providerAccountId: string | undefined,
    args: {
      readonly failureCode: string;
      readonly message: string;
      readonly agentId?: string;
      readonly connectionId?: string;
    },
  ): Promise<BankingAccessResult> => {
    await set(recordBankingAudit$, {
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
  },
);

function bankingAccountsPredicate(
  auth: BankingAuth,
  grant: BankingGrantContext,
) {
  return and(
    eq(bankingAccounts.connectionId, grant.connectionId),
    eq(bankingAccounts.orgId, auth.orgId),
    eq(bankingAccounts.userId, auth.userId),
    eq(bankingAccounts.enabled, true),
    isNull(bankingAccounts.repairRequiredAt),
    inArray(bankingAccounts.providerAccountId, grant.accountProviderIds),
  );
}

export const authorizeBankingAccess$ = command(
  async (
    { get, set },
    auth: BankingAuth,
    action: BankingOperationScope,
    providerAccountId: string | undefined,
  ): Promise<BankingAccessResult> => {
    const db = get(db$);
    const [runRow] = await db
      .select(bankingRunColumns())
      .from(agentRuns)
      .where(bankingRunPredicate(auth))
      .limit(1);
    const run: BankingRunContext | null = runRow?.agentId
      ? { ...runRow, agentId: runRow.agentId }
      : null;
    if (!run) {
      return await set(denyBankingAccess$, auth, action, providerAccountId, {
        failureCode: "RUN_NOT_FOUND",
        message: "Banking access requires a current Okou run",
      });
    }

    const nowValue = nowDate();
    const [grantRow] = await db
      .select(bankingGrantColumns())
      .from(bankingConnections)
      .innerJoin(
        bankingAgentEnablements,
        eq(bankingAgentEnablements.connectionId, bankingConnections.id),
      )
      .where(bankingGrantPredicate(auth, run.agentId, nowValue))
      .limit(1);
    const grant: BankingGrantContext | null = grantRow ?? null;
    if (!grant) {
      return await set(denyBankingAccess$, auth, action, providerAccountId, {
        agentId: run.agentId,
        failureCode: "NO_ACTIVE_GRANT",
        message: "Banking is not enabled for this agent",
      });
    }

    if (!grant.operationScopes.includes(action)) {
      return await set(denyBankingAccess$, auth, action, providerAccountId, {
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
      return await set(denyBankingAccess$, auth, action, providerAccountId, {
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
      return await set(denyBankingAccess$, auth, action, providerAccountId, {
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

    const accounts: readonly BankingAccountRow[] = await db
      .select()
      .from(bankingAccounts)
      .where(bankingAccountsPredicate(auth, grant));
    const account = providerAccountId
      ? accounts.find((row) => {
          return row.providerAccountId === providerAccountId;
        })
      : undefined;
    if (providerAccountId && !account) {
      return await set(denyBankingAccess$, auth, action, providerAccountId, {
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
  },
);
