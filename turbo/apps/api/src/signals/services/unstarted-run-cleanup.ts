import { agentRuns } from "@okouai/db/runtime/agent-run";
import { modelProviderAccounts } from "@okouai/db/schema/model-provider-account";
import { modelProviders } from "@okouai/db/schema/model-provider";
import { and, count, eq, gte, isNotNull, sql } from "drizzle-orm";
import { QueryBuilder } from "drizzle-orm/pg-core";

export function poisonAccountCleanupCondition() {
  const query = new QueryBuilder();
  return and(
    isNotNull(modelProviderAccounts.disconnectedAt),
    gte(query.select({ count: count() }).from(sql`poison_run_billing`), 0),
    gte(
      query.select({ count: count() }).from(sql`poison_removed_diagnostics`),
      0,
    ),
    sql`EXISTS (
      SELECT 1 FROM poison_terminal_runs
      WHERE poison_terminal_runs.model_provider_id = ${modelProviderAccounts.id}
        AND poison_terminal_runs.org_id = ${modelProviderAccounts.orgId}
        AND poison_terminal_runs.user_id = ${modelProviderAccounts.userId}
    ) AND NOT EXISTS (
      SELECT 1 FROM ${agentRuns}
      WHERE ${eq(agentRuns.modelProviderId, modelProviderAccounts.id)}
        AND ${eq(agentRuns.orgId, modelProviderAccounts.orgId)}
        AND ${eq(agentRuns.userId, modelProviderAccounts.userId)}
        AND ${agentRuns.status} IN ('pending', 'running')
        AND NOT EXISTS (
          SELECT 1 FROM poison_terminal_runs
          WHERE poison_terminal_runs.id = ${agentRuns.id}
        )
    )`,
  );
}

export function poisonProviderCleanupCondition() {
  return sql`${modelProviders.id} IN (
    SELECT model_provider_id FROM poison_removed_accounts
  ) AND NOT EXISTS (
    SELECT 1 FROM ${modelProviderAccounts}
    WHERE ${eq(modelProviderAccounts.modelProviderId, modelProviders.id)}
      AND NOT EXISTS (
        SELECT 1 FROM poison_removed_accounts
        WHERE poison_removed_accounts.id = ${modelProviderAccounts.id}
      )
  )`;
}
