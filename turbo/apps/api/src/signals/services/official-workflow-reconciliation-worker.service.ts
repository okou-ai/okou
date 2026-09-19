import { randomUUID } from "node:crypto";

import { officialWorkflowReconciliationWork } from "@okouai/db/schema/official-workflow-catalog";
import { workflows } from "@okouai/db/schema/workflow";
import { command } from "ccstate";
import { and, asc, eq, gt, lte, or } from "drizzle-orm";

import { logger } from "../../lib/log";
import { nowDate } from "../../lib/time";
import { writeDb$, type Db } from "../external/db";
import { settle } from "../utils";
import { readAcceptedOfficialWorkflowCatalog } from "./official-workflow-catalog-read.service";
import {
  reconcileOfficialWorkflowInstallation$,
  type OfficialWorkflowReconciliationResult,
  type ReconcileOfficialWorkflowInstallationArgs,
} from "./official-workflow-reconciliation.service";

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

async function claimReconciliationWork(
  db: Db,
): Promise<readonly ClaimedWork[]> {
  return await db.transaction(async (tx) => {
    const currentTime = nowDate();
    const rows = await tx
      .select()
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
      .for("update", { skipLocked: true });
    const claimed: ClaimedWork[] = [];
    for (const row of rows) {
      const leaseId = randomUUID();
      const attemptCount = row.attemptCount + 1;
      const [updated] = await tx
        .update(officialWorkflowReconciliationWork)
        .set({
          state: "running",
          leaseId,
          leaseExpiresAt: new Date(currentTime.getTime() + WORK_LEASE_MS),
          attemptCount,
          updatedAt: currentTime,
        })
        .where(
          eq(
            officialWorkflowReconciliationWork.definitionName,
            row.definitionName,
          ),
        )
        .returning({
          definitionName: officialWorkflowReconciliationWork.definitionName,
          requestedReleaseId:
            officialWorkflowReconciliationWork.requestedReleaseId,
          cursorWorkflowId: officialWorkflowReconciliationWork.cursorWorkflowId,
        });
      if (updated) {
        claimed.push({ ...updated, leaseId, attemptCount });
      }
    }
    return claimed;
  });
}

async function loadInstallationPage(
  db: Db,
  work: ClaimedWork,
): Promise<
  readonly {
    readonly id: string;
    readonly orgId: string;
    readonly ownerUserId: string;
  }[]
> {
  return await db
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
}

function retryDelay(attemptCount: number): number {
  return Math.min(
    MAX_RETRY_DELAY_MS,
    1000 * 2 ** Math.min(Math.max(attemptCount - 1, 0), 9),
  );
}

async function retryWork(
  db: Db,
  args: {
    readonly work: ClaimedWork;
    readonly cursorWorkflowId: string | null;
    readonly message: string;
  },
): Promise<void> {
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
}

async function advanceOrCompleteWork(
  db: Db,
  args: {
    readonly work: ClaimedWork;
    readonly cursorWorkflowId: string | null;
    readonly complete: boolean;
  },
): Promise<boolean> {
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
  return updated !== undefined;
}

async function processClaimedWork(
  db: Db,
  work: ClaimedWork,
  reconcile: (
    args: ReconcileOfficialWorkflowInstallationArgs,
  ) => Promise<OfficialWorkflowReconciliationResult>,
  signal: AbortSignal,
): Promise<{
  readonly outcome: "completed" | "advanced" | "retried";
  readonly installations: number;
}> {
  const catalog = await readAcceptedOfficialWorkflowCatalog(db, signal);
  const definition = catalog?.payload.definitions.find((candidate) => {
    return candidate.name === work.definitionName;
  });
  if (!definition || definition.lifecycle !== "active") {
    const completed = await advanceOrCompleteWork(db, {
      work,
      cursorWorkflowId: work.cursorWorkflowId,
      complete: true,
    });
    return {
      outcome: completed ? "completed" : "advanced",
      installations: 0,
    };
  }
  const installations = await loadInstallationPage(db, work);
  signal.throwIfAborted();
  let cursorWorkflowId = work.cursorWorkflowId;
  let processed = 0;
  for (const installation of installations) {
    const result = await reconcile({
      orgId: installation.orgId,
      member: { userId: installation.ownerUserId, role: "member" },
      workflowId: installation.id,
      activeDefinitionOnly: true,
    });
    signal.throwIfAborted();
    if (result.kind === "retry") {
      await retryWork(db, {
        work,
        cursorWorkflowId,
        message: result.message,
      });
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
  const advanced = await advanceOrCompleteWork(db, {
    work,
    cursorWorkflowId,
    complete,
  });
  return {
    outcome:
      complete && advanced ? ("completed" as const) : ("advanced" as const),
    installations: processed,
  };
}

export const executeOfficialWorkflowReconciliationWork$ = command(
  async (
    { set },
    signal: AbortSignal,
  ): Promise<OfficialWorkflowReconciliationWorkerResult> => {
    const db = set(writeDb$);
    const claimed = await claimReconciliationWork(db);
    signal.throwIfAborted();
    let completed = 0;
    let advanced = 0;
    let retried = 0;
    let installations = 0;
    for (const work of claimed) {
      const processed = await settle(
        processClaimedWork(
          db,
          work,
          async (args) => {
            return await set(
              reconcileOfficialWorkflowInstallation$,
              args,
              signal,
            );
          },
          signal,
        ),
        signal,
      );
      const result = processed.ok
        ? processed.value
        : await (async () => {
            const message =
              processed.error instanceof Error
                ? processed.error.message
                : "Official Workflow reconciliation failed";
            await retryWork(db, {
              work,
              cursorWorkflowId: work.cursorWorkflowId,
              message,
            });
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
