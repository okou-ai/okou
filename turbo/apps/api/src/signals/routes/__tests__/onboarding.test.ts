import { randomUUID } from "node:crypto";
import { createStore } from "ccstate";
import { billingStatusContract } from "@okouai/api-contracts/contracts/billing";
import { chatThreadsContract } from "@okouai/api-contracts/contracts/chat-threads";
import {
  onboardingCompleteContract,
  onboardingDraftContract,
  onboardingStatusContract,
} from "@okouai/api-contracts/contracts/onboarding";
import { proactiveSuggestionsContract } from "@okouai/api-contracts/contracts/proactive-suggestions";
import { runModelsMainContract } from "@okouai/api-contracts/contracts/run-models";
import { describe, expect, it } from "vitest";
import { mockNow, now } from "../../../lib/time";
import { setupApp } from "../../../__tests__/test-helpers";
import { accept, testContext } from "../../../__tests__/test-context";
import { billingStatusRoutes } from "../billing-status";
import { chatThreadCreateRoutes } from "../chat-threads-create";
import { onboardingCompleteRoutes } from "../onboarding-complete";
import { onboardingDraftRoutes } from "../onboarding-draft";
import { onboardingStatusRoutes } from "../onboarding-status";
import { proactiveSuggestionsRoutes } from "../proactive-preferences";
import { runModelsRoutes } from "../run-models";
import { mockClerkUsers } from "./helpers/clerk-users";
import { seedOrgMembership$ } from "./helpers/org-membership";
import { createRouteMocks } from "./helpers/route-test";

const context = testContext();
const headers = Object.freeze({ authorization: "Bearer clerk-session" });

type Role = "org:admin" | "org:member";

function signIn(userId: string, orgId: string, role: Role) {
  createRouteMocks(context).clerk.session(userId, orgId, role);
}

function newWorkspace() {
  return {
    orgId: `org_${randomUUID()}`,
    adminId: `user_${randomUUID()}`,
    memberId: `user_${randomUUID()}`,
  };
}

const draftApi = () => {
  return setupApp({ context, routes: onboardingDraftRoutes })(
    onboardingDraftContract,
  );
};
const statusApi = () => {
  return setupApp({ context, routes: onboardingStatusRoutes })(
    onboardingStatusContract,
  );
};
const completeApi = () => {
  return setupApp({ context, routes: onboardingCompleteRoutes })(
    onboardingCompleteContract,
  );
};
const suggestionsApi = () => {
  return setupApp({ context, routes: proactiveSuggestionsRoutes })(
    proactiveSuggestionsContract,
  );
};

function draftBody(
  revision: string | null,
  step: "industry" | "capabilities" = "industry",
) {
  return {
    revision,
    step,
    answers: {
      industry: "marketing" as const,
      experienced: null,
      provider: null,
      startingPromptDraft: "",
      startingPromptKey: "",
      startingPromptOutput: null,
      recommendationJobId: null,
      recommendationStartedAt: null,
    },
  };
}

async function readStatus() {
  return (await accept(statusApi().getStatus({ headers }), [200])).body;
}

async function complete(
  body: { timezone?: string; industry?: "marketing" | "design" } = {},
) {
  return await accept(completeApi().complete({ headers, body }), [200]);
}

async function readSuggestions() {
  return (await accept(suggestionsApi().get({ headers }), [200])).body;
}

async function turnSuggestionsOff() {
  await accept(
    suggestionsApi().updateWithFeed({ headers, body: { enabled: false } }),
    [200],
  );
}

async function listRunModels() {
  const response = await accept(
    setupApp({ context, routes: runModelsRoutes })(runModelsMainContract).list({
      headers,
    }),
    [200],
  );
  return response.body.models.map((model) => {
    return model.model;
  });
}

async function readBilling() {
  return (
    await accept(
      setupApp({ context, routes: billingStatusRoutes })(
        billingStatusContract,
      ).get({ headers }),
      [200],
    )
  ).body;
}

async function createThread() {
  await accept(
    setupApp({ context, routes: chatThreadCreateRoutes })(
      chatThreadsContract,
    ).create({ headers, body: {} }),
    [201],
  );
}

