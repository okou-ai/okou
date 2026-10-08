import { officialWorkflowReconciliationWork } from "@okouai/db/schema/official-workflow-catalog";
import { workflows } from "@okouai/db/schema/workflow";
import { command } from "ccstate";
import { and, asc, eq, gt, lte, or, sql } from "drizzle-orm";
import { z } from "zod";

import { parseRawRows } from "../../lib/db-raw-rows";

import { logger } from "../../lib/log";
import { nowDate } from "../../lib/time";
import { db$, writeDb$ } from "../external/db";
import { settle } from "../utils";
import { readAcceptedOfficialWorkflowCatalog$ } from "./official-workflow-catalog-read.service";
import { reconcileOfficialWorkflowInstallation$ } from "./official-workflow-reconciliation.service";

const log = logger("OfficialWorkflowReconciliationWorker");
const WORK_BATCH_SIZE = 4;
const INSTALLATION_BATCH_SIZE = 20;
const WORK_LEASE_MS = 5 * 60 * 1000;
const MAX_RETRY_DELAY_MS = 15 * 60 * 1000;

interface ClaimedWork {
  readonly definitionName: string;
  readonly requestedReleaseId: string;
  readonly cursorWorkflowId: string | null;
  readonly leaseId: string;
  readonly attemptCount: number;
}

interface OfficialWorkflowReconciliationWorkerResult {
  readonly claimed: number;
  readonly completed: number;
  readonly advanced: number;
  readonly retried: number;
  readonly installations: number;
}

const claimedWorkRowSchema = z.object({
  definition_name: z.string(),
  requested_release_id: z.string(),
  cursor_workflow_id: z.uuid().nullable(),
  lease_id: z.uuid(),
  attempt_count: z.int().nonnegative(),
});

const claimReconciliationWork$ = command(
  async ({ set }, signal: AbortSignal): Promise<readonly ClaimedWork[]> => {
    const db = set(writeDb$);
    const currentTime = nowDate();
    const eligible = db.$with("eligible").as(
      db
        .select({
          definitionName: officialWorkflowReconciliationWork.definitionName,
          availableAt: officialWorkflowReconciliationWork.availableAt,
        })
        .from(officialWorkflowReconciliationWork)
        .where(
          and(
            lte(officialWorkflowReconciliationWork.availableAt, currentTime),
            or(
              eq(officialWorkflowReconciliationWork.state, "pending"),
              and(
                eq(officialWorkflowReconciliationWork.state, "running"),
                lte(
                  officialWorkflowReconciliationWork.leaseExpiresAt,
                  currentTime,
                ),
              ),
            ),
          ),
        )
        .orderBy(
          asc(officialWorkflowReconciliationWork.availableAt),
          asc(officialWorkflowReconciliationWork.definitionName),
        )
        .limit(WORK_BATCH_SIZE)
        .for("update", { skipLocked: true }),
    );
    // Selection and lease replacement commit in one statement under the existing work-row locks.
    const claimSql = db
      .with(eligible)
      .update(officialWorkflowReconciliationWork)
      .set({
        state: "running",
        leaseId: sql`gen_random_uuid()`,
        leaseExpiresAt: new Date(currentTime.getTime() + WORK_LEASE_MS),
        attemptCount: sql`${officialWorkflowReconciliationWork.attemptCount} + 1`,
        updatedAt: currentTime,
      })
      .from(eligible)
      .where(
        eq(
          officialWorkflowReconciliationWork.definitionName,
          eligible.definitionName,
        ),
      )
      .returning({
        definitionName: officialWorkflowReconciliationWork.definitionName,
        requestedReleaseId:
          officialWorkflowReconciliationWork.requestedReleaseId,
        cursorWorkflowId: officialWorkflowReconciliationWork.cursorWorkflowId,
        leaseId: officialWorkflowReconciliationWork.leaseId,
        attemptCount: officialWorkflowReconciliationWork.attemptCount,
        availableAt: eligible.availableAt,
      })
      .getSQL();
    const rows = parseRawRows(
      claimedWorkRowSchema,
      await db.execute(sql`
        WITH claimed AS (${claimSql})
        SELECT * FROM claimed ORDER BY available_at, definition_name
      `),
    );
    signal.throwIfAborted();
    return rows.map((row) => {
      return {
        definitionName: row.definition_name,
        requestedReleaseId: row.requested_release_id,
        cursorWorkflowId: row.cursor_workflow_id,
        leaseId: row.lease_id,
        attemptCount: row.attempt_count,
      };
    });
  },
);

