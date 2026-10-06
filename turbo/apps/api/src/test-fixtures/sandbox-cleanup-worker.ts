import { createStore } from "ccstate";
import { z } from "zod";

import {
  setUsagePricingResolution$,
  type UsagePricingResolution,
} from "../signals/context/usage-pricing-resolution";
import { configureChatRunFinishedEventDispatcher$ } from "../signals/services/chat-run-finished-event-registration.service";
import { cleanupSandboxes$ } from "../signals/services/cron-cleanup-sandboxes.service";
import { configureOfficialWorkflowReconciliationDispatcher$ } from "../signals/services/official-workflow-reconciliation-registration.service";

export interface SandboxCleanupScope {
  readonly chatThreadIds: readonly string[];
  readonly runIds: readonly string[];
  readonly exportJobIds: readonly string[];
}

const ownedScopeSchema = z.object({
  chatThreadIds: z.array(z.uuid()),
  runIds: z.array(z.uuid()),
  exportJobIds: z.array(z.uuid()),
});

// Execute the real maintenance worker for the calling test's explicit resources.
export async function cleanupSandboxFixturesForTest(
  {
    scope,
    usagePricingResolution,
  }: {
    readonly scope: SandboxCleanupScope;
    readonly usagePricingResolution?: UsagePricingResolution;
  },
  signal: AbortSignal,
) {
  signal.throwIfAborted();
  const ownedScope = ownedScopeSchema.parse(scope);
  const store = createStore();
  // Cleanup can finish Runs and pick queued work; retain both API dispatchers.
  store.set(configureChatRunFinishedEventDispatcher$);
  store.set(configureOfficialWorkflowReconciliationDispatcher$);
  if (usagePricingResolution) {
    store.set(setUsagePricingResolution$, usagePricingResolution);
  }
  return await store.set(
    cleanupSandboxes$,
    { kind: "fixtures", ...ownedScope },
    signal,
  );
}
