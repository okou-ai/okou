import {
  clearUnjournaledCallbackLineageReadHookForTest,
  setUnjournaledCallbackLineageReadHookForTest,
} from "../signals/services/workflow-automation-run-callback.service";
import { createDeferredPromise } from "../signals/utils";

/**
 * Hold one real unjournaled callback after its optimistic lineage read.
 *
 * The callback has not entered its write transaction yet. Releasing it lets
 * the production retry/revalidation path run against whatever lineage the
 * database transactions committed while it was held.
 */
export function holdUnjournaledCallbackAfterLineageReadFixture(args: {
  readonly automationId: string;
  readonly expectedLineageKind: "morning-brief" | "ordinary-or-absent";
  readonly signal: AbortSignal;
}): { readonly arrival: Promise<void>; readonly release: () => void } {
  const arrival = createDeferredPromise<void>(args.signal);
  const resume = createDeferredPromise<void>(args.signal);
  setUnjournaledCallbackLineageReadHookForTest(async (snapshot) => {
    if (snapshot.automationId !== args.automationId) {
      return;
    }
    if (snapshot.lineageKind !== args.expectedLineageKind) {
      throw new Error(
        `Expected ${args.expectedLineageKind} callback lineage, got ${snapshot.lineageKind}`,
      );
    }
    arrival.resolve(undefined);
    await resume.promise;
  });
  return {
    arrival: arrival.promise,
    release: () => {
      clearUnjournaledCallbackLineageReadHookForTest();
      if (!resume.settled()) {
        resume.resolve(undefined);
      }
    },
  };
}
