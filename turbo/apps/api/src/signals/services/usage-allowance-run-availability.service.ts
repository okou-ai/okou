import { agentRuns } from "@okouai/db/runtime/agent-run";
import { command } from "ccstate";
import { and, eq } from "drizzle-orm";
import { isForeignKeyViolation } from "../../lib/pg-errors";
import { nowDate } from "../../lib/time";
import { writeDb$ } from "../external/db";
import { settle } from "../utils";
import type { AllowanceAvailability } from "./usage-allowance-availability-plan";
import {
  planRunAllowanceActivation,
  runAllowanceWindowInsertSql,
  runAllowanceWindowsQuery,
} from "./usage-allowance-run-plan";
import {
  entitlementQuery,
  type AllowanceEntitlement,
} from "./usage-allowance-settlement-plan";
import {
  prepareUsageAllowanceRefresh$,
  refreshUsageAllowanceAvailability$,
} from "./usage-allowance.service";

function runWindowAvailability(
  windows: readonly {
    readonly kind: string;
    readonly unitLimit: number;
    readonly consumedUnits: number;
  }[],
): AllowanceAvailability | null {
  const short = windows.find((window) => {
    return window.kind === "short";
  });
  const weekly = windows.find((window) => {
    return window.kind === "weekly";
  });
  if (!short || !weekly) {
    return null;
  }
  const shortRemainingUnits = Math.max(
    short.unitLimit - short.consumedUnits,
    0,
  );
  const weeklyRemainingUnits = Math.max(
    weekly.unitLimit - weekly.consumedUnits,
    0,
  );
  return {
    shortRemainingUnits,
    weeklyRemainingUnits,
    remainingUnits: Math.min(shortRemainingUnits, weeklyRemainingUnits),
  };
}

const publishRunAllowanceWindows$ = command(
  async (
    { set },
    args: {
      readonly orgId: string;
      readonly runId: string;
      readonly runCreatedAt: Date;
    },
    entitlement: AllowanceEntitlement,
    signal: AbortSignal,
  ) => {
    const { rowCount } = await set(writeDb$).execute(
      runAllowanceWindowInsertSql(args, entitlement),
    );
    signal.throwIfAborted();
    return rowCount;
  },
);

/** Issued Run windows remain usable after their entitlement's current period. */
export const resolveUsageAllowanceAvailabilityForRun$ = command(
  async (
    { set },
    args: { readonly orgId: string; readonly runId: string },
    signal: AbortSignal,
  ): Promise<AllowanceAvailability | null> => {
    const db = set(writeDb$);
    const runCondition = and(
      eq(agentRuns.orgId, args.orgId),
      eq(agentRuns.id, args.runId),
    );
    const [run] = await db
      .select({ createdAt: agentRuns.createdAt })
      .from(agentRuns)
      .where(runCondition)
      .limit(1);
    signal.throwIfAborted();
    if (!run) {
      return null;
    }
    const observedWindows = await db
      .select()
      .from(runAllowanceWindowsQuery(args.orgId, run.createdAt));
    signal.throwIfAborted();
    const issued = runWindowAvailability(observedWindows);
    if (issued) {
      return issued;
    }
    const refresh = await set(
      prepareUsageAllowanceRefresh$,
      { orgId: args.orgId },
      signal,
    );
    const available = await set(
      refreshUsageAllowanceAvailability$,
      { orgId: args.orgId, refresh },
      signal,
    );
    if (!available) {
      return null;
    }
    const [owned] = await db.select().from(entitlementQuery(args.orgId));
    signal.throwIfAborted();
    const activation = { ...args, runCreatedAt: run.createdAt };
    const planned = planRunAllowanceActivation(owned, activation, nowDate());
    // The shared command has published the refresh already. A newly expired
    // snapshot is not an invitation to repeat external preparation or charge.
    if (planned.update) {
      throw new Error("Run allowance changed after refresh publication");
    }
    if (!planned.entitlement) {
      return null;
    }
    // Window issuance is not a money reservation. Both missing kinds publish
    // atomically, with the tenant-owned Run and exact entitlement snapshot as
    // SQL gates. Unique identities never reset a concurrent winner's balance.
    const inserted = await settle(
      set(publishRunAllowanceWindows$, activation, planned.entitlement, signal),
      signal,
    );
    if (!inserted.ok) {
      // Natural FK enforcement owns deletion races; no dangling window survives.
      if (isForeignKeyViolation(inserted.error)) {
        return null;
      }
      throw inserted.error;
    }
    signal.throwIfAborted();
    const windows = await db
      .select()
      .from(
        runAllowanceWindowsQuery(
          args.orgId,
          run.createdAt,
          planned.entitlement,
        ),
      );
    signal.throwIfAborted();
    const availability = runWindowAvailability(windows);
    if (!availability) {
      // A CAS miss cannot silently become credit admission. This is one
      // conflict read, never a retry or another issuance attempt.
      const [currentRun] = await db
        .select({ id: agentRuns.id })
        .from(agentRuns)
        .where(runCondition)
        .limit(1);
      signal.throwIfAborted();
      if (!currentRun) {
        return null;
      }
      throw new Error("Run allowance changed during window publication");
    }
    return availability;
  },
);