/** Accounts registered now are inside the Suggestions rollout cohort. */
function registerNewAccounts(...userIds: string[]) {
  mockClerkUsers(
    context,
    userIds.map((id) => {
      return { id, createdAt: now() };
    }),
  );
}

describe("Onboarding draft", () => {
  it("onboarding-001 restores one member's draft and refuses stale edits or another member's reads", async () => {
    const { orgId, adminId, memberId } = newWorkspace();
    signIn(memberId, orgId, "org:member");
    const draft = draftApi();

    const first = await accept(
      draft.save({ headers, body: draftBody(null) }),
      [200],
    );
    const second = await accept(
      draft.save({
        headers,
        body: draftBody(first.body.revision, "capabilities"),
      }),
      [200],
    );
    await accept(
      draft.save({ headers, body: draftBody(first.body.revision) }),
      [409],
    );
    const restored = await accept(draft.get({ headers }), [200]);

    expect(restored.body.draft).toMatchObject({
      step: "capabilities",
      revision: second.body.revision,
    });
    signIn(adminId, orgId, "org:member");
    const other = await accept(draft.get({ headers }), [200]);
    expect(other.body.draft).toBeNull();
  });

  it("onboarding-002 expires abandoned drafts and blocks restoration or late saves after completion", async () => {
    const { orgId, memberId } = newWorkspace();
    signIn(memberId, orgId, "org:member");
    const draft = draftApi();
    const savedAt = Date.parse("2026-11-18T00:00:00.000Z");
    mockNow(savedAt);
    await accept(draft.save({ headers, body: draftBody(null) }), [200]);

    mockNow(savedAt + 7 * 24 * 60 * 60 * 1000);
    const expired = await accept(draft.get({ headers }), [200]);
    expect(expired.body.draft).toBeNull();
    const fresh = await accept(
      draft.save({ headers, body: draftBody(null) }),
      [200],
    );

    await complete();
    await accept(draft.get({ headers }), [404]);
    await accept(
      draft.save({ headers, body: draftBody(fresh.body.revision) }),
      [404],
    );
  });
});

describe("member source-first onboarding", () => {
  it("onboarding-004 starts onboarding for a new member", async () => {
    const { orgId, memberId } = newWorkspace();
    signIn(memberId, orgId, "org:member");

    await expect(readStatus()).resolves.toStrictEqual({
      needsOnboarding: true,
      onboardingComplete: false,
      isAdmin: false,
      hasOrg: true,
    });
  });

  it("onboarding-006 records a member's completion without changing the organization's onboarding", async () => {
    const { orgId, adminId, memberId } = newWorkspace();
    signIn(adminId, orgId, "org:admin");
    await expect(readStatus()).resolves.toMatchObject({
      needsOnboarding: true,
      onboardingComplete: false,
    });

    signIn(memberId, orgId, "org:member");
    const completed = await complete({
      timezone: "Asia/Shanghai",
      industry: "marketing",
    });
    expect(completed.body).toStrictEqual({
      onboardingComplete: true,
      needsOnboarding: false,
    });
    await expect(readStatus()).resolves.toMatchObject({
      needsOnboarding: false,
      onboardingComplete: false,
    });

    signIn(adminId, orgId, "org:admin");
    await expect(readStatus()).resolves.toMatchObject({
      needsOnboarding: true,
      onboardingComplete: false,
      isAdmin: true,
    });
    await expect(listRunModels()).resolves.toStrictEqual(["auto"]);
  });

  it("onboarding-008 only counts the member's own threads in the current workspace", async () => {
    const { orgId, adminId: peerId, memberId } = newWorkspace();
    signIn(peerId, orgId, "org:member");
    await createThread();
    signIn(memberId, `org_${randomUUID()}`, "org:member");
    await createThread();

    signIn(memberId, orgId, "org:member");
    const before = await readStatus();
    await createThread();
    const after = await readStatus();

    expect(before).toMatchObject({ needsOnboarding: true, isAdmin: false });
    expect(after).toMatchObject({ needsOnboarding: false, isAdmin: false });
  });
});

