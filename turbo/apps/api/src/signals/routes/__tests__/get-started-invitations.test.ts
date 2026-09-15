import { randomUUID } from "node:crypto";
import { getStartedContract } from "@okouai/api-contracts/contracts/get-started";
import { orgInviteContract } from "@okouai/api-contracts/contracts/org-member-routes";
import { testUsageSettlementContract } from "@okouai/api-contracts/contracts/test-usage-settlement";
import { webhookClerkContract } from "@okouai/api-contracts/contracts/webhooks";
import { beforeEach, expect, test, vi } from "vitest";
import { z } from "zod";
import { Webhook } from "svix";
import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { mockEnv, mockOptionalEnv } from "../../../lib/env";
import { nowDate } from "../../../lib/time";
import { getStartedRoutes } from "../get-started";
import { orgInviteRoutes } from "../org-invite";
import { testUsageSettlementRoutes } from "../test-usage-settlement";
import { webhooksClerkRoutes } from "../webhooks-clerk";
import { createRouteMocks } from "./helpers/route-test";

const context = testContext();
const mocks = createRouteMocks(context);
const headers = Object.freeze({ authorization: "Bearer clerk-session" });
const secret = `whsec_${Buffer.from("get-started-synthetic-secret").toString("base64")}`;
const sentInvitation = z.object({
  organizationId: z.string(),
  privateMetadata: z.object({ getStartedClaimId: z.string().uuid() }),
});

beforeEach(async () => {
  mockEnv("GET_STARTED_REWARDS_ROLLOUT", "all");
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
  await accept(
    setupApp({ context, routes: testUsageSettlementRoutes })(
      testUsageSettlementContract,
    ).setup({ body: { org_id: orgId, credits: 0 } }),
    [200],
  );
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
    [200],
  );
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

test("the 14-to-15 boundary is serialized across organizations and pending invitations never consume slots", async () => {
  const first = await org();
  const sameInvitee = `user_${randomUUID()}`;
  for (let i = 0; i < 14; i++) {
    const invitation = await sendInvitation();
    await accepted(
      first.orgId,
      invitation,
      i === 0 ? sameInvitee : `user_${randomUUID()}`,
    );
  }
  const pendingA = await sendInvitation();
  const second = await org(first.userId);
  const pendingB = await sendInvitation();
  const pendingC = await sendInvitation();
  await expect(progress()).resolves.toMatchObject({
    claimedCount: 14,
    pendingCount: 3,
  });
  await Promise.all([
    accepted(first.orgId, pendingA, `user_${randomUUID()}`),
    accepted(second.orgId, pendingB, `user_${randomUUID()}`),
  ]);
  await expect(progress()).resolves.toMatchObject({
    claimedCount: 15,
    earnedCredits: 1500,
    canEarnMore: false,
    pendingCount: 1,
  });
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
