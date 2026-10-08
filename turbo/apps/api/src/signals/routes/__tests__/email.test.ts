import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { mockClerkUsers } from "./helpers/clerk-users";

import { testContext } from "../../../__tests__/test-context";
import { mockEnv } from "../../../lib/env";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { createBddApi } from "./helpers/api-bdd";
import { createRunsApi } from "./helpers/api-bdd-runs";
import { createWebhookCallbackApi } from "./helpers/api-bdd-webhooks";

const context = testContext();
const resendMocks = context.mocks.resend;
const bdd = createBddApi(context);
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
