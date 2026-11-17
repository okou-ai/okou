import { billingUsagePackCreditsContract } from "@okouai/api-contracts/contracts/billing";
import { getStartedContract } from "@okouai/api-contracts/contracts/get-started";
import { orgInviteContract } from "@okouai/api-contracts/contracts/org-member-routes";
import { webhookClerkContract } from "@okouai/api-contracts/contracts/webhooks";
import { cronProcessBackgroundJobsContract } from "@okouai/api-contracts/contracts/cron";
import { createHash, randomUUID } from "node:crypto";
import { http, HttpResponse } from "msw";
import { Webhook } from "svix";
import { beforeEach, expect, test, vi } from "vitest";
import { object, string, uuid } from "zod";
import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { mockEnv, mockOptionalEnv } from "../../../lib/env";
import { mockNow, nowDate } from "../../../lib/time";
import {
  marketingRewardSourceEventSchema,
  type MarketingRewardSourceEvent,
} from "../../../lib/marketing-reward-events";
import { server } from "../../../mocks/server";
import { cronProcessBackgroundJobsRoutes } from "../cron-process-background-jobs";
import { billingUsagePackCreditsRoutes } from "../billing-usage-pack-credits";
import { getStartedRoutes } from "../get-started";
import { orgInviteRoutes } from "../org-invite";
import { webhooksClerkRoutes } from "../webhooks-clerk";
import { createBddApi } from "./helpers/api-bdd";
import { createRouteMocks } from "./helpers/route-test";

const context = testContext();
const mocks = createRouteMocks(context);

class ClerkInvitationTestError extends Error {
  static readonly kind = "ClerkAPIResponseError";
  readonly errors: readonly {
    readonly code: string;
    readonly message: string;
    readonly longMessage: string;
  }[];

  constructor(
    code: string,
    readonly status: number,
    longMessage = code,
  ) {
    super(`Clerk invitation failed: ${code}`);
    this.errors = [{ code, message: code, longMessage }];
  }
}

const headers = Object.freeze({ authorization: "Bearer clerk-session" });
const secret = `whsec_${Buffer.from("get-started-synthetic-secret").toString("base64")}`;
const sentInvitation = object({
  organizationId: string(),
  privateMetadata: object({ getStartedClaimId: uuid() }),
});

const eventPath =
  "https://marketing-invitations.example.test/api/internal/marketing/get-started/events";

function eventDelivery() {
  mockEnv("CRON_SECRET", "invitation-source-cron-secret");
  mockEnv(
    "MARKETING_REWARDS_EVENTS_ORIGIN",
    "https://marketing-invitations.example.test",
  );
  mockEnv(
    "MARKETING_REWARDS_EVENTS_SECRET",
    "invitation-source-service-key-123456789",
  );
  const received: MarketingRewardSourceEvent[] = [];
  server.use(
    http.post(eventPath, async ({ request }) => {
      expect(request.headers.get("authorization")).toBe(
        "Bearer invitation-source-service-key-123456789",
      );
      const event = marketingRewardSourceEventSchema.parse(
        await request.json(),
      );
      received.push(event);
      return HttpResponse.json({
        version: 1,
        environment: event.environment,
        eventId: event.id,
        hash: createHash("sha256").update(JSON.stringify(event)).digest("hex"),
        receivedAt: "2026-11-17T00:00:00.000Z",
      });
    }),
  );
  return received;
}

async function deliverEvents() {
  return (
    await accept(
      setupApp({ context, routes: cronProcessBackgroundJobsRoutes })(
        cronProcessBackgroundJobsContract,
      ).process({
        headers: { authorization: "Bearer invitation-source-cron-secret" },
      }),
      [200],
    )
  ).body;
}

