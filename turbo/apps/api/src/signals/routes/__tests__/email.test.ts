import { drainEmailOutboxItemsForTest } from "../../../test-fixtures/email-outbox-workers";
import { mockClerkUsers } from "./helpers/clerk-users";
import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it, onTestFinished } from "vitest";

import { testContext } from "../../../__tests__/test-context";
import {
  deleteUsagePricingRows,
  seedUsagePricingRows,
} from "../../../test-fixtures/system-config-seeds";
import { mockEnv, mockOptionalEnv } from "../../../lib/env";
import { nowDate } from "../../../lib/time";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { createBddApi } from "./helpers/api-bdd";
import { createChatEventsFixture } from "./helpers/chat-events-fixture";
import { createBillingMediaApi } from "./helpers/api-bdd-billing-media";
import { createEmailApi } from "./helpers/api-bdd-email";
import { createEmailOutboxStateApi } from "./helpers/email-outbox-state";
import { createRunsApi } from "./helpers/api-bdd-runs";
import { createWebhookCallbackApi } from "./helpers/api-bdd-webhooks";

const context = testContext();
const resendMocks = context.mocks.resend;
const bdd = createBddApi(context);
const email = createEmailApi(context);
const runs = createRunsApi(context);
const webhooks = createWebhookCallbackApi(context);

const INBOUND_SECRET = "whsec_test";

interface EmailOrgFixture {
  readonly userEmail: string;
  readonly orgSlug: string;
  readonly runnerGroup: string;
}

interface WebhookEvent {
  readonly type: string;
  readonly data?: {
    readonly email_id?: string;
    readonly to?: readonly string[];
    readonly from?: string;
    readonly subject?: string;
  };
}

function clerkUserListEntry(userId: string, email: string) {
  const emailId = `email_${userId}`;
  return {
    id: userId,
    emailAddresses: [{ id: emailId, emailAddress: email }],
    primaryEmailAddressId: emailId,
    firstName: "BDD",
    lastName: "User",
    imageUrl: null,
  };
}

async function emailOrg(): Promise<EmailOrgFixture> {
  const actor = bdd.user();
  if (!actor.orgId) {
    throw new Error("Expected an org-scoped actor");
  }
  const orgId = actor.orgId;
  const orgSlug = `email-${randomUUID().slice(0, 8)}`;
  const runnerGroup = runs.configureRunnerGroup();
  bdd.acceptAgentStorageWrites();
  runs.acceptStorageDownloads();
  runs.acceptTelemetryIngest();

  await runs.grantProEntitlement(actor);
  await runs.ensurePersonalSubscriptionModel(actor);
  await runs.heartbeatRunner(runnerGroup);

  mockClerkUsers(context, [clerkUserListEntry(actor.userId, actor.email)]);
  context.mocks.clerk.organizations.getOrganization.mockResolvedValue({
    id: orgId,
    slug: orgSlug,
    name: "BDD Email Org",
    createdBy: actor.userId,
  });
  context.mocks.clerk.users.getOrganizationMembershipList.mockResolvedValue({
    data: [{ organization: { id: orgId }, role: "org:member" }],
  });

  return {
    userEmail: actor.email,
    orgSlug,
    runnerGroup,
  };
}

async function postInbound(event: WebhookEvent) {
  return await webhooks.requestResendInboundWebhook(
    event,
    webhooks.signedResendWebhookHeaders(event),
    [200],
  );
}

beforeEach(() => {
  resendMocks.send.mockReset();
  resendMocks.send.mockResolvedValue({ data: { id: "resend-test-id" } });
  mockEnv("RESEND_API_KEY", "test-resend-key");
  mockEnv("RESEND_WEBHOOK_SECRET", INBOUND_SECRET);
  mockEnv("RESEND_FROM_DOMAIN", "okou.io");
  mockEnv("APP_URL", "https://app.okou.ai");
  mockEnv("OKOU_API_BACKEND_URL", "https://api.okou.ai");
  // Resend pacing is not part of these transactional delivery assertions.
  mockOptionalEnv("EMAIL_OUTBOX_DRAIN_DELAY_MS", "0");
});

