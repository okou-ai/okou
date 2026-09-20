import { command } from "ccstate";
import {
  assertErasureSubjectWritable,
  type ErasureSubject,
} from "@okouai/db/operations/account-erasure";
import { sql } from "drizzle-orm";

import type { Tx } from "../../lib/db-types";
import { writeDb$ } from "../external/db";
import { settle } from "../utils";
import { projectComputerUseAuditEvents } from "./computer-use.service";

const AUDIT_EVENTS_LOCK_TIMEOUT = "1s";
const AUDIT_EVENTS_STATEMENT_TIMEOUT = "5s";

type ComputerUseAuditEventsOutcome =
  | {
      readonly outcome: "listed";
      readonly value: Awaited<ReturnType<typeof projectComputerUseAuditEvents>>;
    }
  | { readonly outcome: "closed" };

function auditEventSubjects(args: {
  readonly orgId: string;
  readonly userId: string;
}): readonly ErasureSubject[] {
  return [
    { subjectKind: "user", subjectId: args.userId },
    { subjectKind: "organization", subjectId: args.orgId },
  ];
}

async function setAuditEventDeadlines(tx: Tx): Promise<void> {
  await tx.execute(
    sql`SELECT set_config('lock_timeout', ${AUDIT_EVENTS_LOCK_TIMEOUT}, true)`,
  );
  await tx.execute(
    sql`SELECT set_config('statement_timeout', ${AUDIT_EVENTS_STATEMENT_TIMEOUT}, true)`,
  );
}

/**
 * Admits the standalone audit projection for its exact data owner.
 *
 * User and organization are the complete authority for audit rows. Command,
 * host and run ids remain filters only. Shared B1 admission is retained through
 * the complete ordered/limited projection and COMMIT without business-row
 * locks. Only B1's exact closure result becomes `closed`; cancellation,
 * timeouts and every other database failure retain their original error.
 */
export const listAdmittedComputerUseAuditEvents$ = command(
  async (
    { set },
    args: {
      readonly orgId: string;
      readonly userId: string;
      readonly limit: number;
      readonly commandId?: string;
      readonly hostId?: string;
      readonly runId?: string;
    },
    signal: AbortSignal,
  ): Promise<ComputerUseAuditEventsOutcome> => {
    signal.throwIfAborted();
    const outcome = await set(writeDb$).transaction(
      async (tx): Promise<ComputerUseAuditEventsOutcome> => {
        await setAuditEventDeadlines(tx);
        const admitted = await settle(
          assertErasureSubjectWritable(tx, auditEventSubjects(args)),
        );
        if (!admitted.ok) {
          if (
            admitted.error instanceof Error &&
            admitted.error.message === "account_erasure:subject_closed"
          ) {
            return { outcome: "closed" };
          }
          throw admitted.error;
        }
        signal.throwIfAborted();

        const value = await projectComputerUseAuditEvents(
          { db: tx, ...args },
          signal,
        );
        signal.throwIfAborted();
        return { outcome: "listed", value };
      },
      { isolationLevel: "read committed" },
    );
    signal.throwIfAborted();
    return outcome;
  },
);
