import { billingUsagePackCreditsContract } from "@okouai/api-contracts/contracts/billing";
import { getStartedContract } from "@okouai/api-contracts/contracts/get-started";
import { orgInviteContract } from "@okouai/api-contracts/contracts/org-member-routes";
import { webhookClerkContract } from "@okouai/api-contracts/contracts/webhooks";
import { randomUUID } from "node:crypto";
import { Webhook } from "svix";
import { beforeEach, expect, test, vi } from "vitest";
import { z } from "zod";
import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { mockOptionalEnv } from "../../../lib/env";
import { nowDate } from "../../../lib/time";
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
  ) {
    super(`Clerk invitation failed: ${code}`);
    this.errors = [{ code, message: code, longMessage: code }];
  }
}

const headers = Object.freeze({ authorization: "Bearer clerk-session" });
const secret = `whsec_${Buffer.from("get-started-synthetic-secret").toString("base64")}`;
const sentInvitation = z.object({
  organizationId: z.string(),
  privateMetadata: z.object({ getStartedClaimId: z.string().uuid() }),
});

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

test("keeps unrelated Clerk invitation failures as server errors", async () => {
  await org();
  context.mocks.clerk.organizations.createOrganizationInvitation.mockRejectedValueOnce(
    new ClerkInvitationTestError("invalid_clerk_configuration", 400),
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
});

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
});

test("concurrent acceptances fill all 15 global invitation slots while pending invitations consume none", async () => {
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
});
