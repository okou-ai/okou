import { randomUUID } from "node:crypto";

import { expect } from "vitest";

import type { TestContext } from "../../../../__tests__/test-context";
import { env, mockEnv, mockOptionalEnv } from "../../../../lib/env";
import { now } from "../../../../lib/time";
import { flushWaitUntilForTest } from "../../../context/wait-until";
import { createBddApi } from "./api-bdd";
import { createBillingMediaApi } from "./api-bdd-billing-media";
import { createChatCallbacksApi } from "./api-bdd-chat-callbacks";
import { createRunReadsApi } from "./api-bdd-run-reads";
import { createRunsApi } from "./api-bdd-runs";
import { createWebhookCallbackApi } from "./api-bdd-webhooks";
import { deleteFeatureSwitchesForUser } from "./feature-switches";
import { createFixtureOperationOwner } from "./fixture-operation-owner";

/** The two selected admission scenarios own all setup and their pending Runs. */
export function createPublicChatAdmissionFixture(context: TestContext) {
  const bdd = createBddApi(context);
  const actor = bdd.user();
  const orgId = actor.orgId;
  if (!orgId) {
    throw new Error("Expected an owned chat admission organization");
  }
  const suffix = randomUUID();
  const customerId = `cus_chat_admission_${suffix}`;
  const subscriptionId = `sub_chat_admission_${suffix}`;
  const storageBucket = env("R2_USER_STORAGES_BUCKET_NAME");
  const kmsKeyId = env("SECRETS_KMS_KEY_ID");
  const agentIds = new Set<string>();
  const runIds = new Set<string>();
  const runs = createRunsApi(context);
  const billing = createBillingMediaApi(context);
  const webhooks = createWebhookCallbackApi(context);
  let restoreStorage: (() => void) | undefined;

  function captureStorageMocks(): void {
    const send = context.mocks.s3.send.getMockImplementation();
    const presign = context.mocks.s3.getSignedUrl.getMockImplementation();
    restoreStorage = () => {
      if (send) {
        context.mocks.s3.send.mockImplementation(send);
      }
      if (presign) {
        context.mocks.s3.getSignedUrl.mockImplementation(presign);
      }
    };
  }
  const subscription = {
    id: subscriptionId,
    customer: customerId,
    status: "active",
    metadata: {},
    cancel_at_period_end: false,
    cancel_at: null,
    schedule: null,
    trial_end: null,
    items: { data: [{ price: { id: "price_bdd_pro" } }] },
  };

  const owner = createFixtureOperationOwner(async () => {
    mockEnv("R2_USER_STORAGES_BUCKET_NAME", storageBucket);
    mockEnv("SECRETS_KMS_KEY_ID", kmsKeyId);
    if (restoreStorage) {
      restoreStorage();
    } else {
      context.mocks.s3.send.mockResolvedValue({
        Contents: [],
        IsTruncated: false,
      });
    }
    runs.acceptStorageDownloads();
    runs.acceptTelemetryIngest();
    context.mocks.ably.publish.mockResolvedValue(undefined);
    await flushWaitUntilForTest();

    // Recover an admission that committed before its response was interrupted.
    const reads = createRunReadsApi(context);
    const listed = await reads.requestListLogs(actor, { limit: 50 }, [200]);
    for (const run of listed.body.data) {
      runIds.add(run.id);
    }
    for (const runId of runIds) {
      const run = await runs.readRun(actor, runId);
      if (run.status === "pending" || run.status === "running") {
        await runs.requestCancelRun(actor, runId, [200]);
      }
    }
    // Neither selected scenario claims a Runner, so no ACK is fabricated.
    await flushWaitUntilForTest();
    await deleteFeatureSwitchesForUser(context, {
      userId: actor.userId,
      orgId,
      orgRole: actor.orgRole,
    });

    webhooks.configureStripeBillingEnv();
    context.mocks.stripe.subscriptions.list.mockResolvedValue({
      data: [],
      has_more: false,
    });
    context.mocks.stripe.invoices.list.mockResolvedValue({
      data: [],
      has_more: false,
    });
    context.mocks.stripe.subscriptions.retrieve.mockResolvedValue({
      id: subscriptionId,
      status: "active",
      metadata: {},
      items: { data: [{ price: { id: "price_bdd_pro" } }] },
    });
    context.mocks.stripe.subscriptions.update.mockResolvedValue({
      id: subscriptionId,
    });
    context.mocks.stripe.subscriptions.cancel.mockResolvedValue({
      id: subscriptionId,
      status: "canceled",
    });
    webhooks.configureClerkWebhookSecret();
    webhooks.verifyNextClerkWebhook({
      type: "organization.deleted",
      data: { id: orgId },
    });
    await webhooks.requestClerkWebhook("{}", {}, [200]);
    await flushWaitUntilForTest();
    for (const agentId of agentIds) {
      await bdd.requestReadAgent(actor, agentId, [404]);
    }
    expect(
      (await reads.requestListLogs(actor, { limit: 50 }, [200])).body.data,
    ).toStrictEqual([]);
    // Production retains the UUID-owned immutable billing history.
  });

  return {
    actor,
    run: owner.run,
    captureStorageMocks,
    registerAgent(agentId: string): void {
      agentIds.add(agentId);
    },
    registerRun(runId: string): void {
      runIds.add(runId);
    },
    async activateWithoutCredits(): Promise<void> {
      expect((await billing.readBillingStatus(actor)).credits).toBe(0);
      webhooks.configureStripeBillingEnv();
      context.mocks.stripe.customers.retrieve.mockResolvedValue({
        id: customerId,
        metadata: { orgId },
      });
      for (const type of [
        "customer.subscription.created",
        "customer.subscription.updated",
      ] as const) {
        await webhooks.postStripeEvent(
          {
            id: `evt_chat_admission_${type}_${suffix}`,
            type,
            created: Math.floor(now() / 1000),
            data: { object: subscription },
          },
          [200],
        );
      }
      await expect(billing.readBillingStatus(actor)).resolves.toMatchObject({
        tier: "pro",
        status: "active",
        credits: 0,
      });
    },
    async createPaidNativeActor() {
      const callbacks = createChatCallbacksApi(context);
      callbacks.acceptChatObjectStorage();
      runs.acceptStorageDownloads();
      runs.acceptTelemetryIngest();
      mockOptionalEnv("OPENROUTER_API_KEY", undefined);
      callbacks.disableVapid();
      captureStorageMocks();
      runs.configureRunnerGroup();
      await runs.grantProEntitlement(actor, { customerId, subscriptionId });
      await runs.ensurePersonalSubscriptionModel(actor);
      const agent = await bdd.createAgent(actor, {
        displayName: "BDD chat messages agent",
        description: "Exercises the web chat send route.",
        visibility: "private",
      });
      agentIds.add(agent.agentId);
      await runs.updateUserModelPreference(actor, "claude-fable-5-1");
      return { actor, agentId: agent.agentId };
    },
    async suspend(credits: 0 | 20_000): Promise<void> {
      await webhooks.postStripeEvent(
        {
          id: `evt_chat_admission_canceled_${suffix}`,
          type: "customer.subscription.updated",
          data: { object: { ...subscription, status: "canceled" } },
        },
        [200],
      );
      await expect(billing.readBillingStatus(actor)).resolves.toMatchObject({
        tier: "pro",
        status: "suspended",
        credits,
        canBuyCredits: true,
      });
    },
  };
}
