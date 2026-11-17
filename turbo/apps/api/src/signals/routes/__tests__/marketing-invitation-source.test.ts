import { randomUUID } from "node:crypto";
import { marketingInvitationSourceContract } from "@okouai/api-contracts/contracts/marketing-invitation-source";
import { orgInviteContract } from "@okouai/api-contracts/contracts/org-member-routes";
import { http, HttpResponse } from "msw";
import { beforeEach, expect, test } from "vitest";
import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { mockEnv } from "../../../lib/env";
import { mockNow } from "../../../lib/time";
import { server } from "../../../mocks/server";
import { marketingInvitationSourceRoutes } from "../marketing-invitation-source";
import { orgInviteRoutes } from "../org-invite";
import { createBddApi } from "./helpers/api-bdd";
import { createRouteMocks } from "./helpers/route-test";
import { marketingRewardConsumer } from "./helpers/marketing-reward-consumer";
import { readGetStartedStatus } from "./helpers/get-started";

const context = testContext();
const bdd = createBddApi(context);
const mocks = createRouteMocks(context);
const secret = "invitation-source-service-1234567890123456789012345";
const headers = Object.freeze({ authorization: `Bearer ${secret}` });

beforeEach(() => {
  mockEnv("MARKETING_REWARDS_SOURCE_SECRET", secret);
  mockEnv("CLERK_SECRET_KEY", "sk_test_invitation_authority_fixture");
});

function client() {
  return setupApp({ context, routes: marketingInvitationSourceRoutes })(
    marketingInvitationSourceContract,
  );
}

async function invited() {
  const consumer = marketingRewardConsumer(context);
  const actor = bdd.user();
  await bdd.completeOnboarding(actor);
  mocks.clerk.session(actor.userId, actor.orgId);
  const invitationId = `inv_${randomUUID()}`;
  context.mocks.clerk.organizations.createOrganizationInvitation.mockResolvedValueOnce(
    { id: invitationId },
  );
  await accept(
    setupApp({ context, routes: orgInviteRoutes })(orgInviteContract).invite({
      headers: { authorization: "Bearer clerk-session" },
      body: { email: `${randomUUID()}@example.com`, role: "member" },
    }),
    [200],
  );
  await consumer.deliver();
  const source = consumer.received.find((event) => {
    return event.type === "invitation.attributed";
  });
  if (!source || source.type !== "invitation.attributed") {
    throw new Error("Expected the public invitation's retained source proof");
  }
  return {
    actor,
    source,
    url: `https://api.clerk.com/v1/organizations/${actor.orgId}/invitations/${invitationId}`,
    provider: {
      id: invitationId,
      organization_id: actor.orgId,
      status: "pending",
      expires_at: Date.parse("2026-11-18T09:20:00.000Z"),
      email_address: "private-invitee@example.com",
      private_metadata: { secret: "private-provider-metadata" },
      url: "https://accounts.example.test/accept?ticket=private-invitation-ticket",
    },
  };
}

test("authenticates the dedicated capability before reading any retained invitation or its provider", async () => {
  const params = { eventId: randomUUID() };
  for (const credential of [
    "clerk-session",
    "financial-settlement-secret",
    "event-intake-secret",
  ]) {
    const denied = await client().observe({
      params,
      headers: { authorization: `Bearer ${credential}` },
    });
    expect(denied.status).toBe(401);
    expect(denied.headers.get("cache-control")).toBe("no-store");
    expect(
      (
        await client().observeClaim({
          params: { claimId: params.eventId },
          headers: { authorization: `Bearer ${credential}` },
        })
      ).status,
    ).toBe(401);
  }
  expect((await client().observe({ params, headers })).status).toBe(404);
  mockEnv("MARKETING_REWARDS_SOURCE_SECRET", undefined);
  const disabled = await client().observe({ params, headers });
  expect(disabled.status).toBe(503);
  expect(disabled.headers.get("cache-control")).toBe("no-store");
  expect(
    (
      await client().observeClaim({
        params: { claimId: params.eventId },
        headers,
      })
    ).status,
  ).toBe(503);
});