describe("retired Native Morning Brief email", () => {
  it("rejects a historical Native intent and clears its body without contacting the provider", async () => {
    const outbox = createEmailOutboxStateApi(context, { isolatePg: true });
    const item = await outbox.seedItem({
      template: "morning-brief-result",
      toAddress: `recipient-${randomUUID()}@example.test`,
      subject: "Historical Morning Brief",
      status: "pending",
      createdAt: nowDate(),
    });
    onTestFinished(async () => {
      await outbox.deleteItems([item.id]);
    });

    await expect(
      drainEmailOutboxItemsForTest([item.id], context.signal),
    ).resolves.toBe(1);
    await expect(outbox.readItem(item.id)).resolves.toMatchObject({
      status: "failed",
      last_error: "Native Morning Brief email retired",
      has_provider_request: false,
      template: {
        template: "morning-brief-result",
        props: { title: "", resultMarkdown: "", threadUrl: "", manageUrl: "" },
      },
    });
    expect(resendMocks.send).not.toHaveBeenCalled();
  });
  it("stops a committed historical Native provider request without replaying or replacing its key", async () => {
    const outbox = createEmailOutboxStateApi(context, { isolatePg: true });
    const to = `recipient-${randomUUID()}@example.test`;
    const key = `historical-native-${randomUUID()}`;
    const item = await outbox.seedItem({
      template: "morning-brief-result",
      toAddress: to,
      subject: "Historical Morning Brief",
      status: "sending",
      createdAt: nowDate(),
      providerIdempotencyKey: key,
      providerRequest: {
        from: "Okou <outbox-fixture@mail.example.com>",
        to,
        subject: "Historical Morning Brief",
        html: "<p>Historical content</p>",
        text: "Historical content",
      },
    });
    onTestFinished(async () => {
      await outbox.deleteItems([item.id]);
    });
    await expect(
      drainEmailOutboxItemsForTest([item.id], context.signal),
    ).resolves.toBe(1);
    await expect(outbox.readItem(item.id)).resolves.toMatchObject({
      status: "failed",
      attempts: 0,
      provider_idempotency_key: key,
      has_provider_request: false,
      last_error:
        "Native Morning Brief email retired with unresolved provider outcome",
      template: {
        template: "morning-brief-result",
        props: { title: "", resultMarkdown: "", threadUrl: "", manageUrl: "" },
      },
    });
    await expect(
      drainEmailOutboxItemsForTest([item.id], context.signal),
    ).resolves.toBe(0);
    expect(resendMocks.send).not.toHaveBeenCalled();
  });
  it("purges globally retired Native intents during Agent deletion and preserves ordinary queued mail", async () => {
    const actor = bdd.user();
    bdd.acceptAgentStorageWrites();
    const outbox = createEmailOutboxStateApi(context, { isolatePg: true });
    const native = await outbox.seedItem({
      template: "morning-brief-result",
      toAddress: `native-${randomUUID()}@example.test`,
      subject: "Historical Morning Brief",
      status: "pending",
      createdAt: nowDate(),
    });
    const ordinary = await outbox.seedItem({
      toAddress: `ordinary-${randomUUID()}@example.test`,
      subject: "Unrelated transactional mail",
      status: "pending",
      createdAt: nowDate(),
    });
    onTestFinished(async () => {
      await outbox.deleteItems([native.id, ordinary.id]);
    });
    const agent = await bdd.createAgent(actor, {
      displayName: "Native mail retirement",
    });
    await bdd.deleteAgent(actor, agent.agentId);
    await expect(outbox.readItem(native.id)).resolves.toBeNull();
    await expect(outbox.readItem(ordinary.id)).resolves.toMatchObject({
      status: "pending",
    });
    expect(resendMocks.send).not.toHaveBeenCalled();
  });
});

