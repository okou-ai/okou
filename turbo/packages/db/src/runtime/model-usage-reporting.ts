import { sql, type SQLWrapper } from "drizzle-orm";
import { AUTO_SELECTED_MODEL } from "@okouai/core/auto-run-model";
import { agentRuns } from "../schema/agent-run";

/** Reporting identity only; never changes ledger keys or settled amounts.
 * Callers left join agent_runs by the finalized usage row's run_id.
 */
export function modelUsageDisplayProviderSql(usage: {
  readonly kind: SQLWrapper;
  readonly provider: SQLWrapper;
}) {
  return sql`
    CASE
      WHEN ${usage.kind} = 'model' AND (${usage.provider} LIKE '@preset/%' OR ${agentRuns.selectedModel} = ${AUTO_SELECTED_MODEL})
        THEN COALESCE(NULLIF(${usage.provider}, ''), 'unknown')
      WHEN ${usage.kind} = 'model' AND NULLIF(${agentRuns.selectedModel}, '') IS NOT NULL
        THEN ${agentRuns.selectedModel}
      ELSE COALESCE(NULLIF(${usage.provider}, ''), 'unknown')
    END`;
}
