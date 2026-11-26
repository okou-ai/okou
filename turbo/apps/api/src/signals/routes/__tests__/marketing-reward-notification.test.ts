import { randomUUID } from "node:crypto";
import { getStartedContract } from "@okouai/api-contracts/contracts/get-started";
import { marketingRewardNotificationContract } from "@okouai/api-contracts/contracts/marketing-reward-notification";
import { orgInviteContract } from "@okouai/api-contracts/contracts/org-member-routes";
import { http, HttpResponse } from "msw";
import { describe, expect, it } from "vitest";
import {
  accept,
  testContext,
  type TestContext,
} from "../../../__tests__/test-context";
import { setupApp, setupRawAppRequest } from "../../../__tests__/test-helpers";
import { env, mockEnv } from "../../../lib/env";
import {
  marketingRewardCheckinEventSchema,
  type MarketingRewardSourceEvent,
} from "../../../lib/marketing-reward-events";
import { mockNow } from "../../../lib/time";
import { server } from "../../../mocks/server";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { getStartedRoutes } from "../get-started";
import { marketingRewardNotificationRoutes } from "../marketing-reward-notification";
import { orgInviteRoutes } from "../org-invite";
import type { ApiTestUser } from "./helpers/api-bdd";
import { createAuthOrgBddApi } from "./helpers/api-bdd-auth-org";
import { createBddIntegrationApi } from "./helpers/api-bdd-integrations";
import {
  campaignRequest,
  marketingRewardConsumer,
  settleMarketingRequest,
} from "./helpers/marketing-reward-consumer";
import { captureRewardProjectionPublications } from "./helpers/reward-projection-publications";
import { createRouteMocks } from "./helpers/route-test";

const context = testContext();
const api = createAuthOrgBddApi(context);
const integrations = createBddIntegrationApi(context);
const notifications = setupApp({
  context,
  routes: marketingRewardNotificationRoutes,
})(marketingRewardNotificationContract);
const occurredAtMs = Date.parse("2026-10-12T08:00:00.000Z");

function configureProjection(ctx: TestContext) {
  mockEnv("ENV", "development");
  mockNow(occurredAtMs);
  const secret = `projection-${randomUUID()}`;
  mockEnv("MARKETING_REWARDS_PROJECTION_SECRET", secret);
  return {
    publications: captureRewardProjectionPublications(ctx),
    headers: { authorization: `Bearer ${secret}` },
  };
}

/** Clerk keeps the invitation pending while the inviter's claim is retained. */
function clerkKeepsInvitationsPending(orgId: string) {
  server.use(
    http.get(
      "https://api.clerk.com/v1/organizations/:orgId/invitations/:invitationId",
      ({ params }) => {
        return HttpResponse.json({
          id: String(params.invitationId),
          organization_id: orgId,
          status: "pending",
          expires_at: occurredAtMs + 24 * 60 * 60 * 1000,
        });
      },
    ),
  );
}

async function onboardedInviter(): Promise<ApiTestUser & { orgId: string }> {
  const inviter = api.user();
  api.acceptStorageWrites();
  api.mockClerkOrg(inviter);
  await api.bootstrapLimitedFreeOnboarding(inviter);
  const orgId = inviter.orgId;
  if (!orgId) {
    throw new Error("expected a workspace inviter");
  }
  clerkKeepsInvitationsPending(orgId);
  return { ...inviter, orgId };
}

async function inviteTeammate(inviter: ApiTestUser) {
  const invitationId = `orginv_${randomUUID()}`;
  context.mocks.clerk.organizations.createOrganizationInvitation.mockResolvedValue(
    { id: invitationId },
  );
  await accept(
    setupApp({ context, routes: orgInviteRoutes })(orgInviteContract).invite({
      headers: api.authenticate(inviter),
      body: { email: `invitee_${randomUUID()}@example.test`, role: "member" },
    }),
    [200],
  );
  await flushWaitUntilForTest();
  return invitationId;
}

function sourceEvent(
  received: readonly MarketingRewardSourceEvent[],
  type: MarketingRewardSourceEvent["type"],
): MarketingRewardSourceEvent {
  const event = received.find((candidate) => {
    return candidate.type === type;
  });
  if (!event) {
    throw new Error(`expected a ${type} source event`);
  }
  return event;
}

