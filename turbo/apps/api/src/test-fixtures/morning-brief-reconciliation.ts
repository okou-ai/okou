import {
  clearReconfigurationPersistedHookForTest,
  setReconfigurationPersistedHookForTest,
} from "../signals/services/official-workflow-reconciliation.service";
import { createDeferredPromise } from "../signals/utils";

/**
 * Hold one real Official Workflow reconciliation after its first transaction.
 *
 * The persisted legacy row and durable schedule changes are committed before
 * this barrier. Releasing it lets the production watch/finalize/compensation
 * stages continue, so tests can land a real cutover or Settings write between
 * those transactions without sleeping.
 */
export function holdMorningBriefReconfigurationAfterPersist(args: {
  readonly workflowId: string;
  readonly automationId: string;
  readonly signal: AbortSignal;
}): {
  readonly arrival: Promise<void>;
  readonly release: () => void;
} {
  const arrival = createDeferredPromise<void>(args.signal);
  const resume = createDeferredPromise<void>(args.signal);
  setReconfigurationPersistedHookForTest(async (snapshot) => {
    if (
      snapshot.definitionName !== "morning-brief" ||
      snapshot.workflowId !== args.workflowId ||
      snapshot.automationId !== args.automationId
    ) {
      return;
    }
    arrival.resolve(undefined);
    await resume.promise;
  });
  return {
    arrival: arrival.promise,
    release: () => {
      clearReconfigurationPersistedHookForTest();
      if (!resume.settled()) {
        resume.resolve(undefined);
      }
    },
  };
}