describe("POST /api/onboarding/complete", () => {
  it("onboarding-009 starts Suggestions for each new account when that person finishes onboarding", async () => {
    const { orgId, adminId, memberId } = newWorkspace();
    registerNewAccounts(adminId, memberId);
    const people = [
      { userId: adminId, role: "admin" as const },
      { userId: memberId, role: "member" as const },
    ];
    const store = createStore();
    await Promise.all(
      people.map((person) => {
        return store.set(
          seedOrgMembership$,
          { ...person, orgId },
          context.signal,
        );
      }),
    );

    for (const person of people) {
      signIn(person.userId, orgId, `org:${person.role}`);
      const before = await readSuggestions();
      await complete({ timezone: "Asia/Shanghai" });
      const after = await readSuggestions();

      expect(before.enabled).toBeFalsy();
      expect(after).toMatchObject({ enabled: true, status: "enabled" });
    }

    await turnSuggestionsOff();
    await complete({ timezone: "Asia/Shanghai" });

    await expect(readSuggestions()).resolves.toMatchObject({
      enabled: false,
    });
  });

  it("onboarding-011 preserves a new account's opt-out made before onboarding", async () => {
    const { orgId, adminId } = newWorkspace();
    registerNewAccounts(adminId);
    signIn(adminId, orgId, "org:admin");
    await turnSuggestionsOff();

    await complete({ timezone: "Asia/Shanghai" });

    expect((await readSuggestions()).enabled).toBeFalsy();
  });

  it("onboarding-012 can retry onboarding after Clerk temporarily fails to return the account", async () => {
    const { orgId, adminId } = newWorkspace();
    await createStore().set(
      seedOrgMembership$,
      { userId: adminId, orgId, role: "admin" },
      context.signal,
    );
    signIn(adminId, orgId, "org:admin");
    context.mocks.clerk.users.getUser.mockRejectedValueOnce(
      new Error("Clerk is unavailable"),
    );

    await expect(
      setupApp({
        context,
        routes: onboardingCompleteRoutes,
        rethrowErrors: true,
      })(onboardingCompleteContract).complete({ headers, body: {} }),
    ).rejects.toThrow("Clerk is unavailable");
    expect((await readStatus()).needsOnboarding).toBeTruthy();

    registerNewAccounts(adminId);
    await complete({ timezone: "Asia/Shanghai" });
    expect((await readSuggestions()).enabled).toBeTruthy();
  });

  it("onboarding-013 publishes the free Plan on completion and keeps it on replay", async () => {
    const { orgId, adminId } = newWorkspace();
    signIn(adminId, orgId, "org:admin");

    const completed = await complete({ industry: "marketing" });
    const billing = await readBilling();

    const completionBody = {
      onboardingComplete: true,
      needsOnboarding: false,
    };
    expect(completed.body).toStrictEqual(completionBody);
    expect(billing).toMatchObject({
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
    });
    expect((await complete({ industry: "design" })).body).toStrictEqual(
      completionBody,
    );
    expect((await complete()).body).toStrictEqual(completionBody);
    await expect(readBilling()).resolves.toStrictEqual(billing);
    await expect(readStatus()).resolves.toStrictEqual({
      needsOnboarding: false,
      onboardingComplete: true,
      isAdmin: true,
      hasOrg: true,
    });
  });

  it("onboarding-016 persists an admin's completed onboarding state", async () => {
    const { orgId, adminId } = newWorkspace();
    signIn(adminId, orgId, "org:admin");
    await expect(readStatus()).resolves.toStrictEqual({
      needsOnboarding: true,
      onboardingComplete: false,
      isAdmin: true,
      hasOrg: true,
    });

    const completed = await complete();

    expect(completed.body).toStrictEqual({
      onboardingComplete: true,
      needsOnboarding: false,
    });
    await expect(readStatus()).resolves.toMatchObject({
      needsOnboarding: false,
      onboardingComplete: true,
    });
    await expect(listRunModels()).resolves.toStrictEqual(["auto"]);
  });
});
