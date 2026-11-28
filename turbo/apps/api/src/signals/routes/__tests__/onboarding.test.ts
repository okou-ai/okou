import { randomUUID } from "node:crypto";

import { billingStatusContract } from "@okouai/api-contracts/contracts/billing";
import {
  onboardingCompleteContract,
  onboardingDraftContract,
  onboardingStatusContract,
} from "@okouai/api-contracts/contracts/onboarding";
import type { OnboardingDraftPayload } from "@okouai/api-contracts/validators/onboarding";
import { proactiveSuggestionsContract } from "@okouai/api-contracts/contracts/proactive-suggestions";
import { runModelsMainContract } from "@okouai/api-contracts/contracts/run-models";

import { accept, testContext } from "../../../__tests__/test-context";
import { mockNow, now } from "../../../lib/time";
import { setupApp } from "../../../__tests__/test-helpers";
import { createBddApi } from "./helpers/api-bdd";
import { createChatFilesBddApi } from "./helpers/api-bdd-chat-files";
import { createRouteMocks } from "./helpers/route-test";
import { mockClerkUsers } from "./helpers/clerk-users";
import { installWorkflowVolumeS3Fixture } from "./helpers/workflow-volume-s3";
import { billingStatusRoutes } from "../billing-status";
import { onboardingCompleteRoutes } from "../onboarding-complete";
import { onboardingDraftRoutes } from "../onboarding-draft";
import { onboardingStatusRoutes } from "../onboarding-status";
import { proactiveSuggestionsRoutes } from "../proactive-preferences";
import { runModelsRoutes } from "../run-models";

const context = testContext();
const mocks = createRouteMocks(context);
const bdd = createBddApi(context);
const chat = createChatFilesBddApi(context);

function authHeaders() {
  return { authorization: "Bearer clerk-session" };
}

function onboardingStatusClient() {
  return setupApp({ context, routes: onboardingStatusRoutes })(
    onboardingStatusContract,
  );
}

function onboardingCompleteClient() {
  return setupApp({ context, routes: onboardingCompleteRoutes })(
    onboardingCompleteContract,
  );
}

function runModelsClient() {
  return setupApp({ context, routes: runModelsRoutes })(runModelsMainContract);
}

function billingStatusClient() {
  return setupApp({ context, routes: billingStatusRoutes })(
    billingStatusContract,
  );
}

function suggestionsClient() {
  return setupApp({ context, routes: proactiveSuggestionsRoutes })(
    proactiveSuggestionsContract,
  );
}

function orgActor(role: "org:admin" | "org:member" = "org:admin") {
  return {
    userId: `user_${randomUUID()}`,
    orgId: `org_${randomUUID()}`,
    role,
  } as const;
}

interface OrgActor {
  readonly userId: string;
  readonly orgId: string;
  readonly role: "org:admin" | "org:member";
}

/** A second person in `admin`'s organization, without admin rights. */
function memberOf(admin: OrgActor) {
  return {
    userId: `user_${randomUUID()}`,
    orgId: admin.orgId,
    role: "org:member",
  } as const;
}

async function statusAs(actor: OrgActor) {
  mocks.clerk.session(actor.userId, actor.orgId, actor.role);
  const response = await accept(
    onboardingStatusClient().getStatus({ headers: authHeaders() }),
    [200],
  );
  return response.body;
}

async function completeAs(
  actor: OrgActor,
  request: {
    readonly body?: {
      readonly timezone?: string;
      readonly industry?: "marketing";
    };
  } = {},
) {
  mocks.clerk.session(actor.userId, actor.orgId, actor.role);
  const response = await accept(
    onboardingCompleteClient().complete({
      headers: authHeaders(),
      body: request.body ?? {},
    }),
    [200],
  );
  return response.body;
}

