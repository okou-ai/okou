import { randomUUID } from "node:crypto";
import { orgInviteContract } from "@okouai/api-contracts/contracts/org-member-routes";
import { beforeEach, expect, test } from "vitest";
import { http, HttpResponse } from "msw";
import { server } from "../../../mocks/server";
import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { mockEnv } from "../../../lib/env";
import { mockNow, now, nowDate } from "../../../lib/time";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { orgInviteRoutes } from "../org-invite";
import { createBddApi } from "./helpers/api-bdd";
import { readGetStartedStatus } from "./helpers/get-started";
import { marketingRewardConsumer } from "./helpers/marketing-reward-consumer";
import { createRouteMocks } from "./helpers/route-test";
import { createApp } from "../../../app-factory";
import { cronProcessBackgroundJobsRoutes } from "../cron-process-background-jobs";

const context = testContext();
const bdd = createBddApi(context);
const mocks = createRouteMocks(context);

beforeEach(() => {
  mockEnv("CLERK_SECRET_KEY", "sk_test_invitation_observation_fixture");
});

test("the source-only operator reports durable progress without settling the public invitation", async () => {
  const fixture = await invited("pending");
  mockEnv("CRON_SECRET", "source-preparation-cron-secret");
  const response = await createApp({
    signal: context.signal,
    routes: cronProcessBackgroundJobsRoutes,
  }).request(
    "/api/cron/process-background-jobs?marketingRewardsOnly=true&maxRewardEvents=25",
    { headers: { authorization: "Bearer source-preparation-cron-secret" } },
  );
  expect(response.status).toBe(200);
  await expect(response.json()).resolves.toMatchObject({
    cleaned: 0,
    processed: expect.any(Number),
    sourcePending: expect.any(Number),
    unobservedInvitations: expect.any(Number),
  });
  const status = await readGetStartedStatus(context, fixture.actor);
  expect(
    status.quests.find((quest) => {
      return quest.key === "invite";
    }),
  ).toMatchObject({ pendingCount: 1, claimedCount: 0 });
  expect(
    fixture.consumer.received.some((event) => {
      return event.type === "invitation.status-observed";
    }),
  ).toBe(true);
});

async function invited(
  status:
    | "pending"
    | "accepted"
    | "unavailable"
    | "provider failure"
    | "different organization",
) {
  const consumer = marketingRewardConsumer();
  const actor = bdd.user();
  await bdd.completeOnboarding(actor);
  mocks.clerk.session(actor.userId, actor.orgId);
  const invitationId = `inv_${randomUUID()}`;
  const expiry = new Date(now() + 24 * 3_600_000);
  context.mocks.clerk.organizations.createOrganizationInvitation.mockResolvedValueOnce(
    { id: invitationId },
  );
  server.use(
    http.get(
      `https://api.clerk.com/v1/organizations/${actor.orgId}/invitations/${invitationId}`,
      () => {
        if (status === "unavailable") {
          return new HttpResponse(null, { status: 404 });
        }
        if (status === "provider failure") {
          return new HttpResponse(null, { status: 503 });
        }
        return HttpResponse.json({
          id: invitationId,
          organization_id:
            status === "different organization"
              ? "org_wrong_owner"
              : actor.orgId,
          status: status === "different organization" ? "pending" : status,
          expires_at: expiry.getTime(),
          email_address: "private-invitee@example.com",
          private_metadata: { secret: "private-provider-metadata" },
          url: "https://example.test/accept?ticket=private-invitation-ticket",
        });
      },
    ),
  );
  await accept(
    setupApp({ context, routes: orgInviteRoutes })(orgInviteContract).invite({
      headers: { authorization: "Bearer clerk-session" },
      body: { email: `${randomUUID()}@example.com`, role: "member" },
    }),
    [200],
  );
  await flushWaitUntilForTest();
  const source = consumer.received.find((event) => {
    return event.type === "invitation.attributed";
  });
  if (!source || source.type !== "invitation.attributed") {
    throw new Error("Expected original public invitation provenance");
  }
  return { actor, consumer, source, expiry };
}

test.each(["pending", "accepted", "unavailable"] as const)(
  "durably publishes minimal %s authority from the real invitation flow without issuing credits",
  async (status) => {
    const observedAt = nowDate();
    mockNow(observedAt);
    const fixture = await invited(status);
    const observations = fixture.consumer.received.filter((event) => {
      return (
        event.type === "invitation.status-observed" &&
        event.claimId === fixture.source.claimId
      );
    });
    expect(observations).toHaveLength(1);
    expect(observations[0]).toMatchObject({
      version: 6,
      type: "invitation.status-observed",
      environment: "development",
      occurredAt: observedAt.toISOString(),
      claimCreatedAt: observedAt.toISOString(),
      orgId: fixture.actor.orgId,
      userId: fixture.actor.userId,
      claimId: fixture.source.claimId,
      sourceKey: fixture.source.sourceKey,
      invitationId: fixture.source.invitationId,
      observation:
        status === "unavailable"
          ? { kind: "unavailable" }
          : {
              kind: "invitation",
              status,
              expiresAt: fixture.expiry.toISOString(),
            },
    });
    const serialized = JSON.stringify(observations);
    for (const value of [
      "private-invitee@example.com",
      "private-provider-metadata",
      "private-invitation-ticket",
    ]) {
      expect(serialized).not.toContain(value);
    }
    expect(
      (await readGetStartedStatus(context, fixture.actor)).quests,
    ).toContainEqual(
      expect.objectContaining({
        key: "invite",
        claimedCount: 0,
        pendingCount: 1,
      }),
    );
  },
);

test.each(["provider failure", "different organization"] as const)(
  "retains pending state on %s instead of inventing unavailability",
  async (failure) => {
    mockNow(nowDate());
    const fixture = await invited(failure);
    expect(
      fixture.consumer.received.filter((event) => {
        return (
          event.type === "invitation.status-observed" &&
          event.claimId === fixture.source.claimId
        );
      }),
    ).toHaveLength(0);
    expect(
      (await readGetStartedStatus(context, fixture.actor)).quests,
    ).toContainEqual(
      expect.objectContaining({
        key: "invite",
        claimedCount: 0,
        pendingCount: 1,
      }),
    );
  },
);
