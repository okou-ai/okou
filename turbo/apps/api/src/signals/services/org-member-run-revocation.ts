import { captureBillingRunTerminalSql } from "@okouai/db/operations/billing-run-lifecycle";
import { agentRuns } from "@okouai/db/runtime/agent-run";
import { activeAgentRuns } from "@okouai/db/schema/active-agent-run";
import { agentRunConnectorDiagnosticRegistrations } from "@okouai/db/schema/agent-run-connector-diagnostic-registration";
import { modelProviderAccounts } from "@okouai/db/schema/model-provider-account";
import { modelProviderAuthSessions } from "@okouai/db/schema/model-provider-auth-session";
import { modelProviders } from "@okouai/db/schema/model-provider";
import { morningBriefScheduleClaims } from "@okouai/db/schema/morning-brief-schedule-claim";
import { secrets } from "@okouai/db/schema/secret";
import { and, count, eq, gte, inArray, isNotNull, sql } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";

interface MemberScope {
  readonly orgId: string;
  readonly userId: string;
}

function memberTerminalRuns(scope: MemberScope, at: Date) {
  return new PgDialect().buildUpdateQuery({
    table: agentRuns,
    set: {
      status: sql.param("cancelled", agentRuns.status),
      completedAt: sql.param(at, agentRuns.completedAt),
      runnerCancellationMode: sql.param(
        "hard",
        agentRuns.runnerCancellationMode,
      ),
    },
    where: and(
      eq(agentRuns.orgId, scope.orgId),
      eq(agentRuns.userId, scope.userId),
      inArray(agentRuns.status, ["pending", "running"]),
    ),
    joins: [],
    returning: [
      { path: ["id"], field: agentRuns.id },
      { path: ["orgId"], field: agentRuns.orgId },
      { path: ["userId"], field: agentRuns.userId },
      { path: ["runnerGroup"], field: agentRuns.runnerGroup },
      { path: ["modelProviderId"], field: agentRuns.modelProviderId },
      { path: ["startedAt"], field: agentRuns.startedAt },
    ],
  });
}

function disconnectedMemberAccounts() {
  return new PgDialect().buildDeleteQuery({
    table: modelProviderAccounts,
    where: and(
      isNotNull(modelProviderAccounts.disconnectedAt),
      sql`EXISTS (
        SELECT 1 FROM member_terminal_runs
        WHERE member_terminal_runs.model_provider_id = ${modelProviderAccounts.id}
          AND member_terminal_runs.org_id = ${modelProviderAccounts.orgId}
          AND member_terminal_runs.user_id = ${modelProviderAccounts.userId}
      ) AND NOT EXISTS (
        SELECT 1 FROM ${agentRuns}
        WHERE ${eq(agentRuns.modelProviderId, modelProviderAccounts.id)}
          AND ${eq(agentRuns.orgId, modelProviderAccounts.orgId)}
          AND ${eq(agentRuns.userId, modelProviderAccounts.userId)}
          AND ${agentRuns.status} IN ('pending', 'running')
          AND NOT EXISTS (
            SELECT 1 FROM member_terminal_runs
            WHERE member_terminal_runs.id = ${agentRuns.id}
          )
      )`,
      gte(sql`(SELECT ${count()} FROM member_removed_diagnostics)`, 0),
    ),
    returning: [
      { path: ["id"], field: modelProviderAccounts.id },
      {
        path: ["modelProviderId"],
        field: modelProviderAccounts.modelProviderId,
      },
    ],
  });
}

function disconnectedMemberProviders() {
  return new PgDialect().buildDeleteQuery({
    table: modelProviders,
    where: sql`${modelProviders.id} IN (
      SELECT model_provider_id FROM member_removed_accounts
    ) AND NOT EXISTS (
      SELECT 1 FROM ${modelProviderAccounts}
      WHERE ${eq(modelProviderAccounts.modelProviderId, modelProviders.id)}
        AND NOT EXISTS (
          SELECT 1 FROM member_removed_accounts
          WHERE member_removed_accounts.id = ${modelProviderAccounts.id}
        )
    )`,
    returning: [{ path: ["id"], field: modelProviders.id }],
  });
}

