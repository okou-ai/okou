import {
  billingStatusContract,
  type BillingStatusResponse,
} from "@okouai/api-contracts/contracts/billing";
import { runsQueueContract } from "@okouai/api-contracts/contracts/run-routes";
import type { QueueResponse } from "@okouai/api-contracts/contracts/runs";

import type { TestContext } from "../../../signals/__tests__/test-helpers.ts";
import { billingPlanCapabilities } from "../../../mocks/handlers/api-billing.ts";

export const QUEUE_AGENT_ID = "c0000000-0000-4000-a000-000000000091";

export function queueResponse(
  concurrency: QueueResponse["concurrency"],
): QueueResponse {
  return {
    concurrency,
    queue: [],
    runningTasks: [],
    estimatedTimePerRun: 30_000,
  };
}

export function billingStatus(
  overrides: Partial<BillingStatusResponse>,
): BillingStatusResponse {
  return {
    showUsagePack: false,
    tier: "team",
    ...billingPlanCapabilities("team"),
    credits: 10_000,
    onboardingPaymentPending: false,
    subscriptionStatus: "active",
    currentPeriodEnd: "2026-10-01T00:00:00.000Z",
    cancelAtPeriodEnd: false,
    scheduledChange: null,
    hasSubscription: true,
    autoRecharge: { enabled: false, threshold: null, amount: null },
    creditExpiry: { expiringNextCycle: 0, nextExpiryDate: null },
    creditBreakdown: [],
    creditGrants: [],
    concurrencyLimit: 10,
    concurrencySubscriptions: [],
    ...overrides,
  };
}

interface QueuePageFixture {
  readonly setBillingStatus: (status: BillingStatusResponse) => void;
  readonly setQueueResponse: (response: QueueResponse) => void;
}

export function installQueuePageFixture(
  context: TestContext,
  options: {
    readonly billing: BillingStatusResponse;
    readonly queue: QueueResponse;
    readonly role?: "admin" | "member";
  },
): QueuePageFixture {
  let currentBillingStatus = options.billing;
  let currentQueueResponse = options.queue;

  context.mocks.data.agents([
    {
      agentId: QUEUE_AGENT_ID,
      displayName: "Capacity agent",
      visibility: "private",
    },
  ]);
  context.mocks.data.org({ role: options.role ?? "admin" });
  context.mocks.api(runsQueueContract.getQueue, ({ respond }) => {
    return respond(200, currentQueueResponse);
  });
  context.mocks.api(billingStatusContract.get, ({ respond }) => {
    return respond(200, currentBillingStatus);
  });

  return {
    setBillingStatus: (status) => {
      currentBillingStatus = status;
    },
    setQueueResponse: (response) => {
      currentQueueResponse = response;
    },
  };
}
