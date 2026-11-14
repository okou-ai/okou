import { agentRuns } from "@okouai/db/runtime/agent-run";
import { modelProviderAccounts } from "@okouai/db/schema/model-provider-account";
import { modelProviders } from "@okouai/db/schema/model-provider";
import { and, count, eq, gte, isNotNull, sql } from "drizzle-orm";
import { QueryBuilder } from "drizzle-orm/pg-core";

export function unacceptedAccountCleanupCondition() {
  const query = new QueryBuilder();
  return and(
    isNotNull(modelProviderAccounts.disconnectedAt),
    gte(query.select({ count: count() }).from(sql`unaccepted_run_billing`), 0),
    gte(
      query
        .select({ count: count() })
        .from(sql`unaccepted_removed_diagnostics`),
      0,
    ),
    sql`EXISTS (
      SELECT 1 FROM unaccepted_terminal_runs
      WHERE unaccepted_terminal_runs.model_provider_id = ${modelProviderAccounts.id}
        AND unaccepted_terminal_runs.org_id = ${modelProviderAccounts.orgId}
        AND unaccepted_terminal_runs.user_id = ${modelProviderAccounts.userId}
    ) AND NOT EXISTS (
      SELECT 1 FROM ${agentRuns}
      WHERE ${eq(agentRuns.modelProviderId, modelProviderAccounts.id)}
        AND ${eq(agentRuns.orgId, modelProviderAccounts.orgId)}
        AND ${eq(agentRuns.userId, modelProviderAccounts.userId)}
        AND ${agentRuns.status} IN ('pending', 'running')
        AND NOT EXISTS (
          SELECT 1 FROM unaccepted_terminal_runs
          WHERE unaccepted_terminal_runs.id = ${agentRuns.id}
        )
    )`,
  );
}

export function unacceptedProviderCleanupCondition() {
  return sql`${modelProviders.id} IN (
    SELECT model_provider_id FROM unaccepted_removed_accounts
  ) AND NOT EXISTS (
    SELECT 1 FROM ${modelProviderAccounts}
    WHERE ${eq(modelProviderAccounts.modelProviderId, modelProviders.id)}
      AND NOT EXISTS (
        SELECT 1 FROM unaccepted_removed_accounts
        WHERE unaccepted_removed_accounts.id = ${modelProviderAccounts.id}
      )
  )`;
}
