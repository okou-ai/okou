import { createStore } from "ccstate";
import { z } from "zod";

import { setRootSignal$ } from "../signals/context/root";
import {
  setUsagePricingResolution$,
  type UsagePricingResolution,
} from "../signals/context/usage-pricing-resolution";
import { configureChatRunFinishedEventDispatcher$ } from "../signals/services/chat-run-finished-event-registration.service";
import { executeMorningBriefEnrollmentForMember$ } from "../signals/services/morning-brief-enrollment-worker.service";
import { executeDueNotionAutomationEventsForAutomation$ } from "../signals/services/notion-automation-event.service";
import { configureOfficialWorkflowReconciliationDispatcher$ } from "../signals/services/official-workflow-reconciliation-registration.service";
import { executeDueStripeAutomationEventsForAutomation$ } from "../signals/services/stripe-automation-event.service";
import {
  executeDueWorkflowAutomationsForAutomation$,
  executeDueWorkflowAutomationsForWorkflow$,
} from "../signals/services/workflow-automation-poller.service";

const ownedIdSchema = z.string().uuid();
const memberScopeSchema = z
  .object({ orgId: z.string().min(1), userId: z.string().min(1) })
  .strict();

function createAutomationWorkerStore(signal: AbortSignal) {
  const store = createStore();
  store.set(setRootSignal$, signal);
  store.set(configureChatRunFinishedEventDispatcher$);
  store.set(configureOfficialWorkflowReconciliationDispatcher$);
  return store;
}

// These owned workers run in development tests without a Preview request.
// Run preparation and its background work retain the caller's existing lifetime.
export async function executeWorkflowAutomationForTest(
  {
    automationId,
    usagePricingResolution,
  }: {
    readonly automationId: string;
    readonly usagePricingResolution?: UsagePricingResolution;
  },
  signal: AbortSignal,
) {
  signal.throwIfAborted();
  const ownedAutomationId = ownedIdSchema.parse(automationId);
  const store = createAutomationWorkerStore(signal);
  if (usagePricingResolution) {
    store.set(setUsagePricingResolution$, usagePricingResolution);
  }
  const scheduled = await store.set(
    executeDueWorkflowAutomationsForAutomation$,
    ownedAutomationId,
    signal,
  );
  const notion = await store.set(
    executeDueNotionAutomationEventsForAutomation$,
    ownedAutomationId,
    signal,
  );
  const stripe = await store.set(
    executeDueStripeAutomationEventsForAutomation$,
    ownedAutomationId,
    signal,
  );
  signal.throwIfAborted();
  return {
    executed: scheduled.executed + notion.executed + stripe.executed,
    skipped:
      scheduled.skipped +
      notion.skipped +
      stripe.skipped +
      stripe.failed +
      stripe.retried,
  };
}

export async function executeDueWorkflowAutomationsForWorkflowForTest(
  workflowId: string,
  signal: AbortSignal,
) {
  signal.throwIfAborted();
  const ownedWorkflowId = ownedIdSchema.parse(workflowId);
  const store = createAutomationWorkerStore(signal);
  const result = await store.set(
    executeDueWorkflowAutomationsForWorkflow$,
    ownedWorkflowId,
    signal,
  );
  signal.throwIfAborted();
  return result;
}

export async function enrollMorningBriefForMemberForTest(
  scope: { readonly orgId: string; readonly userId: string },
  signal: AbortSignal,
): Promise<number> {
  signal.throwIfAborted();
  const ownedMember = memberScopeSchema.parse(scope);
  const store = createAutomationWorkerStore(signal);
  const attempted = await store.set(
    executeMorningBriefEnrollmentForMember$,
    ownedMember,
    signal,
  );
  signal.throwIfAborted();
  return attempted;
}
