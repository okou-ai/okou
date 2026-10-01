import { workflowAutomations } from "@okouai/db/schema/workflow";
import { and, eq, sql } from "drizzle-orm";

import { pgTextDecoder } from "../../lib/db-structured-result";

/** An in-memory observation of an existing row, never a persisted revision. */
export interface WorkflowAutomationSnapshot {
  readonly observedUpdatedAt: string;
  readonly observedXmin: string;
}

export function workflowAutomationSnapshotColumns() {
  return {
    observedUpdatedAt: sql`${workflowAutomations.updatedAt}::text`.mapWith(
      pgTextDecoder,
    ),
    observedXmin: sql`${workflowAutomations}.xmin::text`.mapWith(pgTextDecoder),
  };
}

export function workflowAutomationSnapshot(
  row: { readonly id: string } & Partial<WorkflowAutomationSnapshot>,
): WorkflowAutomationSnapshot | undefined {
  return row.observedUpdatedAt === undefined || row.observedXmin === undefined
    ? undefined
    : {
        observedUpdatedAt: row.observedUpdatedAt,
        observedXmin: row.observedXmin,
      };
}

export function workflowAutomationSnapshotCondition(
  snapshot: WorkflowAutomationSnapshot | undefined,
) {
  return snapshot === undefined
    ? undefined
    : and(
        sql`${workflowAutomations.updatedAt} = ${snapshot.observedUpdatedAt}::timestamptz`,
        sql`${workflowAutomations}.xmin::text = ${snapshot.observedXmin}`,
      );
}

export function observedWorkflowAutomationCondition(
  row: { readonly id: string } & Partial<WorkflowAutomationSnapshot>,
) {
  const snapshot = workflowAutomationSnapshot(row);
  if (snapshot === undefined) {
    throw new Error("Automation mutation requires its observed row snapshot");
  }
  return and(
    eq(workflowAutomations.id, row.id),
    workflowAutomationSnapshotCondition(snapshot),
  );
}
