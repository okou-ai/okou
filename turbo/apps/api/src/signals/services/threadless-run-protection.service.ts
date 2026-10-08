import type { SQL } from "drizzle-orm";
import type { ApiDb, Tx } from "../../lib/db-types";

/** Identity of a Run that generic cancellation or cleanup is about to touch. */
export interface ProtectedRunScope {
  readonly runId: string;
  readonly orgId: string;
  readonly userId: string;
}

/**
 * A module that launches threadless Runs declares here which of them generic
 * cleanup and cancellation must leave alone. Cleanup and cancellation only see
 * this interface; the owning module keeps its own state machine and locks.
 */
export interface ThreadlessRunProtection {
  /**
   * Conditions correlated to `agent_runs` that a Run must satisfy to enter a
   * cleanup sweep. They are a cheap pre-filter; the locked checks below decide.
   */
  readonly sweepEligibility: (
    db: Pick<ApiDb, "select">,
    args: { readonly currentTime: Date },
  ) => readonly SQL[];
  /** Locks the owner's rows; `true` means the active Run must not be cancelled. */
  readonly lockCancellationProtection: (
    tx: Tx,
    run: ProtectedRunScope,
  ) => Promise<boolean>;
  /** Locks the owner's rows; `true` means the terminal Run must not be deleted. */
  readonly lockDeletionProtection: (
    tx: Tx,
    run: ProtectedRunScope & { readonly completedAt: Date },
  ) => Promise<boolean>;
}

export async function lockCancellationProtection(
  protections: readonly ThreadlessRunProtection[],
  tx: Tx,
  run: ProtectedRunScope,
): Promise<boolean> {
  for (const protection of protections) {
    if (await protection.lockCancellationProtection(tx, run)) {
      return true;
    }
  }
  return false;
}

export async function lockDeletionProtection(
  protections: readonly ThreadlessRunProtection[],
  tx: Tx,
  run: ProtectedRunScope & { readonly completedAt: Date },
): Promise<boolean> {
  for (const protection of protections) {
    if (await protection.lockDeletionProtection(tx, run)) {
      return true;
    }
  }
  return false;
}
