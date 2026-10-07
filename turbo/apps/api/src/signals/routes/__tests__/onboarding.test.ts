import { randomUUID } from "node:crypto";

import {
  onboardingCompleteContract,
  onboardingStatusContract,
} from "@okouai/api-contracts/contracts/onboarding";
import { runModelsMainContract } from "@okouai/api-contracts/contracts/run-models";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp, setupRawAppRequest } from "../../../__tests__/test-helpers";
import { createBddApi } from "./helpers/api-bdd";
import { createChatFilesBddApi } from "./helpers/api-bdd-chat-files";
import { createRouteMocks } from "./helpers/route-test";
import { onboardingCompleteRoutes } from "../onboarding-complete";
import { onboardingStatusRoutes } from "../onboarding-status";
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

/**
 * A request the typed client cannot express: the contract narrows `industry`
 * to the offered list and rejects a key it does not declare.
 */
function rawCompleteRequest(body: Record<string, unknown>) {
  return setupRawAppRequest({ context, routes: onboardingCompleteRoutes })(
    "/api/onboarding/complete",
    {
      method: "POST",
      headers: { ...authHeaders(), "content-type": "application/json" },
      body: JSON.stringify(body),
    },
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

function mockDefaultAgentStorage(): void {
  context.mocks.s3.send.mockResolvedValue({ ContentLength: 1024 });
  context.mocks.s3.getSignedUrl.mockResolvedValue(
    "https://r2.example.test/default-agent.tar.gz?signature=test",
  );
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
      hasDefaultAgent: false,
      defaultAgentId: null,
      defaultAgentMetadata: null,
    });
  });

  it("keeps the organization's completion as the org-wide answer for a member", async () => {
    mockDefaultAgentStorage();
    const admin = orgActor();
    const member = memberOf(admin);
    await statusAs(admin);
    await completeAs(admin);

    // The owner finishing setup does not finish it for the member.
    await expect(statusAs(member)).resolves.toMatchObject({
      needsOnboarding: true,
      onboardingComplete: true,
      isAdmin: false,
    });
  });

  it("records a member's completion without changing the organization's onboarding", async () => {
    mockDefaultAgentStorage();
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
    ).toStrictEqual([null]);
  });

  it("does not pull a member who already chats in the workspace into onboarding", async () => {
    const admin = bdd.user();
    if (!admin.orgId) {
      throw new Error("Expected the seeded admin to belong to an org");
    }
    const existing = bdd.user({ orgId: admin.orgId, orgRole: "org:member" });
    bdd.acceptAgentStorageWrites();
    const agent = await bdd.createAgent(existing, {
      displayName: "Existing member agent",
      visibility: "private",
    });
    await chat.createThread(existing, { agentId: agent.agentId });
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
});

describe("POST /api/onboarding/complete", () => {
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
    context.mocks.s3.send.mockResolvedValue({ ContentLength: 1024 });
    context.mocks.s3.getSignedUrl.mockResolvedValue(
      "https://r2.example.test/default-agent.tar.gz?signature=test",
    );

    const before = await accept(
      onboardingStatusClient().getStatus({ headers: authHeaders() }),
      [200],
    );
    expect(before.body).toMatchObject({
      needsOnboarding: true,
      onboardingComplete: false,
      isAdmin: true,
      hasOrg: true,
      hasDefaultAgent: true,
    });
    expect(before.body.defaultAgentId).toBeTruthy();

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
      hasDefaultAgent: true,
      defaultAgentId: before.body.defaultAgentId,
    });
    const policies = await accept(
      runModelsClient().list({ headers: authHeaders() }),
      [200],
    );
    expect(
      policies.body.models.map((policy) => {
        return policy.model;
      }),
    ).toStrictEqual([null]);
  });

  it("completes an admin's onboarding with the field the source-first flow answered", async () => {
    const actor = orgActor();
    mockDefaultAgentStorage();
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

  it("rejects a field the flow does not offer", async () => {
    const actor = orgActor();
    mocks.clerk.session(actor.userId, actor.orgId, actor.role);
    context.mocks.s3.send.mockResolvedValue({ ContentLength: 1024 });
    context.mocks.s3.getSignedUrl.mockResolvedValue(
      "https://r2.example.test/default-agent.tar.gz?signature=test",
    );

    const rejected = await rawCompleteRequest({ industry: "farming" });

    expect(rejected.status).toBe(400);
    const status = await accept(
      onboardingStatusClient().getStatus({ headers: authHeaders() }),
      [200],
    );
    expect(status.body).toMatchObject({
      needsOnboarding: true,
      onboardingComplete: false,
    });
  });

  it("rejects a key the completion body does not declare", async () => {
    const actor = orgActor();
    mocks.clerk.session(actor.userId, actor.orgId, actor.role);

    const rejected = await rawCompleteRequest({ industries: ["marketing"] });

    expect(rejected.status).toBe(400);
  });
});
