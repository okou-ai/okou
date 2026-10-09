import { agentRuns } from "@okouai/db/runtime/agent-run";
import { and, eq, isNotNull } from "drizzle-orm";
import { command } from "ccstate";

import { db$ } from "../external/db";

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

export const loadRunAutonomyBudget$ = command(
  async (
    { get },
    runId: string,
    signal: AbortSignal,
  ): Promise<number | null> => {
    const [run] = await get(db$)
      .select({
        autonomyBudget: agentRuns.autonomyBudget,
      })
      .from(agentRuns)
      .where(and(eq(agentRuns.id, runId), isNotNull(agentRuns.triggerSource)))
      .limit(1);
    signal.throwIfAborted();
    return run?.autonomyBudget ?? null;
  },
);
