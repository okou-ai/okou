import { sql } from "drizzle-orm";

import type { Tx } from "../../lib/db-types";
import { singleton } from "../../lib/singleton";

const activeCancellationControllers = singleton(() => {
  return new Map<string, Set<AbortController>>();
});

/** Serialize active-input reservation, API-first publication, and cancellation. */
export async function lockPiApiFirstTurnLifecycle(
  tx: Pick<Tx, "execute">,
  runId: string,
): Promise<void> {
  await tx.execute(
    // eslint-disable-next-line api/no-new-advisory-lock -- 2026-09-26 前存量；禁止新增 advisory lock
    sql`SELECT pg_advisory_xact_lock(hashtextextended(${`pi_api_first_turn:${runId}`}, 0))`,
  );
}

/**
 * Bind one API-first execution to canonical Run cancellation in this API
 * process. The database lifecycle lock and status revalidation remain the
 * cross-process authority; this controller only shortens provider shutdown.
 */
export function registerPiApiFirstTurnCancellation(
  runId: string,
  parentSignal: AbortSignal,
): {
  readonly signal: AbortSignal;
  readonly release: () => void;
} {
  const controller = new AbortController();
  const controllers =
    activeCancellationControllers().get(runId) ?? new Set<AbortController>();
  controllers.add(controller);
  activeCancellationControllers().set(runId, controllers);

  let released = false;
  return {
    signal: AbortSignal.any([parentSignal, controller.signal]),
    release: () => {
      if (released) {
        return;
      }
      released = true;
      controllers.delete(controller);
      if (controllers.size === 0) {
        activeCancellationControllers().delete(runId);
      }
    },
  };
}

/** Abort every local API-first execution after canonical cancellation commits. */
export function abortPiApiFirstTurnAfterCanonicalCancellation(
  runId: string,
): void {
  for (const controller of activeCancellationControllers().get(runId) ?? []) {
    controller.abort();
  }
}