describe("Onboarding draft", () => {
  const headers = authHeaders();
  const draft: OnboardingDraftPayload = {
    step: "ready",
    answers: {
      industry: "marketing",
      experienced: true,
      provider: null,
      startingPromptDraft: "Draft a product launch plan",
      startingPromptKey: "marketing",
      startingPromptOutput: null,
      recommendationJobId: null,
      recommendationStartedAt: null,
    },
  };

  function draftClientAs(actor: OrgActor) {
    mocks.clerk.session(actor.userId, actor.orgId, actor.role);
    return setupApp({ context, routes: onboardingDraftRoutes })(
      onboardingDraftContract,
    );
  }

  it("restores the member's draft, rejects stale edits and isolates users and workspaces", async () => {
    const actor = orgActor("org:member");
    const client = draftClientAs(actor);
    const stored = await accept(
      client.save({ headers, body: { ...draft, revision: null } }),
      [200],
    );
    const updated = await accept(
      client.save({
        headers,
        body: {
          ...draft,
          step: "capabilities",
          revision: stored.body.revision,
        },
      }),
      [200],
    );

    await accept(
      client.save({
        headers,
        body: { ...draft, revision: stored.body.revision },
      }),
      [409],
    );
    const restored = await accept(client.get({ headers }), [200]);
    expect(restored.body.draft).toStrictEqual({
      ...draft,
      step: "capabilities",
      revision: updated.body.revision,
    });
    expect(
      (await accept(draftClientAs(memberOf(actor)).get({ headers }), [200]))
        .body.draft,
    ).toBeNull();
    const otherWorkspace = { ...actor, orgId: `org_${randomUUID()}` };
    const otherDraft = await accept(
      draftClientAs(otherWorkspace).get({ headers }),
      [200],
    );
    expect(otherDraft.body.draft).toBeNull();
  });

  it("expires abandoned drafts and blocks restoration or late saves after completion", async () => {
    const actor = orgActor("org:member");
    const client = draftClientAs(actor);
    const started = Date.parse("2026-11-18T00:00:00Z");
    mockNow(started);
    await accept(
      client.save({ headers, body: { ...draft, revision: null } }),
      [200],
    );

    mockNow(started + 7 * 24 * 60 * 60 * 1000);
    expect(
      (await accept(client.get({ headers }), [200])).body.draft,
    ).toBeNull();
    const second = await accept(
      client.save({ headers, body: { ...draft, revision: null } }),
      [200],
    );
    await completeAs(actor);
    await accept(client.get({ headers }), [404]);
    await accept(
      client.save({
        headers,
        body: { ...draft, revision: second.body.revision },
      }),
      [404],
    );
  });
});

describe("GET /api/onboarding/status", () => {
  it("returns 401 when the request is unauthenticated", async () => {
    const response = await accept(
      onboardingStatusClient().getStatus({ headers: {} }),
      [401],
    );

    expect(response.body).toStrictEqual({
      error: { message: "Not authenticated", code: "UNAUTHORIZED" },
    });
  });
});

describe("member source-first onboarding", () => {
  it("starts onboarding for a new member", async () => {
    const admin = orgActor();
    const member = memberOf(admin);

    await expect(statusAs(member)).resolves.toStrictEqual({
      needsOnboarding: true,
      onboardingComplete: false,
      isAdmin: false,
      hasOrg: true,
    });
  });

  it("keeps the organization's completion as the org-wide answer for a member", async () => {
    const admin = orgActor();
    const member = memberOf(admin);
    await completeAs(admin);

    // The owner finishing setup does not finish it for the member.
    await expect(statusAs(member)).resolves.toMatchObject({
      needsOnboarding: true,
      onboardingComplete: true,
      isAdmin: false,
    });
  });

  it("records a member's completion without changing the organization's onboarding", async () => {
    const admin = orgActor();
    const member = memberOf(admin);
    const adminBefore = await statusAs(admin);
    expect(adminBefore).toMatchObject({
      needsOnboarding: true,
      onboardingComplete: false,
    });

    const completed = await completeAs(member, {
      body: { timezone: "Asia/Shanghai", industry: "marketing" },
    });

    expect(completed).toStrictEqual({
      onboardingComplete: true,
      needsOnboarding: false,
    });
    await expect(statusAs(member)).resolves.toMatchObject({
      needsOnboarding: false,
      onboardingComplete: false,
      isAdmin: false,
    });
    // The admin still has the workspace to set up, and none of the member's
    // answers were taken as the organization's.
    await expect(statusAs(admin)).resolves.toMatchObject({
      needsOnboarding: true,
      onboardingComplete: false,
      isAdmin: true,
    });
    mocks.clerk.session(admin.userId, admin.orgId, admin.role);
    const policies = await accept(
      runModelsClient().list({ headers: authHeaders() }),
      [200],
    );
    expect(
      policies.body.models.map((policy) => {
        return policy.model;
      }),
    ).toStrictEqual(["auto"]);
  });

  it("does not pull a member with an existing thread in the workspace into onboarding", async () => {
    const admin = bdd.user();
    if (!admin.orgId) {
      throw new Error("Expected the seeded admin to belong to an org");
    }
    const existing = bdd.user({ orgId: admin.orgId, orgRole: "org:member" });
    bdd.acceptStorageWrites();
    await chat.createThread(existing, {});
    const member = {
      userId: existing.userId,
      orgId: admin.orgId,
      role: "org:member",
    } as const;

    await expect(statusAs(member)).resolves.toMatchObject({
      needsOnboarding: false,
      isAdmin: false,
    });
  });

  it("only counts the member's own threads in the current workspace", async () => {
    const member = bdd.user({ orgRole: "org:member" });
    if (!member.orgId) {
      throw new Error("Expected the member to belong to an org");
    }
    const actor = {
      userId: member.userId,
      orgId: member.orgId,
      role: "org:member",
    } as const;
    const peer = bdd.user({
      orgId: member.orgId,
      orgRole: "org:member",
    });
    const sameUserElsewhere = bdd.user({
      userId: member.userId,
      email: member.email,
      orgRole: "org:member",
    });
    bdd.acceptStorageWrites();
    await chat.createThread(peer, {});
    await chat.createThread(sameUserElsewhere, {});
    await expect(statusAs(actor)).resolves.toMatchObject({
      needsOnboarding: true,
      isAdmin: false,
    });
    await chat.createThread(member, {});
    await expect(statusAs(actor)).resolves.toMatchObject({
      needsOnboarding: false,
      isAdmin: false,
    });
  });
});