beforeEach(async () => {
  mockOptionalEnv("CLERK_WEBHOOK_SIGNING_SECRET", secret);
  const sdk = await vi.importActual<typeof import("@clerk/backend/webhooks")>(
    "@clerk/backend/webhooks",
  );
  context.mocks.clerk.verifyWebhook.mockImplementation((request: unknown) => {
    if (!(request instanceof Request)) {
      throw new Error("Expected a webhook request");
    }
    return sdk.verifyWebhook(request, { signingSecret: secret });
  });
});

async function org(userId = `user_${randomUUID()}`) {
  const orgId = `org_${randomUUID()}`;
  const api = createBddApi(context);
  await api.completeOnboarding(api.user({ userId, orgId }));
  mocks.clerk.session(userId, orgId);
  return { userId, orgId };
}

async function sendInvitation() {
  const id = `inv_${randomUUID()}`;
  let claimId: string | undefined;
  context.mocks.clerk.organizations.createOrganizationInvitation.mockImplementationOnce(
    (input: unknown) => {
      claimId = sentInvitation.parse(input).privateMetadata.getStartedClaimId;
      return Promise.resolve({ id });
    },
  );
  await accept(
    setupApp({ context, routes: orgInviteRoutes })(orgInviteContract).invite({
      headers,
      body: { email: `${randomUUID()}@example.com`, role: "member" },
    }),
    [200],
  );
  if (!claimId) {
    throw new Error("Invitation did not carry server attribution");
  }
  return { id, claimId };
}

function accepted(
  orgId: string,
  invitation: { id: string; claimId: string },
  userId: string,
  statuses: readonly (200 | 503)[] = [200],
) {
  const body = JSON.stringify({
    type: "organizationInvitation.accepted",
    data: {
      id: invitation.id,
      organization_id: orgId,
      user_id: userId,
      email_address: `${userId}@example.com`,
      updated_at: nowDate().getTime(),
      private_metadata: { getStartedClaimId: invitation.claimId },
    },
  });
  const id = randomUUID();
  const at = nowDate();
  return accept(
    setupApp({ context, routes: webhooksClerkRoutes })(
      webhookClerkContract,
    ).post({
      body,
      extraHeaders: {
        "svix-id": id,
        "svix-timestamp": String(Math.floor(at.getTime() / 1000)),
        "svix-signature": new Webhook(secret).sign(id, at, body),
      },
    }),
    statuses,
  );
}

type Delivery = Parameters<typeof accepted>;

/**
 * Concurrent deliveries may lose an invitation slot race; that delivery gets
 * 503 and Clerk redelivers it. Redeliveries run after the concurrent batch.
 */
async function acceptedConcurrently(deliveries: readonly Delivery[]) {
  const responses = await Promise.all(
    deliveries.map(([orgId, invitation, userId]) => {
      return accepted(orgId, invitation, userId, [200, 503]);
    }),
  );
  for (const [index, response] of responses.entries()) {
    const delivery = deliveries[index];
    if (response.status === 503 && delivery) {
      await accepted(delivery[0], delivery[1], delivery[2]);
    }
  }
}

async function progress() {
  const status = await accept(
    setupApp({ context, routes: getStartedRoutes })(getStartedContract).status({
      headers,
    }),
    [200],
  );
  return status.body.quests.find((q) => {
    return q.key === "invite";
  });
}

async function credits() {
  return (
    await accept(
      setupApp({ context, routes: billingUsagePackCreditsRoutes })(
        billingUsagePackCreditsContract,
      ).get({ headers }),
      [200],
    )
  ).body;
}

test.each([
  [
    "already_a_member_in_organization",
    400,
    "INVITEE_ALREADY_MEMBER",
    "This person is already a member.",
  ],
  [
    "duplicate_record",
    422,
    "INVITATION_ALREADY_EXISTS",
    "This person already has a pending invitation.",
  ],
  [
    "organization_invitation_not_unique",
    409,
    "INVITATION_ALREADY_EXISTS",
    "This person already has a pending invitation.",
  ],
] as const)(
  "maps Clerk invitation conflict %s to a stable 409",
  async (code, status, errorCode, message) => {
    await org();
    context.mocks.clerk.organizations.createOrganizationInvitation.mockRejectedValueOnce(
      new ClerkInvitationTestError(code, status),
    );

    const response = await accept(
      setupApp({ context, routes: orgInviteRoutes })(orgInviteContract).invite({
        headers,
        body: { email: `${randomUUID()}@example.com`, role: "member" },
      }),
      [409],
    );

    expect(response.body).toStrictEqual({
      error: { code: errorCode, message },
    });
    await expect(progress()).resolves.toMatchObject({
      claimedCount: 0,
      pendingCount: 0,
    });
  },
);

