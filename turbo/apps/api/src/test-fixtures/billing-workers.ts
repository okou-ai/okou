import { createStore } from "ccstate";
import { z } from "zod";

import { setRootSignal$ } from "../signals/context/root";
import {
  setUsagePricingResolution$,
  type UsagePricingResolution,
} from "../signals/context/usage-pricing-resolution";
import { configureChatRunFinishedEventDispatcher$ } from "../signals/services/chat-run-finished-event-registration.service";
import { processOrgUsageEvents$ } from "../signals/services/credit-usage.service";
import {
  reconcileBillingEntitlementsForOrganizations$,
  reconcileUndeliveredStripePaidCheckoutSessions$,
  reconcileUndeliveredStripePaidInvoices$,
} from "../signals/services/cron-billing-entitlements.service";
import { configureOfficialWorkflowReconciliationDispatcher$ } from "../signals/services/official-workflow-reconciliation-registration.service";

const orgIdSchema = z.string().min(1);
const reconciliationScopeSchema = z.object({
  orgIds: z.array(orgIdSchema).min(1).max(100),
  replayUndeliveredPaidCheckouts: z.boolean().optional(),
  replayUndeliveredPaidInvoices: z.boolean().optional(),
});

function createBillingWorkerStore(signal: AbortSignal) {
  const store = createStore();
  store.set(setRootSignal$, signal);
  // Preserve the API command graph for postcommit effects and queued Run picks.
  store.set(configureChatRunFinishedEventDispatcher$);
  store.set(configureOfficialWorkflowReconciliationDispatcher$);
  return store;
}

export async function processOrgUsageEventsForTest(
  {
    orgId,
    usagePricingResolution,
  }: {
    readonly orgId: string;
    readonly usagePricingResolution?: UsagePricingResolution;
  },
  signal: AbortSignal,
): Promise<void> {
  signal.throwIfAborted();
  const ownedOrgId = orgIdSchema.parse(orgId);
  const store = createBillingWorkerStore(signal);
  if (usagePricingResolution) {
    store.set(setUsagePricingResolution$, usagePricingResolution);
  }
  await store.set(processOrgUsageEvents$, ownedOrgId, signal);
  signal.throwIfAborted();
}

export async function reconcileBillingOrganizationsForTest(
  scope: {
    readonly orgIds: readonly string[];
    readonly replayUndeliveredPaidCheckouts?: boolean;
    readonly replayUndeliveredPaidInvoices?: boolean;
  },
  signal: AbortSignal,
) {
  signal.throwIfAborted();
  const ownedScope = reconciliationScopeSchema.parse(scope);
  const store = createBillingWorkerStore(signal);
  // Replay queries are provider-wide. Callers own the finite Stripe event pages;
  // only the final entitlement worker selects organizations by these IDs.
  if (ownedScope.replayUndeliveredPaidCheckouts) {
    await store.set(reconcileUndeliveredStripePaidCheckoutSessions$, signal);
    signal.throwIfAborted();
  }
  if (ownedScope.replayUndeliveredPaidInvoices) {
    await store.set(reconcileUndeliveredStripePaidInvoices$, signal);
    signal.throwIfAborted();
  }
  const result = await store.set(
    reconcileBillingEntitlementsForOrganizations$,
    ownedScope.orgIds,
    signal,
  );
  signal.throwIfAborted();
  return result;
}