describe("low-credit email delivery", () => {
  it("sends branded low-credit alerts with billing and unsubscribe links", async () => {
    const actor = bdd.user();
    const billing = createBillingMediaApi(context);
    bdd.acceptAgentStorageWrites();
    runs.acceptStorageDownloads();
    runs.acceptTelemetryIngest();
    await runs.grantProEntitlement(actor);

    const before = await billing.readBillingStatus(actor);
    expect(before.credits).toBeGreaterThan(5000);
    const modelProvider = `bdd-low-credit-${randomUUID()}`;
    onTestFinished(async () => {
      await deleteUsagePricingRows({
        kind: "model",
        provider: modelProvider,
        categories: ["tokens.output"],
      });
    });
    await seedUsagePricingRows([
      {
        kind: "model",
        provider: modelProvider,
        category: "tokens.output",
        unitPrice: before.credits - 4999,
        unitSize: 1,
      },
    ]);

    runs.configureRunnerGroup();
    // Built-in usage is billed to the organization's credits.
    await createChatEventsFixture(context).configureBuiltInPiModel(
      actor,
      "okou-1.0",
    );
    const agent = await bdd.createAgent(actor, {
      displayName: "BDD low-credit agent",
      description: "Crosses the low-credit alert threshold.",
      visibility: "private",
    });
    const run = await runs.createThreadRun(actor, {
      agentId: agent.agentId,
      prompt: "cross the low-credit alert threshold",
    });
    onTestFinished(async () => {
      const cleanupBdd = createBddApi(context);
      const cleanupRuns = createRunsApi(context);
      cleanupBdd.acceptAgentStorageWrites();
      cleanupRuns.acceptTelemetryIngest();
      await cleanupRuns.requestCancelRun(actor, run.runId, [200]);
      await flushWaitUntilForTest();
      await cleanupBdd.deleteAgent(actor, agent.agentId);
    });
    await webhooks.requestAgentUsageEvent(
      {
        runId: run.runId,
        events: [
          {
            idempotencyKey: randomUUID(),
            kind: "model",
            provider: modelProvider,
            category: "tokens.output",
            quantity: 1,
          },
        ],
      },
      {
        authorization: `Bearer ${runs.sandboxTokenForRun(actor, run.runId)}`,
      },
      [200],
    );

    // Refresh the current Clerk membership mocks before settlement resolves
    // the organization's admin recipients.
    await billing.readBillingStatus(actor);
    await billing.processOrgUsageEvents(actor);
    expect((await billing.readBillingStatus(actor)).credits).toBe(4999);
    const items = await email.findEmailOutboxItems({
      to: actor.email,
      subject: "Your credit balance is running low",
    });
    const [item] = items;
    if (!item) {
      throw new Error("Expected the owned low-credit delivery");
    }
    const ids = items.map((item) => {
      return item.id;
    });
    const drained = await email.drainEmailOutboxItems(ids);

    expect(drained).toBe(1);
    expect(resendMocks.send).toHaveBeenCalledTimes(1);
    expect(context.mocks.resend.send).toHaveBeenCalledWith(
      expect.objectContaining({
        from: "Okou Team <support@okou.io>",
        to: actor.email,
        subject: "Your credit balance is running low",
        html: expect.stringContaining("https://app.okou.ai/"),
        headers: {
          "List-Unsubscribe": expect.stringContaining(
            "<https://api.okou.ai/api/email/unsubscribe?token=",
          ),
          "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
        },
      }),
      { idempotencyKey: `okou-email-outbox/v1/${item.id}` },
    );
    const sent = resendMocks.send.mock.calls[0]?.[0];
    for (const content of [
      "Your credit balance is running low",
      "4,999 credits",
      "5,000 credits or less",
      "Manage billing",
      "The Okou Team",
      "https://app.okou.ai/email/unsubscribe?token=",
    ]) {
      expect(sent).toMatchObject({
        html: expect.stringContaining(content),
        text: expect.stringContaining(content),
      });
    }
    expect(sent).toMatchObject({
      html: expect.stringContaining('alt="Okou"'),
      text: expect.stringContaining(
        "https://app.okou.ai/?settings=billing&billingView=credits",
      ),
    });
    await expect(email.drainEmailOutboxItems(ids)).resolves.toBe(0);
    expect(resendMocks.send).toHaveBeenCalledTimes(1);
  });
});

