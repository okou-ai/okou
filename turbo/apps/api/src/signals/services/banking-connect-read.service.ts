import type { BankingAccessRequestStatusResponse } from "@okouai/api-contracts/contracts/banking";
import { agents } from "@okouai/db/schema/agent";
import {
  bankingAccounts,
  bankingAgentEnablements,
  bankingConnections,
  bankingConnectSessions,
} from "@okouai/db/schema/banking";
import { command } from "ccstate";
import { and, desc, eq, isNull, or, type InferSelectModel } from "drizzle-orm";

import { nowDate } from "../../lib/time";
import { db$ } from "../external/db";

export interface BankingOwner {
  readonly orgId: string;
  readonly userId: string;
}

type UserErrorStatus = 400 | 403 | 404 | 409 | 502 | 503;

export interface UserErrorResponse {
  readonly status: UserErrorStatus;
  readonly body: {
    readonly error: {
      readonly code: string;
      readonly message: string;
    };
  };
}

type BankingConnectionRow = InferSelectModel<typeof bankingConnections>;
type BankingConnectSessionRow = InferSelectModel<typeof bankingConnectSessions>;

const PROVIDER = "finicity";

export function bankingConnectionCondition(owner: BankingOwner) {
  return and(
    eq(bankingConnections.orgId, owner.orgId),
    eq(bankingConnections.userId, owner.userId),
    eq(bankingConnections.provider, PROVIDER),
    isNull(bankingConnections.revokedAt),
    isNull(bankingConnections.deletedAt),
    or(
      eq(bankingConnections.status, "active"),
      eq(bankingConnections.status, "repair_required"),
    ),
  );
}

export const findBankingAgent$ = command(
  async (
    { get },
    owner: BankingOwner,
    agentId: string,
  ): Promise<{ readonly id: string; readonly name: string } | null> => {
    const db = get(db$);
    const [agent] = await db
      .select({
        id: agents.id,
        name: agents.name,
        displayName: agents.displayName,
      })
      .from(agents)
      .where(and(eq(agents.id, agentId), eq(agents.orgId, owner.orgId)))
      .limit(1);

    return agent
      ? { id: agent.id, name: agent.displayName ?? agent.name }
      : null;
  },
);

export const findBankingConnection$ = command(
  async (
    { get },
    owner: BankingOwner,
  ): Promise<BankingConnectionRow | null> => {
    const db = get(db$);
    const [connection] = await db
      .select()
      .from(bankingConnections)
      .where(bankingConnectionCondition(owner))
      .limit(1);

    return connection ?? null;
  },
);

const latestSession$ = command(
  async (
    { get },
    owner: BankingOwner,
    connectionId: string,
  ): Promise<BankingConnectSessionRow | null> => {
    const db = get(db$);
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
  },
);

export const bankingManagementStatusBody$ = command(
  async (
    { get, set },
    owner: BankingOwner,
    agentId: string,
  ): Promise<BankingAccessRequestStatusResponse | UserErrorResponse> => {
    const db = get(db$);
    const agent = await set(findBankingAgent$, owner, agentId);
    if (!agent) {
      return {
        status: 404,
        body: {
          error: { code: "AGENT_NOT_FOUND", message: "Agent not found" },
        },
      };
    }

    const connection = await set(findBankingConnection$, owner);
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
      set(latestSession$, owner, connection.id),
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
  },
);