describe("POST /api/onboarding/complete", () => {
  it("starts Suggestions for each new account when that person finishes onboarding", async () => {
    installWorkflowVolumeS3Fixture(context);
    const admin = orgActor();
    const member = memberOf(admin);
    const people = [admin, member];
    mockClerkUsers(
      context,
      people.map(({ userId }) => {
        return { id: userId, createdAt: now() };
      }),
    );
    context.mocks.clerk.organizations.getOrganizationMembershipList.mockResolvedValue(
      {
        data: people.map((actor) => {
          return {
            id: `membership-${actor.userId}`,
            organization: { id: actor.orgId },
            publicUserData: { userId: actor.userId },
            role: actor.role,
          };
        }),
      },
    );
    const preferences = suggestionsClient();
    const headers = authHeaders();
    for (const person of people) {
      mocks.clerk.session(person.userId, person.orgId, person.role);
      expect(
        (await accept(preferences.get({ headers }), [200])).body.enabled,
      ).toBeFalsy();
      await completeAs(person, { body: { timezone: "Asia/Shanghai" } });
      expect(
        (await accept(preferences.get({ headers }), [200])).body,
      ).toMatchObject({
        enabled: true,
        status: "enabled",
      });
    }
    await accept(
      preferences.updateWithFeed({ headers, body: { enabled: false } }),
      [200],
    );
    await completeAs(member);
    expect(
      (await accept(preferences.get({ headers }), [200])).body.enabled,
    ).toBeFalsy();
  });

  it("keeps a pre-rollout account paused when it joins a new workspace", async () => {
    const member = orgActor("org:member");
    mockClerkUsers(context, [
      { id: member.userId, createdAt: Date.parse("2020-01-01T00:00:00Z") },
    ]);
    await completeAs(member);
    const preference = await accept(
      suggestionsClient().get({ headers: authHeaders() }),
      [200],
    );
    expect(preference.body).toMatchObject({ enabled: false, status: "paused" });
  });

  it("preserves a new account's opt-out made before onboarding", async () => {
    const actor = orgActor();
    mocks.clerk.session(actor.userId, actor.orgId, actor.role);
    mockClerkUsers(context, [{ id: actor.userId, createdAt: now() }]);
    const preferences = suggestionsClient();
    const headers = authHeaders();
    await accept(
      preferences.updateWithFeed({ headers, body: { enabled: false } }),
      [200],
    );
    await completeAs(actor);
    expect(
      (await accept(preferences.get({ headers }), [200])).body.enabled,
    ).toBeFalsy();
  });

  it("can retry onboarding after Clerk temporarily fails to return the account", async () => {
    const actor = orgActor();
    mocks.clerk.session(actor.userId, actor.orgId, actor.role);
    context.mocks.clerk.users.getUser.mockRejectedValueOnce(
      new Error("Clerk is unavailable"),
    );
    const onboarding = setupApp({
      context,
      routes: onboardingCompleteRoutes,
      rethrowErrors: true,
    })(onboardingCompleteContract);
    await expect(
      onboarding.complete({ headers: authHeaders(), body: {} }),
    ).rejects.toThrow("Clerk is unavailable");
    await expect(statusAs(actor)).resolves.toMatchObject({
      needsOnboarding: true,
    });
    mockClerkUsers(context, [{ id: actor.userId, createdAt: now() }]);
    await completeAs(actor);
    const preference = await accept(
      suggestionsClient().get({ headers: authHeaders() }),
      [200],
    );
    expect(preference.body.enabled).toBeTruthy();
  });

  it("publishes the free Plan on completion and keeps it on replay", async () => {
    const actor = orgActor();
    mocks.clerk.session(actor.userId, actor.orgId, actor.role);

    await expect(
      completeAs(actor, { body: { industry: "marketing" } }),
    ).resolves.toStrictEqual({
      onboardingComplete: true,
      needsOnboarding: false,
    });
    const billing = await accept(
      billingStatusClient().get({ headers: authHeaders() }),
      [200],
    );
    expect(billing.body).toMatchObject({
      tier: "limited-free-1",
      status: "active",
      concurrencyLimit: 2,
      canBuyConcurrency: false,
      canBuyCredits: true,
      showUsagePack: false,
      autoRechargeAllowed: false,
      restrictedBuiltInModels: true,
      workflowWebhookAutomationAllowed: false,
      credits: 0,
      hasSubscription: false,
      subscriptionStatus: null,
    });

    const replay = await accept(
      onboardingCompleteClient().complete({
        headers: authHeaders(),
        body: { industry: "design" },
      }),
      [200],
    );
    expect(replay.body).toStrictEqual({
      onboardingComplete: true,
      needsOnboarding: false,
    });
    await expect(completeAs(actor)).resolves.toStrictEqual(replay.body);
    const afterReplay = await accept(
      billingStatusClient().get({ headers: authHeaders() }),
      [200],
    );
    expect(afterReplay.body).toStrictEqual(billing.body);
    await expect(statusAs(actor)).resolves.toMatchObject({
      onboardingComplete: true,
      needsOnboarding: false,
      isAdmin: true,
      hasOrg: true,
    });
  });

  it("completes simultaneous public requests without an industry and preserves completion on replay", async () => {
    const actor = orgActor();
    mocks.clerk.session(actor.userId, actor.orgId, actor.role);
    const client = onboardingCompleteClient();

    const responses = await Promise.all([
      accept(client.complete({ headers: authHeaders(), body: {} }), [200]),
      accept(client.complete({ headers: authHeaders(), body: {} }), [200]),
    ]);
    for (const response of responses) {
      expect(response.body).toStrictEqual({
        onboardingComplete: true,
        needsOnboarding: false,
      });
    }
    const billing = await accept(
      billingStatusClient().get({ headers: authHeaders() }),
      [200],
    );
    expect(billing.body).toMatchObject({
      tier: "limited-free-1",
      status: "active",
      concurrencyLimit: 2,
      restrictedBuiltInModels: true,
      canBuyCredits: true,
      credits: 0,
    });
    await expect(completeAs(actor)).resolves.toStrictEqual({
      onboardingComplete: true,
      needsOnboarding: false,
    });
    await expect(statusAs(actor)).resolves.toMatchObject({
      onboardingComplete: true,
      needsOnboarding: false,
      isAdmin: true,
    });
  });

  it("lets a member complete onboarding instead of refusing them", async () => {
    const member = orgActor("org:member");

    await expect(completeAs(member)).resolves.toStrictEqual({
      onboardingComplete: true,
      needsOnboarding: false,
    });
  });

  it("persists an admin's completed onboarding state", async () => {
    const actor = orgActor();
    mocks.clerk.session(actor.userId, actor.orgId, actor.role);

    const before = await accept(
      onboardingStatusClient().getStatus({ headers: authHeaders() }),
      [200],
    );
    expect(before.body).toMatchObject({
      needsOnboarding: true,
      onboardingComplete: false,
      isAdmin: true,
      hasOrg: true,
    });

    const completed = await accept(
      onboardingCompleteClient().complete({
        headers: authHeaders(),
        body: {},
      }),
      [200],
    );
    expect(completed.body).toStrictEqual({
      onboardingComplete: true,
      needsOnboarding: false,
    });

    const after = await accept(
      onboardingStatusClient().getStatus({ headers: authHeaders() }),
      [200],
    );
    expect(after.body).toMatchObject({
      needsOnboarding: false,
      onboardingComplete: true,
      isAdmin: true,
      hasOrg: true,
    });
    const policies = await accept(
      runModelsClient().list({ headers: authHeaders() }),
      [200],
    );
    expect(
      policies.body.models.map((policy) => {
        return policy.model;
      }),
    ).toStrictEqual(["auto"]);
  });

  it("completes an admin's onboarding with the field the source-first flow answered", async () => {
    const actor = orgActor();
    mocks.clerk.session(actor.userId, actor.orgId, actor.role);

    const completed = await accept(
      onboardingCompleteClient().complete({
        headers: authHeaders(),
        body: { industry: "marketing" },
      }),
      [200],
    );
    expect(completed.body).toStrictEqual({
      onboardingComplete: true,
      needsOnboarding: false,
    });

    const status = await accept(
      onboardingStatusClient().getStatus({ headers: authHeaders() }),
      [200],
    );
    expect(status.body).toMatchObject({
      needsOnboarding: false,
      onboardingComplete: true,
      isAdmin: true,
    });
  });
});
