import {
  barrierQueryText,
  isErasureSubjectLockStatement,
  withDatabaseTransactionBarrierFixture,
  type SelectedTransaction,
  type TransactionBarrier,
} from "./account-erasure-subject";

interface ComputerUseHostSessionBarrier extends TransactionBarrier {
  /** Actual statements from the folded subject lock through the paused phase. */
  readonly statements: () => readonly string[];
}

/**
 * Infrastructure exception: no API can pause its own transaction between its
 * statements, and the host session endpoints are exactly where the fence's
 * lock order has to be observed from another session. Every production
 * statement still executes unchanged and in order; only the selected statement
 * is delayed.
 *
 * Selection is the folded subject-lock statement, which is the first statement
 * these routes issue that names an erasure subject, so the barrier cannot
 * latch onto an unrelated transaction that merely reads the same host row.
 */
export async function withComputerUseHostSessionBarrierFixture<T>(
  args: {
    readonly orgId: string;
    /**
     * `locked-host` pauses right after the locked host read has executed, so
     * the transaction holds its host row lock while another session runs.
     * `commit` pauses before the COMMIT of a transaction that locked the host.
     */
    readonly stopAt: "locked-host" | "commit";
    readonly work: (barrier: ComputerUseHostSessionBarrier) => Promise<T>;
  },
  signal: AbortSignal,
): Promise<T> {
  // The unlocked identity read precedes the statement the barrier selects on,
  // so the whole transaction is accumulated from BEGIN through `observe`. The
  // point of this fixture is the order of those two reads around admission.
  const byReceiver = new Map<unknown, string[]>();
  let selectedReceiver: unknown;
  let statements: readonly string[] = [];
  return await withDatabaseTransactionBarrierFixture(
    {
      pauseAfter: args.stopAt === "locked-host",
      observe: (queryArgs, receiver) => {
        const text = barrierQueryText(queryArgs);
        if (text.startsWith("begin")) {
          byReceiver.set(receiver, [text]);
        } else {
          byReceiver.get(receiver)?.push(text);
        }
        if (
          selectedReceiver === undefined &&
          isErasureSubjectLockStatement(queryArgs, {
            subject: { subjectKind: "organization", subjectId: args.orgId },
          })
        ) {
          selectedReceiver = receiver;
        }
      },
      select: (queryArgs) => {
        return isErasureSubjectLockStatement(queryArgs, {
          subject: { subjectKind: "organization", subjectId: args.orgId },
        });
      },
      stopAt: (queryArgs, _selectingStatement, transaction) => {
        const text = barrierQueryText(queryArgs);
        const stops =
          args.stopAt === "locked-host"
            ? isLockedHostRead(queryArgs)
            : text === "commit" && lockedHost(transaction);
        if (stops) {
          // `observe` already recorded this statement for the selected client.
          statements = [...(byReceiver.get(selectedReceiver) ?? [])];
        }
        return stops;
      },
      work: async (barrier) => {
        return await args.work({
          ...barrier,
          statements: () => {
            return statements;
          },
        });
      },
    },
    signal,
  );
}

/** The row-lock clause of a host read, such as `no key update`, if any. */
function hostRowLock(statement: string): string | null {
  if (
    !statement.startsWith("select") ||
    !statement.includes('from "computer_use_hosts"')
  ) {
    return null;
  }
  return (
    / for (no key update|update|key share|share)\b/.exec(statement)?.[1] ?? null
  );
}

function isLockedHostRead(queryArgs: unknown[]): boolean {
  return hostRowLock(barrierQueryText(queryArgs)) !== null;
}

function lockedHost(transaction: SelectedTransaction): boolean {
  return transaction.statements.some((statement) => {
    return hostRowLock(statement) !== null;
  });
}

/** Only the statements a host session route owns. The shared fence prefix is
 * classified by `classifyErasureFenceStatement` and must be consulted first,
 * because the folded read statements legitimately carry a closure subquery. */
export function classifyComputerUseHostSessionSql(
  statement: string,
): string | null {
  if (
    statement.startsWith("select") &&
    statement.includes('from "computer_use_hosts"') &&
    statement.includes('"computer_use_hosts"."token_hash" =')
  ) {
    const lock = hostRowLock(statement);
    return lock === null
      ? "UNLOCKED HOST IDENTITY BY TOKEN"
      : `LOCKED HOST ROW BY TOKEN FOR ${lock.toUpperCase()}`;
  }
  if (statement.startsWith('update "computer_use_hosts"')) {
    return "HOST UPDATE";
  }
  if (
    statement.startsWith("select") &&
    statement.includes('from "computer_use_commands"')
  ) {
    return statement.includes("for update")
      ? "LOCKED COMMAND SELECT"
      : "COMMAND SELECT";
  }
  if (statement.startsWith('update "computer_use_commands"')) {
    return "COMMAND UPDATE";
  }
  return null;
}