test("reads original claim provenance separately from event identity and never treats provider acceptance as an award", async () => {
  await setupApp({
    context,
    routes: marketingInvitationSourceRoutes,
    isolatePg: true,
  });
  mockNow(new Date("2026-11-17T09:00:00.000Z"));
  const fixture = await invited();
  const params = { claimId: fixture.source.claimId };
  server.use(
    http.get(fixture.url, () => {
      return HttpResponse.json(fixture.provider);
    }),
  );
  const observed = await accept(
    client().observeClaim({ params, headers }),
    [200],
  );
  expect(observed.headers.get("cache-control")).toBe("no-store");
  expect(observed.body.source).toStrictEqual({
    kind: "legacy-invitation",
    claimId: fixture.source.claimId,
    createdAt: "2026-11-17T09:00:00.000Z",
    orgId: fixture.actor.orgId,
    actorUserId: fixture.actor.userId,
    inviterUserId: fixture.actor.userId,
    sourceKey: fixture.source.sourceKey,
    invitationId: fixture.source.invitationId,
  });
  expect(observed.body.observation).toStrictEqual({
    kind: "invitation",
    status: "pending",
    expiresAt: "2026-11-18T09:20:00.000Z",
  });
  expect(JSON.stringify(observed.body)).not.toContain(
    "private-invitation-ticket",
  );
  expect(JSON.stringify(observed.body)).not.toContain(
    fixture.provider.email_address,
  );
  expect(
    (
      await client().observeClaim({
        params: { claimId: fixture.source.id },
        headers,
      })
    ).status,
  ).toBe(404);
  server.use(
    http.get(fixture.url, () => {
      return HttpResponse.json({ ...fixture.provider, status: "accepted" });
    }),
  );
  expect(
    (await accept(client().observeClaim({ params, headers }), [200])).body
      .observation,
  ).toMatchObject({ kind: "invitation", status: "accepted" });
  expect(
    (await readGetStartedStatus(context, fixture.actor)).quests,
  ).toContainEqual(
    expect.objectContaining({
      key: "invite",
      claimedCount: 0,
      pendingCount: 1,
    }),
  );
  server.use(
    http.get(fixture.url, () => {
      return new HttpResponse(null, { status: 503 });
    }),
  );
  expect((await client().observeClaim({ params, headers })).status).toBe(503);
  server.use(
    http.get(fixture.url, () => {
      return new HttpResponse(null, { status: 404 });
    }),
  );
  expect(
    (await accept(client().observeClaim({ params, headers }), [200])).body
      .observation,
  ).toStrictEqual({ kind: "unavailable" });
});

test("returns the provider's exact status and expiry with the original inviter while omitting invitation secrets and personal content", async () => {
  await setupApp({
    context,
    routes: marketingInvitationSourceRoutes,
    isolatePg: true,
  });
  mockNow(new Date("2026-11-17T08:10:00.000Z"));
  const fixture = await invited();
  server.use(
    http.get(fixture.url, () => {
      return HttpResponse.json(fixture.provider);
    }),
  );
  const response = await accept(
    client().observe({ params: { eventId: fixture.source.id }, headers }),
    [200],
  );
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(response.body).toStrictEqual({
    version: 1,
    environment: "development",
    observedAt: "2026-11-17T08:10:00.000Z",
    source: {
      eventId: fixture.source.id,
      occurredAt: fixture.source.occurredAt,
      orgId: fixture.actor.orgId,
      inviterUserId: fixture.actor.userId,
      claimId: fixture.source.claimId,
      sourceKey: fixture.source.sourceKey,
      invitationId: fixture.source.invitationId,
    },
    observation: {
      kind: "invitation",
      status: "pending",
      expiresAt: "2026-11-18T09:20:00.000Z",
    },
  });
  const serialized = JSON.stringify(response.body);
  for (const privateValue of [
    fixture.provider.email_address,
    fixture.provider.private_metadata.secret,
    "private-invitation-ticket",
  ]) {
    expect(serialized).not.toContain(privateValue);
  }
  server.use(
    http.get(fixture.url, () => {
      return HttpResponse.json({ ...fixture.provider, status: "accepted" });
    }),
  );
  const accepted = await accept(
    client().observe({ params: { eventId: fixture.source.id }, headers }),
    [200],
  );
  expect(accepted.body.observation).toMatchObject({
    kind: "invitation",
    status: "accepted",
  });
  expect(
    (await readGetStartedStatus(context, fixture.actor)).quests.find(
      (quest) => {
        return quest.key === "invite";
      },
    ),
  ).toMatchObject({ claimedCount: 0, pendingCount: 1 });
});

test("represents an exact provider miss as unavailable while keeping provider failures and ownership mismatches visible", async () => {
  await setupApp({
    context,
    routes: marketingInvitationSourceRoutes,
    isolatePg: true,
  });
  const fixture = await invited();
  const params = { eventId: fixture.source.id };
  server.use(
    http.get(fixture.url, () => {
      return new HttpResponse(null, { status: 404 });
    }),
  );
  const missing = await accept(client().observe({ params, headers }), [200]);
  expect(missing.body.observation).toStrictEqual({ kind: "unavailable" });
  server.use(
    http.get(fixture.url, () => {
      return new HttpResponse(null, { status: 503 });
    }),
  );
  expect((await client().observe({ params, headers })).status).toBe(503);
  server.use(
    http.get(fixture.url, () => {
      return HttpResponse.json({
        ...fixture.provider,
        organization_id: "org_wrong_owner",
      });
    }),
  );
  expect((await client().observe({ params, headers })).status).toBe(500);
  expect(
    (await readGetStartedStatus(context, fixture.actor)).quests.find(
      (quest) => {
        return quest.key === "invite";
      },
    ),
  ).toMatchObject({ claimedCount: 0 });
});
