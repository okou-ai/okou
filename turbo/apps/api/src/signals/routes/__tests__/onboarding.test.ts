import { randomUUID } from "node:crypto";

import {
  onboardingCompleteContract,
  onboardingStatusContract,
} from "@okouai/api-contracts/contracts/onboarding";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp, setupRawAppRequest } from "../../../__tests__/test-helpers";
import { readOnboardingIndustryFixture } from "../../../test-fixtures/org-metadata";
import { createRouteMocks } from "./helpers/route-test";
import { onboardingCompleteRoutes } from "../onboarding-complete";
import { onboardingStatusRoutes } from "../onboarding-status";

const context = testContext();
const mocks = createRouteMocks(context);

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

  it("does not start onboarding for an organization member", async () => {
    const actor = orgActor("org:member");
    mocks.clerk.session(actor.userId, actor.orgId, actor.role);

    const response = await accept(
      onboardingStatusClient().getStatus({ headers: authHeaders() }),
      [200],
    );

    expect(response.body).toStrictEqual({
      needsOnboarding: false,
      onboardingComplete: false,
      isAdmin: false,
      hasOrg: true,
      hasDefaultAgent: false,
      defaultAgentId: null,
      defaultAgentMetadata: null,
    });
  });
});

describe("POST /api/onboarding/complete", () => {
  it("returns 403 when an organization member tries to complete onboarding", async () => {
    const actor = orgActor("org:member");
    mocks.clerk.session(actor.userId, actor.orgId, actor.role);

    const response = await accept(
      onboardingCompleteClient().complete({
        headers: authHeaders(),
        body: {},
      }),
      [403],
    );

    expect(response.body).toStrictEqual({
      error: {
        message: "Only org admins can complete onboarding",
        code: "FORBIDDEN",
      },
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
    // The make-something flow never asks the question, so the field stays
    // uncollected rather than being filled with a guess.
    await expect(
      readOnboardingIndustryFixture(actor.orgId),
    ).resolves.toBeNull();
  });

  it("stores the field the source-first flow answered", async () => {
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

    await expect(readOnboardingIndustryFixture(actor.orgId)).resolves.toBe(
      "marketing",
    );
  });

  it("drops a field the flow does not offer without holding up completion", async () => {
    const actor = orgActor();
    mocks.clerk.session(actor.userId, actor.orgId, actor.role);

    const completed = await rawCompleteRequest({ industry: "farming" });

    expect(completed.status).toBe(200);
    expect(completed.body).toStrictEqual({
      onboardingComplete: true,
      needsOnboarding: false,
    });
    await expect(
      readOnboardingIndustryFixture(actor.orgId),
    ).resolves.toBeNull();
  });

  it("rejects a key the completion body does not declare", async () => {
    const actor = orgActor();
    mocks.clerk.session(actor.userId, actor.orgId, actor.role);

    const rejected = await rawCompleteRequest({ industries: ["marketing"] });

    expect(rejected.status).toBe(400);
  });
});