/** The member checks in; the campaign acknowledges and settles the retained source. */
async function settledCheckin() {
  const consumer = marketingRewardConsumer();
  mockEnv(
    "MARKETING_REWARDS_CAMPAIGN_SECRET",
    `campaign-${randomUUID()}-${randomUUID()}`,
  );
  server.use(
    http.post(
      "https://marketing-consumer.example.test/api/internal/marketing/get-started/check-in",
      () => {
        return HttpResponse.json({ status: "pending" }, { status: 202 });
      },
    ),
  );
  const userId = `user_${randomUUID()}`;
  const orgId = `org_${randomUUID()}`;
  createRouteMocks(context).clerk.session(userId, orgId, "org:member");
  await accept(
    setupApp({ context, routes: getStartedRoutes })(getStartedContract).checkin(
      { headers: { authorization: "Bearer clerk-session" } },
    ),
    [202],
  );
  await flushWaitUntilForTest();
  const source = marketingRewardCheckinEventSchema.parse(
    sourceEvent(consumer.received, "checkin.requested"),
  );
  const day = source.occurredAt.slice(0, 10);
  const terms = {
    version: 1 as const,
    environment: source.environment,
    policy: "get-started-v1" as const,
    sourceEventId: source.id,
    questKey: "checkin" as const,
    sourceKey: day,
    rewardKey: `checkin:${userId}:${day}`,
    orgId,
    actorUserId: userId,
    beneficiaryUserId: userId,
    rewardTarget: "user" as const,
    rewardAmount: 100,
    completedAt: source.occurredAt,
  };
  const settled = await settleMarketingRequest(context, terms);
  return {
    userId,
    orgId,
    intent: campaignRequest(terms),
    receipt: settled.body.receipt,
  };
}