const loadInstallationPage$ = command(
  async (
    { get },
    work: ClaimedWork,
    signal: AbortSignal,
  ): Promise<
    readonly {
      readonly id: string;
      readonly orgId: string;
      readonly ownerUserId: string;
    }[]
  > => {
    const rows = await get(db$)
      .select({
        id: workflows.id,
        orgId: workflows.orgId,
        ownerUserId: workflows.ownerUserId,
      })
      .from(workflows)
      .where(
        and(
          eq(workflows.officialDefinitionName, work.definitionName),
          eq(workflows.officialInstallationState, "installed"),
          work.cursorWorkflowId === null
            ? undefined
            : gt(workflows.id, work.cursorWorkflowId),
        ),
      )
      .orderBy(asc(workflows.id))
      .limit(INSTALLATION_BATCH_SIZE);
    signal.throwIfAborted();
    return rows;
  },
);

function retryDelay(attemptCount: number): number {
  return Math.min(
    MAX_RETRY_DELAY_MS,
    1000 * 2 ** Math.min(Math.max(attemptCount - 1, 0), 9),
  );
}

const retryWork$ = command(
  async (
    { set },
    args: {
      readonly work: ClaimedWork;
      readonly cursorWorkflowId: string | null;
      readonly message: string;
    },
    signal: AbortSignal,
  ): Promise<void> => {
    const db = set(writeDb$);
    const currentTime = nowDate();
    await db
      .update(officialWorkflowReconciliationWork)
      .set({
        cursorWorkflowId: args.cursorWorkflowId,
        state: "pending",
        leaseId: null,
        leaseExpiresAt: null,
        availableAt: new Date(
          currentTime.getTime() + retryDelay(args.work.attemptCount),
        ),
        lastError: args.message.slice(0, 4096),
        updatedAt: currentTime,
      })
      .where(
        and(
          eq(
            officialWorkflowReconciliationWork.definitionName,
            args.work.definitionName,
          ),
          eq(
            officialWorkflowReconciliationWork.requestedReleaseId,
            args.work.requestedReleaseId,
          ),
          eq(officialWorkflowReconciliationWork.state, "running"),
          eq(officialWorkflowReconciliationWork.leaseId, args.work.leaseId),
        ),
      );
    signal.throwIfAborted();
  },
);

const advanceOrCompleteWork$ = command(
  async (
    { set },
    args: {
      readonly work: ClaimedWork;
      readonly cursorWorkflowId: string | null;
      readonly complete: boolean;
    },
    signal: AbortSignal,
  ): Promise<boolean> => {
    const db = set(writeDb$);
    const condition = and(
      eq(
        officialWorkflowReconciliationWork.definitionName,
        args.work.definitionName,
      ),
      eq(
        officialWorkflowReconciliationWork.requestedReleaseId,
        args.work.requestedReleaseId,
      ),
      eq(officialWorkflowReconciliationWork.state, "running"),
      eq(officialWorkflowReconciliationWork.leaseId, args.work.leaseId),
    );
    if (args.complete) {
      const [deleted] = await db
        .delete(officialWorkflowReconciliationWork)
        .where(condition)
        .returning({
          definitionName: officialWorkflowReconciliationWork.definitionName,
        });
      signal.throwIfAborted();
      return deleted !== undefined;
    }
    const currentTime = nowDate();
    const [updated] = await db
      .update(officialWorkflowReconciliationWork)
      .set({
        cursorWorkflowId: args.cursorWorkflowId,
        state: "pending",
        leaseId: null,
        leaseExpiresAt: null,
        availableAt: currentTime,
        attemptCount: 0,
        lastError: null,
        updatedAt: currentTime,
      })
      .where(condition)
      .returning({
        definitionName: officialWorkflowReconciliationWork.definitionName,
      });
    signal.throwIfAborted();
    return updated !== undefined;
  },
);

