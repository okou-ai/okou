import { randomUUID } from "node:crypto";
import { orgInviteContract } from "@okouai/api-contracts/contracts/org-member-routes";
import { http, HttpResponse } from "msw";
import { describe, expect, it } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { mockEnv } from "../../../lib/env";
import { now } from "../../../lib/time";
import { server } from "../../../mocks/server";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { orgInviteRoutes } from "../org-invite";
import { createAuthOrgBddApi } from "./helpers/api-bdd-auth-org";
import { createWebhookCallbackApi } from "./helpers/api-bdd-webhooks";
import {
  marketingRewardConsumer,
  settleMarketingRequest,
} from "./helpers/marketing-reward-consumer";

const context = testContext();
const api = createAuthOrgBddApi(context);
const orgInviteClient = setupApp({ context, routes: orgInviteRoutes })(
  orgInviteContract,
);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function extractPrivateMetadata(callArg: unknown): Record<string, unknown> {
  if (isRecord(callArg) && isRecord(callArg.privateMetadata)) {
    return callArg.privateMetadata;
  }
  return {};
}

async function prepareAcceptedInviteSettlement() {
  mockEnv("ENV", "development");
  const consumer = marketingRewardConsumer();
  const inviter = api.user();
  api.acceptStorageWrites();
  api.mockClerkOrg(inviter);
  await api.bootstrapLimitedFreeOnboarding(inviter);
  const orgId = inviter.orgId;
  if (!orgId) {
    throw new Error("Expected a workspace member");
  }
  const invitationId = `orginv_${randomUUID()}`;
  const inviteeEmail = `invitee_${randomUUID()}@example.test`;
  const inviteeId = `user_${randomUUID()}`;
  const invitedAt = now();
  context.mocks.clerk.organizations.createOrganizationInvitation.mockResolvedValue(
    { id: invitationId },
  );
  server.use(
    http.get(
      "https://api.clerk.com/v1/organizations/:orgId/invitations/:invitationId",
      () => {
        return HttpResponse.json({
          object: "organization_invitation",
          id: invitationId,
          organization_id: orgId,
          email_address: inviteeEmail,
          role: "org:member",
          status: "pending",
          expires_at: invitedAt + 86_400_000,
          private_metadata: {},
          public_metadata: {},
          created_at: invitedAt,
          updated_at: invitedAt,
        });
      },
    ),
  );
  await accept(
    orgInviteClient.invite({
      headers: api.authenticate(inviter),
      body: { email: inviteeEmail, role: "member" },
    }),
    [200],
  );
  const lastCall: readonly unknown[] =
    context.mocks.clerk.organizations.createOrganizationInvitation.mock.calls.at(
      -1,
    ) ?? [];
  const privateMetadata = extractPrivateMetadata(lastCall[0]);
  const webhooks = createWebhookCallbackApi(context);
  webhooks.configureClerkWebhookSecret();
  webhooks.verifyNextClerkWebhook({
    type: "organizationInvitation.accepted",
    data: {
      id: invitationId,
      organization_id: orgId,
      user_id: inviteeId,
      email_address: inviteeEmail,
      updated_at: now(),
      private_metadata: privateMetadata,
    },
  });
  await webhooks.requestClerkWebhook("{}", {}, [200]);
  await flushWaitUntilForTest();
  const accepted = consumer.received.find((event) => {
    return event.type === "invitation.accepted";
  });
  if (accepted?.type !== "invitation.accepted") {
    throw new Error("Expected the accepted invitation fact");
  }
  const terms = {
    version: 1,
    environment: accepted.environment,
    policy: "get-started-v1",
    sourceEventId: accepted.id,
    questKey: "invite",
    sourceKey: accepted.sourceKey,
    rewardKey: `invite:${inviteeId}`,
    orgId,
    actorUserId: inviter.userId,
    beneficiaryUserId: inviter.userId,
    rewardTarget: "user",
    rewardAmount: 100,
    completedAt: accepted.occurredAt,
  } as const;
  return { inviter, inviteeId, accepted, terms };
}

describe("Marketing reward settlement", () => {
  it("marketing-reward-settlement-007 (1/2) captures a signed acceptance and settles the original inviter", async () => {
    const { inviter, inviteeId, accepted, terms } =
      await prepareAcceptedInviteSettlement();

    const first = await settleMarketingRequest(context, terms);

    expect(first.body.receipt).toMatchObject({
      id: accepted.claimId,
      status: "granted",
      beneficiaryUserId: inviter.userId,
      rewardKey: `invite:${inviteeId}`,
    });
  });

  it("marketing-reward-settlement-007 (2/2) returns the exact same settlement body on repeat", async () => {
    const { terms } = await prepareAcceptedInviteSettlement();

    const first = await settleMarketingRequest(context, terms);
    const repeat = await settleMarketingRequest(context, terms);

    expect(repeat.body).toStrictEqual(first.body);
  });
});