describe("POST /api/internal/marketing/get-started/notifications", () => {
  it("marketing-reward-notification-005 requires a dedicated projection credential and the exact committed financial receipt before queueing a refresh", async () => {
    const { userId, orgId, intent, receipt } = await settledCheckin();
    const { publications, headers } = configureProjection(context);
    mockEnv("CRON_SECRET", `cron-${randomUUID()}`);
    const settlement = { kind: "settlement" as const, version: 1 as const };
    createRouteMocks(context).clerk.session(userId, orgId, "org:member");

    const wrongCredentials = await Promise.all(
      [
        "Bearer clerk-session",
        `Bearer ${env("CRON_SECRET")}`,
        `Bearer ${env("MARKETING_REWARDS_SETTLEMENT_SECRET")}`,
      ].map((authorization) => {
        return notifications.notify({
          headers: { authorization },
          body: { ...settlement, intent, receipt },
        });
      }),
    );
    const altered = await Promise.all(
      [
        { ...receipt, orgId: `org_${randomUUID()}` },
        { ...receipt, beneficiaryUserId: `user_${randomUUID()}` },
        { ...receipt, rewardAmount: receipt.rewardAmount + 1 },
        { ...receipt, memberCreditGrantId: randomUUID() },
      ].map((changed) => {
        return notifications.notify({
          headers,
          body: { ...settlement, intent, receipt: changed },
        });
      }),
    );
    await flushWaitUntilForTest();
    mockEnv("MARKETING_REWARDS_PROJECTION_SECRET", undefined);
    const unconfigured = await notifications.notify({
      headers,
      body: { ...settlement, intent, receipt },
    });

    for (const response of wrongCredentials) {
      expect(response.status).toBe(401);
      expect(response.headers.get("cache-control")).toBe("no-store");
    }
    expect(
      altered.map((response) => {
        return response.status;
      }),
    ).toStrictEqual([409, 409, 409, 409]);
    expect(publications).toStrictEqual([]);
    expect(unconfigured.status).toBe(503);
  });

  it("marketing-reward-notification-004 refreshes a signed revocation using its retained original inviter", async () => {
    const consumer = marketingRewardConsumer();
    const inviter = await onboardedInviter();
    const invitationId = await inviteTeammate(inviter);
    await accept(
      setupApp({ context, routes: orgInviteRoutes })(orgInviteContract).revoke({
        headers: api.authenticate(inviter),
        body: { invitationId },
      }),
      [200],
    );
    await flushWaitUntilForTest();
    const revoked = sourceEvent(consumer.received, "invitation.revoked");
    const { publications, headers } = configureProjection(context);

    await accept(
      notifications.notify({
        headers,
        body: {
          kind: "progress",
          version: 1,
          environment: "development",
          source: { kind: "event", eventId: revoked.id },
        },
      }),
      [200],
    );
    await flushWaitUntilForTest();

    expect(publications).toStrictEqual([
      { channel: `user:${inviter.userId}`, name: "getStartedRewardsChanged" },
    ]);
  });

  it("marketing-reward-notification-002 deduplicates source refreshes durably without changing pending invitations or choosing the recipient from the request", async () => {
    const consumer = marketingRewardConsumer();
    const inviter = await onboardedInviter();
    await inviteTeammate(inviter);
    const attributed = sourceEvent(consumer.received, "invitation.attributed");
    const { publications, headers } = configureProjection(context);
    const progress = {
      kind: "progress" as const,
      version: 1 as const,
      environment: "development" as const,
      source: { kind: "event" as const, eventId: attributed.id },
    };

    // The strict contract cannot express a caller-chosen recipient.
    const chosen = await setupRawAppRequest({
      context,
      routes: marketingRewardNotificationRoutes,
    })("/api/internal/marketing/get-started/notifications", {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({
        ...progress,
        beneficiaryUserId: `user_${randomUUID()}`,
      }),
    });
    const concurrent = await Promise.all(
      Array.from({ length: 4 }, () => {
        return accept(notifications.notify({ headers, body: progress }), [200]);
      }),
    );
    await flushWaitUntilForTest();
    const afterConcurrent = [...publications];
    const repeated = await accept(
      notifications.notify({ headers, body: progress }),
      [200],
    );
    await flushWaitUntilForTest();

    expect(chosen.status).toBe(400);
    const [first] = concurrent;
    if (!first) {
      throw new Error("expected concurrent refresh responses");
    }
    expect(first.body).toStrictEqual({
      version: 1,
      environment: "development",
      source: progress.source,
      notificationId: expect.any(String),
    });
    for (const response of [...concurrent, repeated]) {
      expect(response.body).toStrictEqual(first.body);
    }
    expect(afterConcurrent).toStrictEqual([
      { channel: `user:${inviter.userId}`, name: "getStartedRewardsChanged" },
    ]);
    expect(publications).toStrictEqual(afterConcurrent);
  });

  it("marketing-reward-notification-007 routes an organization reward refresh only to its original actor and organization", async () => {
    mockEnv("ENV", "development");
    mockNow(occurredAtMs);
    const consumer = marketingRewardConsumer();
    integrations.configureSlackAppMocks();
    const actor = integrations.user({ orgRole: "org:admin" });
    const orgId = actor.orgId;
    if (!orgId) {
      throw new Error("expected an organization actor");
    }
    const { teamId } = await integrations.installSlackWorkspace(actor);
    await flushWaitUntilForTest();
    const authorized = sourceEvent(consumer.received, "slack.oauth-authorized");
    const terms = {
      version: 1 as const,
      environment: authorized.environment,
      policy: "get-started-v1" as const,
      sourceEventId: authorized.id,
      questKey: "slack" as const,
      sourceKey: teamId,
      rewardKey: `slack:${teamId}`,
      orgId,
      actorUserId: actor.userId,
      beneficiaryUserId: null,
      rewardTarget: "org" as const,
      rewardAmount: 2000,
      completedAt: authorized.occurredAt,
    };
    const settled = await settleMarketingRequest(context, terms);
    const { publications, headers } = configureProjection(context);

    await accept(
      notifications.notify({
        headers,
        body: {
          kind: "settlement",
          version: 1,
          intent: campaignRequest(terms),
          receipt: settled.body.receipt,
        },
      }),
      [200],
    );
    await flushWaitUntilForTest();

    expect(publications).toHaveLength(2);
    expect(publications).toStrictEqual(
      expect.arrayContaining([
        { channel: `user:${actor.userId}`, name: "getStartedRewardsChanged" },
        { channel: `org:${orgId}`, name: "slack:changed" },
      ]),
    );
  });
});
