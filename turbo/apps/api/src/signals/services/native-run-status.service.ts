import {
  runStatusSchema,
  type GetRunResponse,
} from "@okouai/api-contracts/contracts/runs";
import { agentRuns } from "@okouai/db/runtime/agent-run";
import { computed, type Computed } from "ccstate";
import { and, eq } from "drizzle-orm";
import { db$ } from "../external/db";

/** Native ownership/status only; independent of the public full-Run reader. */
export function nativeRunStatus(args: {
  readonly runId: string;
  readonly userId: string;
  readonly orgId: string;
}): Computed<Promise<Pick<GetRunResponse, "runId" | "status"> | null>> {
  return computed(async (get) => {
    const [run] = await get(db$)
      .select({ runId: agentRuns.id, status: agentRuns.status })
      .from(agentRuns)
      .where(
        and(
          eq(agentRuns.id, args.runId),
          eq(agentRuns.userId, args.userId),
          eq(agentRuns.orgId, args.orgId),
        ),
      )
      .limit(1);
    return run
      ? { runId: run.runId, status: runStatusSchema.parse(run.status) }
      : null;
  });
}
