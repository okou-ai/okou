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

function isLockedHostRead(queryArgs: unknown[]): boolean {
  const text = barrierQueryText(queryArgs);
  return (
    text.startsWith("select") &&
    text.includes('from "computer_use_hosts"') &&
    text.includes("for update")
  );
}

function lockedHost(transaction: SelectedTransaction): boolean {
  return transaction.statements.some((statement) => {
    return (
      statement.includes('from "computer_use_hosts"') &&
      statement.includes("for update")
    );
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
    return statement.includes("for update")
      ? "LOCKED HOST ROW BY TOKEN"
      : "UNLOCKED HOST IDENTITY BY TOKEN";
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
