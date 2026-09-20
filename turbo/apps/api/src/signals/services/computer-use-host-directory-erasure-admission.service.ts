import { command } from "ccstate";
import {
  assertErasureSubjectWritable,
  type ErasureSubject,
} from "@okouai/db/operations/account-erasure";
import { sql } from "drizzle-orm";

import type { Tx } from "../../lib/db-types";
import { nowDate } from "../../lib/time";
import { writeDb$ } from "../external/db";
import { settle } from "../utils";
import { projectComputerUseHosts } from "./computer-use.service";

const HOST_DIRECTORY_LOCK_TIMEOUT = "1s";
const HOST_DIRECTORY_STATEMENT_TIMEOUT = "5s";

type ComputerUseHostDirectoryOutcome =
  | {
      readonly outcome: "listed";
      readonly value: Awaited<ReturnType<typeof projectComputerUseHosts>>;
    }
  | { readonly outcome: "closed" }
  | { readonly outcome: "unbound" };

function hostDirectorySubjects(args: {
  readonly orgId: string;
  readonly userId: string;
}): readonly ErasureSubject[] {
  return [
    { subjectKind: "user", subjectId: args.userId },
    { subjectKind: "organization", subjectId: args.orgId },
  ];
}

async function setHostDirectoryDeadlines(tx: Tx): Promise<void> {
  await tx.execute(
    sql`SELECT set_config('lock_timeout', ${HOST_DIRECTORY_LOCK_TIMEOUT}, true)`,
  );
  await tx.execute(
    sql`SELECT set_config('statement_timeout', ${HOST_DIRECTORY_STATEMENT_TIMEOUT}, true)`,
  );
}

/**
 * Admits the standalone host directory for its exact host-data owner.
 *
 * User and organization are the complete authority for these rows; a Run,
 * Agent or chat thread does not own this directory. Shared B1 admission is
 * retained through the complete ordered projection and COMMIT without taking a
 * host-row lock. Only B1's exact closure result becomes `closed`; cancellation,
 * timeouts and every other database failure retain their original error.
 */
export const listAdmittedComputerUseHosts$ = command(
  async (
    { set },
    args: {
      readonly orgId: string;
      readonly userId: string;
      /** Undefined for session/PAT, null for an unbound Agent token. */
      readonly boundHostId?: string | null;
    },
    signal: AbortSignal,
  ): Promise<ComputerUseHostDirectoryOutcome> => {
    signal.throwIfAborted();
    const outcome = await set(writeDb$).transaction(
      async (tx): Promise<ComputerUseHostDirectoryOutcome> => {
        await setHostDirectoryDeadlines(tx);
        const admitted = await settle(
          assertErasureSubjectWritable(tx, hostDirectorySubjects(args)),
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

        // Admission may have waited for an earlier closure transaction. The
        // projection clock belongs to the fresh READ COMMITTED state after that
        // wait, not to request start.
        const projection = await projectComputerUseHosts(
          { db: tx, orgId: args.orgId, userId: args.userId, now: nowDate() },
          signal,
        );
        signal.throwIfAborted();

        if (args.boundHostId === null) {
          return { outcome: "unbound" };
        }
        const value =
          args.boundHostId === undefined
            ? projection
            : {
                hosts: projection.hosts.filter((host) => {
                  return host.id === args.boundHostId;
                }),
              };
        signal.throwIfAborted();
        return { outcome: "listed", value };
      },
      { isolationLevel: "read committed" },
    );
    signal.throwIfAborted();
    return outcome;
  },
);