test("returns an address-level error when Clerk rejects the email format without recording invitation progress", async () => {
  await org();
  context.mocks.clerk.organizations.createOrganizationInvitation.mockRejectedValueOnce(
    new ClerkInvitationTestError(
      "form_param_format_invalid",
      422,
      "Email address must be a valid email address.",
    ),
  );

  const response = await accept(
    setupApp({ context, routes: orgInviteRoutes })(orgInviteContract).invite({
      headers,
      body: { email: `${randomUUID()}@example.com`, role: "member" },
    }),
    [400],
  );

  expect(response.body).toStrictEqual({
    error: { code: "BAD_REQUEST", message: "Enter a valid email address." },
  });
  await expect(progress()).resolves.toMatchObject({
    claimedCount: 0,
    pendingCount: 0,
  });
});

test.each([
  ["invalid_clerk_configuration", 400, "invalid_clerk_configuration"],
  ["form_param_format_invalid", 422, "Redirect URL must be a valid URL."],
] as const)(
  "keeps unrelated Clerk invitation failure %s as a server error",
  async (code, status, longMessage) => {
    await org();
    context.mocks.clerk.organizations.createOrganizationInvitation.mockRejectedValueOnce(
      new ClerkInvitationTestError(code, status, longMessage),
    );

    const response = await accept(
      setupApp({ context, routes: orgInviteRoutes })(orgInviteContract).invite({
        headers,
        body: { email: `${randomUUID()}@example.com`, role: "member" },
      }),
      [500],
    );

    expect(response.body).toStrictEqual({ error: "Internal server error" });
    await expect(progress()).resolves.toMatchObject({
      claimedCount: 0,
      pendingCount: 0,
    });
  },
);

test("revoking an invitation removes pending progress without consuming a reward slot", async () => {
  await org();
  const invitation = await sendInvitation();
  await expect(progress()).resolves.toMatchObject({
    claimedCount: 0,
    pendingCount: 1,
  });
  context.mocks.clerk.organizations.revokeOrganizationInvitation.mockResolvedValueOnce(
    {},
  );
  await accept(
    setupApp({ context, routes: orgInviteRoutes })(orgInviteContract).revoke({
      headers,
      body: { invitationId: invitation.id },
    }),
    [200],
  );
  await expect(progress()).resolves.toMatchObject({
    claimedCount: 0,
    pendingCount: 0,
  });
});

