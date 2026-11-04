import { command } from "ccstate";
import { sql } from "drizzle-orm";
import {
  array,
  discriminatedUnion,
  literal,
  object,
  string,
  unknown as zUnknown,
} from "zod";

import { writeDb$ } from "../external/db";
import { parseRawRows } from "../../lib/db-raw-rows";
import { safeSqlStateCode } from "../../lib/pg-errors";
import { settle } from "../utils";
import { reconcileAutomationEventWatches$ } from "./automation-event-watch-lifecycle.service";

interface DeleteWorkflowInput {
  readonly orgId: string;
  readonly workflowId: string;
  readonly allowOfficialInstallationDeletion?: boolean;
  readonly requiredOfficialInstallationState?: "installing";
}

const deletionResultSchema = discriminatedUnion("deleted", [
  object({ deleted: literal(false) }),
  object({
    deleted: literal(true),
    automations: array(
      object({
        orgId: string(),
        ownerUserId: string(),
        eventType: string().nullable(),
        eventConfig: zUnknown(),
        eventConnectorId: string().nullable(),
      }),
    ),
  }),
]);
const deletionRowSchema = object({ result: deletionResultSchema });

function workflowDeletionDatabaseError(error: unknown): Error {
  if (
    error instanceof Error &&
    typeof error.cause === "object" &&
    error.cause !== null &&
    "constraint" in error.cause
  ) {
    if (error.cause.constraint === "workflow_deletion_official_protected") {
      return new Error(
        "Uninstall Official Workflows through the Official installation endpoint",
      );
    }
    if (error.cause.constraint === "workflow_deletion_attachment_owner") {
      return new Error("Workflow attachment package has a foreign owner");
    }
  }
  return new Error(
    `Workflow deletion SQL execution failed (${safeSqlStateCode(error) ?? "unknown"})`,
  );
}

const deleteWorkflowRows$ = command(
  async ({ set }, args: DeleteWorkflowInput, signal: AbortSignal) => {
    const writeDb = set(writeDb$);
    const query = sql`SELECT public.delete_workflow_rows(
      ${args.orgId}, ${args.workflowId}::uuid,
      ${args.allowOfficialInstallationDeletion === true},
      ${args.requiredOfficialInstallationState ?? null}
    ) AS result`;
    const rowSchema = deletionRowSchema;
    const result = await (async () => {
      const deletion = await settle(
        (async () => {
          return parseRawRows(rowSchema, await writeDb.execute(query));
        })(),
      );
      if (!deletion.ok) {
        throw workflowDeletionDatabaseError(deletion.error);
      }
      const [row] = deletion.value;
      if (!row) {
        throw new Error("Workflow deletion returned no outcome");
      }
      return row.result;
    })();
    signal.throwIfAborted();
    return result;
  },
);

export const deleteWorkflow$ = command(
  async (
    { set },
    args: DeleteWorkflowInput,
    signal: AbortSignal,
  ): Promise<boolean> => {
    const result = await set(deleteWorkflowRows$, args, signal);
    if (!result.deleted) {
      return false;
    }
    await set(
      reconcileAutomationEventWatches$,
      {
        automations: result.automations,
      },
      signal,
    );
    signal.throwIfAborted();
    return true;
  },
);
