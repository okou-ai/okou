import { agentRuns } from "@okouai/db/runtime/agent-run";
import { and, eq, isNotNull } from "drizzle-orm";

import type { ReadonlyDb } from "../external/db";

export type ChildAutonomyBudget =
  | { readonly kind: "ok"; readonly autonomyBudget: number }
  | { readonly kind: "exhausted" };

export function childAutonomyBudget(
  sourceAutonomyBudget: number,
): ChildAutonomyBudget {
  if (sourceAutonomyBudget === 0) {
    return { kind: "exhausted" };
  }
  return { kind: "ok", autonomyBudget: sourceAutonomyBudget - 1 };
}

export async function loadRunAutonomyBudget(
  db: ReadonlyDb,
  runId: string,
): Promise<number | null> {
  const [run] = await db
    .select({
      autonomyBudget: agentRuns.autonomyBudget,
    })
    .from(agentRuns)
    .where(and(eq(agentRuns.id, runId), isNotNull(agentRuns.triggerSource)))
    .limit(1);
  return run?.autonomyBudget ?? null;
}