test("acceptance racing the Clerk send response retains attribution and webhook replay gives one reward", async () => {
  await setupApp({
    context,
    routes: cronProcessBackgroundJobsRoutes,
    isolatePg: true,
  });
  const received = eventDelivery();
  const actor = await org();
  const invitedUser = `user_existing_${randomUUID()}`;
  const invitationId = `inv_${randomUUID()}`;
  let claimId: string | undefined;
  context.mocks.clerk.organizations.createOrganizationInvitation.mockImplementationOnce(
    async (input: unknown) => {
      claimId = sentInvitation.parse(input).privateMetadata.getStartedClaimId;
      await accepted(actor.orgId, { id: invitationId, claimId }, invitedUser);
      return { id: invitationId };
    },
  );
  await accept(
    setupApp({ context, routes: orgInviteRoutes })(orgInviteContract).invite({
      headers,
      body: { email: "existing@example.com", role: "member" },
    }),
    [200],
  );
  if (!claimId) {
    throw new Error("Missing claim ID");
  }
  await accepted(actor.orgId, { id: invitationId, claimId }, invitedUser);
  await expect(progress()).resolves.toMatchObject({
    claimedCount: 1,
    earnedCredits: 100,
    pendingCount: 0,
    limit: 15,
  });
  expect((await deliverEvents()).processed).toBe(2);
  expect(received).toStrictEqual([
    {
      version: 3,
      id: expect.any(String),
      environment: "development",
      type: "invitation.accepted",
      occurredAt: expect.any(String),
      orgId: actor.orgId,
      userId: actor.userId,
      claimId,
      sourceKey: expect.any(String),
      invitationId,
      inviteeUserId: invitedUser,
    },
    {
      version: 3,
      id: expect.any(String),
      environment: "development",
      type: "invitation.attributed",
      occurredAt: expect.any(String),
      orgId: actor.orgId,
      userId: actor.userId,
      claimId,
      sourceKey: expect.any(String),
      invitationId,
    },
  ]);
  expect((await deliverEvents()).processed).toBe(0);
});

test("concurrent acceptances fill all 15 global invitation slots while pending invitations consume none", async () => {
  await setupApp({
    context,
    routes: cronProcessBackgroundJobsRoutes,
    isolatePg: true,
  });
  const received = eventDelivery();
  const first = await org();
  const sameInvitee = `user_${randomUUID()}`;
  const initialInvitations = [];
  for (let i = 0; i < 14; i++) {
    initialInvitations.push(await sendInvitation());
  }
  await acceptedConcurrently(
    initialInvitations.map((invitation, index): Delivery => {
      return [
        first.orgId,
        invitation,
        index === 0 ? sameInvitee : `user_${randomUUID()}`,
      ];
    }),
  );
  const pendingA = await sendInvitation();
  const second = await org(first.userId);
  const pendingB = await sendInvitation();
  const pendingC = await sendInvitation();
  await expect(progress()).resolves.toMatchObject({
    claimedCount: 14,
    pendingCount: 3,
  });
  await acceptedConcurrently([
    [first.orgId, pendingA, `user_${randomUUID()}`],
    [second.orgId, pendingB, `user_${randomUUID()}`],
  ]);
  await expect(progress()).resolves.toMatchObject({
    claimedCount: 15,
    earnedCredits: 1500,
    canEarnMore: false,
    pendingCount: 1,
  });
  const balances = [];
  for (const actor of [first, second]) {
    mocks.clerk.session(actor.userId, actor.orgId);
    balances.push(await credits());
  }
  expect(
    balances.reduce((total, balance) => {
      return total + balance.bonusCredits;
    }, 0),
  ).toBe(1500);
  expect(
    balances.flatMap((balance) => {
      return balance.creditGrants;
    }),
  ).toHaveLength(15);
  await accepted(second.orgId, pendingC, sameInvitee);
  // The cap never prevents another normal invitation.
  await sendInvitation();
  await expect(progress()).resolves.toMatchObject({
    claimedCount: 15,
    pendingCount: 1,
  });
  const anotherInviter = await org();
  const repeated = await sendInvitation();
  await accepted(anotherInviter.orgId, repeated, sameInvitee);
  await expect(progress()).resolves.toMatchObject({
    claimedCount: 0,
    pendingCount: 0,
  });
  for (let batch = 0; batch < 4; batch += 1) {
    await deliverEvents();
  }
  const acceptances = received.filter((event) => {
    return event.type === "invitation.accepted";
  });
  expect(acceptances).toHaveLength(18);
  expect(
    new Set(
      acceptances.map((event) => {
        return event.claimId;
      }),
    ).size,
  ).toBe(18);
  expect(acceptances).toContainEqual(
    expect.objectContaining({
      claimId: pendingC.claimId,
      orgId: second.orgId,
      userId: first.userId,
      inviteeUserId: sameInvitee,
    }),
  );
  expect(acceptances).toContainEqual(
    expect.objectContaining({
      claimId: repeated.claimId,
      orgId: anotherInviter.orgId,
      userId: anotherInviter.userId,
      inviteeUserId: sameInvitee,
    }),
  );
  expect((await deliverEvents()).processed).toBe(0);
});

