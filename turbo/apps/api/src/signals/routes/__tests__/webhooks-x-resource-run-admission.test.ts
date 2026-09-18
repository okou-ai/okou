import { randomUUID } from "node:crypto";

import { describe, expect, it, onTestFinished } from "vitest";

import { testContext } from "../../../__tests__/test-context";
import { now } from "../../../lib/time";
import { holdRunAllowanceAdmissionForTest } from "../../../test-fixtures/usage-run-admission-lock";
import { flushWaitUntilForTest } from "../../context/wait-until";
import {
  configureNativeCliArtifact,
  createChatEventsFixture,
  requireOrgId,
} from "./helpers/chat-events-fixture";
import {
  generatedStripeCustomerId,
  postUsageAllowanceInvoicePaid,
} from "./helpers/stripe-billing-webhook";

const context = testContext();
const fixture = createChatEventsFixture(context);

describe("X resource account cleanup and Run admission", () => {
  it("drains an admitted Run before retaining its organization's allowance locks", async () => {
    configureNativeCliArtifact();
    const { actor, agentId } = await fixture.entitledChatActor();
    const orgId = requireOrgId(actor);
    const model = "claude-sonnet-5";
    await fixture.configureBuiltInPiModel(actor, model);
    await postUsageAllowanceInvoicePaid(context.signal, {
      orgId,
      userId: actor.userId,
      customerId: generatedStripeCustomerId(),
      subscriptionId: `sub_x_run_admission_${randomUUID()}`,
      effectiveAt: new Date(now() - 60_000),
      expiresAt: new Date(now() + 86_400_000),
      shortWindowSeconds: 3600,
      shortWindowUnits: 10,
      weeklyWindowSeconds: 7 * 86_400,
      weeklyWindowUnits: 10,
    });
    // Positive credits bypass the earlier read-only allowance preflight. The
    // owned credit gate must stop the persistence transaction after admission.
    expect(
      (await fixture.api.readBillingStatus(actor)).credits,
    ).toBeGreaterThan(0);
    fixture.webhooks.configureClerkWebhookSecret();
    context.mocks.s3.send.mockResolvedValue({});
    context.mocks.clerk.organizations.getOrganizationMembershipList.mockResolvedValue(
      { data: [] },
    );
    context.mocks.stripe.subscriptions.list.mockResolvedValue({
      data: [],
      has_more: false,
    });
    context.mocks.stripe.subscriptions.retrieve.mockRejectedValue({
      code: "resource_missing",
    });

    // Infrastructure exception: an HTTP caller cannot pause inside its Run
    // transaction after acquiring Agent ownership but before allowance locks.
    const gate = await holdRunAllowanceAdmissionForTest(orgId, context.signal);
    const completion = Promise.allSettled([gate.done]);
    const creation = Promise.allSettled([
      fixture.sendChatRun(actor, {
        agentId,
        prompt: "Create a Run while the account is being removed",
        model,
      }),
    ]);
    onTestFinished(async () => {
      gate.release();
      await completion;
      await creation;
      await flushWaitUntilForTest();
    });
    await expect.poll(gate.admittedCreatorCount).toBe(1);

    fixture.webhooks.verifyNextClerkWebhook({
      type: "organization.deleted",
      data: { id: orgId },
    });
    await fixture.webhooks.requestClerkWebhook("{}", {}, [200]);
    await expect.poll(gate.cleanupWaiterCount).toBe(1);
    gate.release();
    const [released] = await completion;
    if (released.status === "rejected") {
      throw released.reason;
    }
    const [created] = await creation;
    if (created.status === "rejected") {
      throw created.reason;
    }
    await flushWaitUntilForTest();

    await fixture.api.requestReadRun(actor, created.value.runId, [404]);
    await fixture.bdd.requestReadAgent(actor, agentId, [404]);
  });
});
