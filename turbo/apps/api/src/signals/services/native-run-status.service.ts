import {
  runStatusSchema,
  type GetRunResponse,
} from "@okouai/api-contracts/contracts/runs";
import { agentRuns } from "@okouai/db/runtime/agent-run";
import { command } from "ccstate";
import { and, eq } from "drizzle-orm";
import { db$ } from "../external/db";
import { awaitWithSignal } from "../utils";

/** One-off caller-owned observation, independent of the public full-Run reader. */
export const readNativeRunStatus$ = command(
  async (
    { get },
    args: {
      readonly runId: string;
      readonly userId: string;
      readonly orgId: string;
    },
    signal: AbortSignal,
  ): Promise<Pick<GetRunResponse, "runId" | "status"> | null> => {
    signal.throwIfAborted();
    const [run] = await awaitWithSignal(
      get(db$)
        .select({ runId: agentRuns.id, status: agentRuns.status })
        .from(agentRuns)
        .where(
          and(
            eq(agentRuns.id, args.runId),
            eq(agentRuns.userId, args.userId),
            eq(agentRuns.orgId, args.orgId),
          ),
        )
        .limit(1),
      signal,
    );
    signal.throwIfAborted();
    return run
      ? { runId: run.runId, status: runStatusSchema.parse(run.status) }
      : null;
  },
);
