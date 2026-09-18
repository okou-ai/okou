import { randomUUID } from "node:crypto";

import { CANCELLATION_RECOVERY_STALE_AFTER_MS } from "@okouai/api-contracts/contracts/runners";
import { testCronCleanupSandboxesStateContract } from "@okouai/api-contracts/contracts/test-cron-cleanup-sandboxes-state";
import { describe, expect, it, onTestFinished } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { clearMockNow, mockNow, now, nowDate } from "../../../lib/time";
import { createUsagePricingFixture } from "../../../test-fixtures/system-config-seeds";
import { holdRunConversationDeletionForTest } from "../../../test-fixtures/usage-run-deletion-lock";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { testCronCleanupSandboxesStateRoutes } from "../test-cron-cleanup-sandboxes-state";
import { createBillingMediaApi } from "./helpers/api-bdd-billing-media";
import {
  configureNativeCliArtifact,
  createChatEventsFixture,
  requireOrgId,
} from "./helpers/chat-events-fixture";

const context = testContext();
const fixture = createChatEventsFixture(context);
const billing = createBillingMediaApi(context);

describe("X resource account cleanup and ordinary Run deletion", () => {
  it("drains a threadless Run deletion before retaining its user's ledger", async () => {
    configureNativeCliArtifact();
    const {
      actor: owner,
      agentId,
      runnerGroup,
    } = await fixture.entitledChatActor();
    const orgId = requireOrgId(owner);
    await fixture.bdd.updateAgent(owner, agentId, { visibility: "public" });
    // The deleted user invokes another owner's Agent. Clerk retains that
    // Agent and its Sessions, isolating the direct Run/ledger lock order.
    const actor = fixture.bdd.user({ orgId });
    const deletedAgent = await fixture.bdd.createAgent(actor, {
      displayName: "Account cleanup commit evidence",
      visibility: "private",
    });
    // Pricing is operator-managed; use a private lookup identity for this test.
    const pricing = await createUsagePricingFixture({
      configured: [
        {
          kind: "connector",
          provider: "x",
          category: "posts.read",
          unitPrice: 1,
          unitSize: 1,
        },
      ],
    });
    onTestFinished(pricing.cleanup);
    const run = await fixture.sendChatRun(actor, {
      agentId,
      prompt: "Finish before account cleanup",
    });
    const { sandboxHeaders } = await fixture.claimChatRun(
      runnerGroup,
      run.runId,
    );
    const resourceId = BigInt(
      `0x${randomUUID().replaceAll("-", "").slice(0, 24)}`,
    ).toString();
    await fixture.webhooks.requestAgentUsageEvent(
      {
        runId: run.runId,
        events: [
          {
            protocol: "x-resource-v1",
            idempotencyKey: randomUUID(),
            kind: "connector",
            provider: "x",
            category: "posts.read",
            quantity: 1,
            observedAt: nowDate().toISOString(),
            resources: [{ id: resourceId, occurrences: 1 }],
            remainder: [],
          },
        ],
      },
      sandboxHeaders,
      [200],
    );
    await billing.processOrgUsageEvents(actor, pricing.resolution);
    expect((await billing.readUsageRecord(actor)).body.totalCredits).toBe(1);
    await fixture.completeChatRunOk(run.runId, sandboxHeaders, {
      usagePricingResolution: pricing.resolution,
    });
    await flushWaitUntilForTest();
    await fixture.chat.deleteThread(actor, run.threadId);
    await flushWaitUntilForTest();
    mockNow(now() + CANCELLATION_RECOVERY_STALE_AFTER_MS);
    onTestFinished(clearMockNow);

    fixture.webhooks.configureClerkWebhookSecret();
    context.mocks.s3.send.mockResolvedValue({});
    context.mocks.clerk.organizations.getOrganizationMembershipList.mockResolvedValue(
      { data: [{ publicUserData: { userId: owner.userId } }] },
    );
    context.mocks.stripe.subscriptions.list.mockResolvedValue({
      data: [],
      has_more: false,
    });
    context.mocks.stripe.subscriptions.retrieve.mockRejectedValue({
      code: "resource_missing",
    });

    // Infrastructure-only gate: the real sweep must own its Run before it
    // blocks deleting this API-created checkpoint conversation. Clerk must
    // drain that deletion before holding ledger rows needed by its FK cascade.
    const gate = await holdRunConversationDeletionForTest(
      run.runId,
      context.signal,
    );
    const completion = Promise.allSettled([gate.done]);
    const sweep = Promise.allSettled([
      accept(
        setupApp({ context, routes: testCronCleanupSandboxesStateRoutes })(
          testCronCleanupSandboxesStateContract,
        ).cleanup({
          body: {
            chatThreadIds: [],
            runIds: [run.runId],
            orgIds: [],
            exportJobIds: [],
          },
        }),
        [200],
      ),
    ]);
    onTestFinished(async () => {
      gate.release();
      await completion;
      await sweep;
      await flushWaitUntilForTest();
    });
    await expect.poll(gate.deletionWaiterCount).toBe(1);
    fixture.webhooks.verifyNextClerkWebhook({
      type: "user.deleted",
      data: { id: actor.userId },
    });
    await fixture.webhooks.requestClerkWebhook("{}", {}, [200]);
    await expect.poll(gate.cleanupWaiterCount, { interval: 5 }).toBe(1);
    gate.release();
    const [released] = await completion;
    if (released.status === "rejected") {
      throw released.reason;
    }
    const [swept] = await sweep;
    if (swept.status === "rejected") {
      throw swept.reason;
    }
    expect(swept.value.body.threadlessRuns).toMatchObject({
      discovered: 1,
      deleted: 1,
      failed: 0,
    });
    await flushWaitUntilForTest();
    await fixture.api.requestReadRun(actor, run.runId, [404]);
    await fixture.bdd.requestReadAgent(actor, deletedAgent.agentId, [404]);
    await fixture.bdd.requestReadAgent(owner, agentId, [200]);
    expect((await billing.readUsageRecord(actor)).body.totalCredits).toBe(0);
  });
});