describe("POST /api/email/inbound", () => {
  it("rejects missing or invalid Svix signatures", async () => {
    const missingHeaders = await webhooks.requestResendInboundWebhook(
      { type: "email.received" },
      {},
      [401],
    );
    expect(missingHeaders.body).toStrictEqual({
      error: "Missing signature headers",
    });

    const event = { type: "email.received" };
    const invalidSignature = await webhooks.requestResendInboundWebhook(
      event,
      {
        ...webhooks.signedResendWebhookHeaders(event),
        "svix-signature": "v1,bad-signature",
      },
      [401],
    );
    expect(invalidSignature.body).toStrictEqual({
      error: "Invalid signature",
    });
  });

  it("sends branded transactional data-export email to eligible recipients", async () => {
    const controlActor = bdd.user();

    const locator = await email.enqueueDataExportEmail(controlActor);
    const item = await email.findEmailOutboxItem(locator);
    const drained = await email.drainEmailOutboxItems([item.id]);

    expect(drained).toBe(1);
    expect(resendMocks.send).toHaveBeenCalledTimes(1);
    expect(resendMocks.send).toHaveBeenCalledWith(
      expect.objectContaining({ to: controlActor.email }),
      { idempotencyKey: `okou-email-outbox/v1/${item.id}` },
    );
    const sent = resendMocks.send.mock.calls[0]?.[0];
    if (!sent) {
      throw new Error("Expected a data-export email");
    }
    expect(sent).toMatchObject({
      from: "Okou <okou@okou.io>",
      subject: "Your data export is ready",
      html: expect.stringContaining("Download data"),
      text: expect.stringContaining(
        "Your requested data export has been completed and is ready to download.",
      ),
    });
    expect(sent).not.toHaveProperty("headers.List-Unsubscribe");
  });

  it("keeps bounced recipients out of transactional sends", async () => {
    const bouncedActor = bdd.user();

    await postInbound({
      type: "email.bounced",
      data: {
        email_id: `email_${randomUUID()}`,
        to: [bouncedActor.email],
      },
    });

    const locator = await email.enqueueDataExportEmail(bouncedActor);
    const item = await email.findEmailOutboxItem(locator);
    const drained = await email.drainEmailOutboxItems([item.id]);

    expect(drained).toBe(1);
    expect(resendMocks.send).toHaveBeenCalledTimes(0);
  });

  it("keeps complained recipients out of transactional sends", async () => {
    const complainedActor = bdd.user();
    mockClerkUsers(context, [
      clerkUserListEntry(complainedActor.userId, complainedActor.email),
    ]);

    await postInbound({
      type: "email.complained",
      data: {
        email_id: `email_${randomUUID()}`,
        to: [complainedActor.email],
      },
    });

    const locator = await email.enqueueDataExportEmail(complainedActor);
    const item = await email.findEmailOutboxItem(locator);
    const drained = await email.drainEmailOutboxItems([item.id]);

    expect(drained).toBe(1);
    expect(resendMocks.send).toHaveBeenCalledTimes(0);
  });

  it("acknowledges new and reply-address email without creating Agent runs", async () => {
    const fx = await emailOrg();
    for (const to of [
      `${fx.orgSlug}@mail.example.com`,
      `reply+retired-${randomUUID()}@mail.example.com`,
    ]) {
      const response = await postInbound({
        type: "email.received",
        data: {
          email_id: `email_${randomUUID()}`,
          from: fx.userEmail,
          to: [to],
          subject: "Retired channel",
        },
      });
      expect(response.body).toStrictEqual({ received: true });
    }

    await flushWaitUntilForTest();
    const poll = await runs.pollRunner(fx.runnerGroup);
    expect(poll.body.job).toBeNull();
    expect(resendMocks.send).not.toHaveBeenCalled();
  });

  it("acknowledges unrelated signed Resend events without background work", async () => {
    const response = await postInbound({
      type: "email.sent",
      data: { email_id: "email_sent" },
    });

    expect(response.body).toStrictEqual({ received: true });
    await flushWaitUntilForTest();
    expect(resendMocks.send).not.toHaveBeenCalled();
  });
});