const processClaimedWork$ = command(
  async (
    { set },
    work: ClaimedWork,
    signal: AbortSignal,
  ): Promise<{
    readonly outcome: "completed" | "advanced" | "retried";
    readonly installations: number;
  }> => {
    const catalog = await set(readAcceptedOfficialWorkflowCatalog$, signal);
    const definition = catalog?.payload.definitions.find((candidate) => {
      return candidate.name === work.definitionName;
    });
    if (!definition || definition.lifecycle !== "active") {
      const completed = await set(
        advanceOrCompleteWork$,
        {
          work,
          cursorWorkflowId: work.cursorWorkflowId,
          complete: true,
        },
        signal,
      );
      return {
        outcome: completed ? "completed" : "advanced",
        installations: 0,
      };
    }
    const installations = await set(loadInstallationPage$, work, signal);
    signal.throwIfAborted();
    let cursorWorkflowId = work.cursorWorkflowId;
    let processed = 0;
    for (const installation of installations) {
      const result = await set(
        reconcileOfficialWorkflowInstallation$,
        {
          orgId: installation.orgId,
          member: { userId: installation.ownerUserId, role: "member" },
          workflowId: installation.id,
          activeDefinitionOnly: true,
        },
        signal,
      );
      signal.throwIfAborted();
      if (result.kind === "retry") {
        await set(
          retryWork$,
          {
            work,
            cursorWorkflowId,
            message: result.message,
          },
          signal,
        );
        log.warn("Official Workflow reconciliation will retry", {
          definitionName: work.definitionName,
          workflowId: installation.id,
          message: result.message,
        });
        return {
          outcome: "retried" as const,
          installations: processed,
        };
      }
      cursorWorkflowId = installation.id;
      processed++;
    }
    const complete = installations.length < INSTALLATION_BATCH_SIZE;
    const advanced = await set(
      advanceOrCompleteWork$,
      {
        work,
        cursorWorkflowId,
        complete,
      },
      signal,
    );
    return {
      outcome:
        complete && advanced ? ("completed" as const) : ("advanced" as const),
      installations: processed,
    };
  },
);

export const executeOfficialWorkflowReconciliationWork$ = command(
  async (
    { set },
    signal: AbortSignal,
  ): Promise<OfficialWorkflowReconciliationWorkerResult> => {
    const claimed = await set(claimReconciliationWork$, signal);
    signal.throwIfAborted();
    let completed = 0;
    let advanced = 0;
    let retried = 0;
    let installations = 0;
    for (const work of claimed) {
      const processed = await settle(
        set(processClaimedWork$, work, signal),
        signal,
      );
      const result = processed.ok
        ? processed.value
        : await (async () => {
            const message =
              processed.error instanceof Error
                ? processed.error.message
                : "Official Workflow reconciliation failed";
            await set(
              retryWork$,
              {
                work,
                cursorWorkflowId: work.cursorWorkflowId,
                message,
              },
              signal,
            );
            log.error("Official Workflow reconciliation work failed", {
              definitionName: work.definitionName,
              error: processed.error,
            });
            return {
              outcome: "retried" as const,
              installations: 0,
            };
          })();
      installations += result.installations;
      if (result.outcome === "completed") {
        completed++;
      } else if (result.outcome === "retried") {
        retried++;
      } else {
        advanced++;
      }
      signal.throwIfAborted();
    }
    return {
      claimed: claimed.length,
      completed,
      advanced,
      retried,
      installations,
    };
  },
);