function memberCredentialRevocation(scope: MemberScope, at: Date) {
  const dialect = new PgDialect();
  return {
    claims: dialect.buildUpdateQuery({
      table: morningBriefScheduleClaims,
      set: {
        orgId: sql`NULL`,
        ownerUserId: sql`NULL`,
        settlement: sql.param("revoked", morningBriefScheduleClaims.settlement),
        settledAt: sql.param(at, morningBriefScheduleClaims.settledAt),
        updatedAt: sql.param(at, morningBriefScheduleClaims.updatedAt),
      },
      where: and(
        eq(morningBriefScheduleClaims.orgId, scope.orgId),
        eq(morningBriefScheduleClaims.ownerUserId, scope.userId),
        gte(sql`(SELECT ${count()} FROM member_removed_empty_providers)`, 0),
      ),
      joins: [],
      returning: [{ path: ["id"], field: morningBriefScheduleClaims.id }],
    }),
    providers: dialect.buildDeleteQuery({
      table: modelProviders,
      where: and(
        eq(modelProviders.orgId, scope.orgId),
        eq(modelProviders.userId, scope.userId),
        // The preceding cleanup already removed these rows in this statement.
        sql`NOT EXISTS (SELECT 1 FROM member_removed_empty_providers
          WHERE member_removed_empty_providers.id = ${modelProviders.id})`,
        gte(sql`(SELECT ${count()} FROM member_revoked_claims)`, 0),
      ),
      returning: [{ path: ["id"], field: modelProviders.id }],
    }),
    sessions: dialect.buildDeleteQuery({
      table: modelProviderAuthSessions,
      where: and(
        eq(modelProviderAuthSessions.orgId, scope.orgId),
        eq(modelProviderAuthSessions.userId, scope.userId),
        gte(sql`(SELECT ${count()} FROM member_removed_providers)`, 0),
      ),
      returning: [{ path: ["id"], field: modelProviderAuthSessions.id }],
    }),
    secrets: dialect.buildDeleteQuery({
      table: secrets,
      where: and(
        eq(secrets.orgId, scope.orgId),
        eq(secrets.userId, scope.userId),
        eq(secrets.type, "model-provider"),
        gte(sql`(SELECT ${count()} FROM member_removed_auth_sessions)`, 0),
      ),
      returning: [{ path: ["id"], field: secrets.id }],
    }),
  };
}

/** All authority writes precede releasing the never-started Run's active row. */
export function memberRunRevocationSql(
  scope: MemberScope,
  completedAt: Date,
  revokedAt: Date,
) {
  const dialect = new PgDialect();
  const credentials = memberCredentialRevocation(scope, revokedAt);
  const billing = captureBillingRunTerminalSql({
    condition: inArray(
      agentRuns.id,
      sql`(SELECT id FROM member_terminal_runs)`,
    ),
    status: "cancelled",
    completedAt,
  });
  const diagnostics = dialect.buildDeleteQuery({
    table: agentRunConnectorDiagnosticRegistrations,
    where: and(
      inArray(
        agentRunConnectorDiagnosticRegistrations.runId,
        sql`(SELECT id FROM member_terminal_runs)`,
      ),
      gte(sql`(SELECT ${count()} FROM member_terminal_billing)`, 0),
    ),
    returning: [
      {
        path: ["runId"],
        field: agentRunConnectorDiagnosticRegistrations.runId,
      },
    ],
  });
  const released = dialect.buildDeleteQuery({
    table: activeAgentRuns,
    where: and(
      inArray(
        activeAgentRuns.runId,
        sql`(SELECT id FROM member_terminal_runs WHERE started_at IS NULL)`,
      ),
      gte(sql`(SELECT ${count()} FROM member_removed_secrets)`, 0),
    ),
    returning: [
      { path: ["runId"], field: activeAgentRuns.runId },
      { path: ["orgId"], field: activeAgentRuns.orgId },
    ],
  });
  return sql`WITH member_terminal_runs AS (${memberTerminalRuns(scope, completedAt)}),
    member_terminal_billing AS (${billing}),
    member_removed_diagnostics AS (${diagnostics}),
    member_removed_accounts AS (${disconnectedMemberAccounts()}),
    member_removed_empty_providers AS (${disconnectedMemberProviders()}),
    member_revoked_claims AS (${credentials.claims}),
    member_removed_providers AS (${credentials.providers}),
    member_removed_auth_sessions AS (${credentials.sessions}),
    member_removed_secrets AS (${credentials.secrets}),
    member_released_slots AS (${released})
    SELECT member_terminal_runs.id AS "runId",
      member_terminal_runs.org_id AS "orgId",
      member_terminal_runs.runner_group AS "runnerGroup",
      member_released_slots.org_id AS "releasedOrgId"
    FROM member_terminal_runs
    LEFT JOIN member_released_slots
      ON member_released_slots.run_id = member_terminal_runs.id`;
}