test("concurrent invitations of the same account across organizations award only one inviter", async () => {
  const first = await org();
  const firstInvitation = await sendInvitation();
  const second = await org();
  const secondInvitation = await sendInvitation();
  const invitee = `user_${randomUUID()}`;

  await acceptedConcurrently([
    [first.orgId, firstInvitation, invitee],
    [second.orgId, secondInvitation, invitee],
    [first.orgId, firstInvitation, invitee],
    [second.orgId, secondInvitation, invitee],
  ]);

  const claimedCounts = [];
  for (const actor of [first, second]) {
    mocks.clerk.session(actor.userId, actor.orgId);
    const quest = await progress();
    if (!quest) {
      throw new Error("Invitation quest is missing");
    }
    expect(quest.pendingCount).toBe(0);
    claimedCounts.push(quest.claimedCount);
    const balance = await credits();
    expect(balance.bonusCredits).toBe(quest.claimedCount * 100);
    expect(balance.creditGrants).toHaveLength(quest.claimedCount);
  }
  expect(claimedCounts.sort()).toStrictEqual([0, 1]);
});

test("self-invitations and unrelated accepted invitations do not award credits", async () => {
  await setupApp({
    context,
    routes: cronProcessBackgroundJobsRoutes,
    isolatePg: true,
  });
  const received = eventDelivery();
  const actor = await org();
  const invitation = await sendInvitation();
  await accepted(actor.orgId, invitation, actor.userId);
  await accepted(
    actor.orgId,
    { id: `inv_${randomUUID()}`, claimId: randomUUID() },
    `user_${randomUUID()}`,
  );
  await expect(progress()).resolves.toMatchObject({
    claimedCount: 0,
    pendingCount: 0,
  });
  expect((await deliverEvents()).processed).toBe(2);
  expect(received).toContainEqual(
    expect.objectContaining({
      type: "invitation.accepted",
      claimId: invitation.claimId,
      userId: actor.userId,
      inviteeUserId: actor.userId,
    }),
  );
});

test("retains attributed and revoked facts through a lost storage acknowledgement", async () => {
  await setupApp({
    context,
    routes: cronProcessBackgroundJobsRoutes,
    isolatePg: true,
  });
  const received = eventDelivery();
  mockNow(new Date("2026-01-01T08:00:00.000Z"));
  const actor = await org();
  const invitation = await sendInvitation();
  context.mocks.clerk.organizations.revokeOrganizationInvitation.mockResolvedValueOnce(
    {},
  );
  await accept(
    setupApp({ context, routes: orgInviteRoutes })(orgInviteContract).revoke({
      headers,
      body: { invitationId: invitation.id },
    }),
    [200],
  );
  await expect(progress()).resolves.toMatchObject({
    claimedCount: 0,
    pendingCount: 0,
  });
  server.use(
    http.post(
      eventPath,
      async ({ request }) => {
        const event = marketingRewardSourceEventSchema.parse(
          await request.json(),
        );
        received.push(event);
        return HttpResponse.error();
      },
      { once: true },
    ),
  );
  expect((await deliverEvents()).processed).toBe(1);
  expect((await deliverEvents()).processed).toBe(2);
  expect(received).toHaveLength(3);
  expect(received[1]).toStrictEqual(received[0]);
  expect(
    received
      .slice(1)
      .map((event) => {
        return event.type;
      })
      .sort(),
  ).toStrictEqual(["invitation.attributed", "invitation.revoked"]);
  for (const event of received) {
    expect(event).toMatchObject({
      version: 3,
      orgId: actor.orgId,
      userId: actor.userId,
      claimId: invitation.claimId,
      invitationId: invitation.id,
    });
  }
  expect((await deliverEvents()).processed).toBe(0);
});
