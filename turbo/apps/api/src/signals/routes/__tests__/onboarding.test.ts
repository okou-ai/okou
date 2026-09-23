import { randomUUID } from "node:crypto";

import {
  onboardingCompleteContract,
  onboardingStatusContract,
} from "@okouai/api-contracts/contracts/onboarding";
import { modelPoliciesMainContract } from "@okouai/api-contracts/contracts/model-policies";
import {
  DEFAULT_ORG_MODEL_POLICY_DEFAULT_MODEL,
  DEFAULT_ORG_MODEL_POLICY_MODELS,
} from "@okouai/api-contracts/contracts/model-providers";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp, setupRawAppRequest } from "../../../__tests__/test-helpers";
import { readOnboardingIndustryFixture } from "../../../test-fixtures/org-metadata";
import { createRouteMocks } from "./helpers/route-test";
import { onboardingCompleteRoutes } from "../onboarding-complete";
import { onboardingStatusRoutes } from "../onboarding-status";
import { modelPoliciesRoutes } from "../model-policies";

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

function modelPoliciesClient() {
  return setupApp({ context, routes: modelPoliciesRoutes })(
    modelPoliciesMainContract,
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
    // No endpoint returns the stored field, so the column is the only place
    // this can be read. The make-something flow never asks the question, so it
    // stays uncollected rather than being filled with a guess.
    await expect(
      readOnboardingIndustryFixture(actor.orgId),
    ).resolves.toBeNull();
    const policies = await accept(
      modelPoliciesClient().list({ headers: authHeaders() }),
      [200],
    );
    expect(
      policies.body.policies.map((policy) => {
        return policy.model;
      }),
    ).toStrictEqual(DEFAULT_ORG_MODEL_POLICY_MODELS);
    expect(policies.body.workspaceDefaultModel).toBe(
      DEFAULT_ORG_MODEL_POLICY_DEFAULT_MODEL,
    );
  });

  it.each([
    {
      provider: "codex" as const,
      models: ["gpt-6-astra", "gpt-6-luna", "gpt-5.6-sol"],
      defaultModel: "gpt-6-luna",
      route: "codex-oauth-token",
    },
    {
      provider: "claudeCode" as const,
      models: ["claude-fable-5-1", "claude-opus-5", "claude-sonnet-5"],
      defaultModel: "claude-opus-5",
      route: "claude-code-oauth-token",
    },
  ])(
    "seeds $provider subscription models even when the default seed was read first",
    async ({ provider, models, defaultModel, route }) => {
      const actor = orgActor();
      mocks.clerk.session(actor.userId, actor.orgId, actor.role);
      const policies = modelPoliciesClient();
      const before = await accept(
        policies.list({ headers: authHeaders() }),
        [200],
      );
      expect(
        before.body.policies.map((policy) => {
          return policy.model;
        }),
      ).toStrictEqual(DEFAULT_ORG_MODEL_POLICY_MODELS);

      await accept(
        onboardingCompleteClient().complete({
          headers: authHeaders(),
          query: { modelProvider: provider },
          body: {},
        }),
        [200],
      );
      const after = await accept(
        policies.list({ headers: authHeaders() }),
        [200],
      );
      expect(
        after.body.policies.map((policy) => {
          return policy.model;
        }),
      ).toStrictEqual(models);
      expect(after.body.workspaceDefaultModel).toBe(defaultModel);
      expect(after.body.policies).toStrictEqual(
        expect.arrayContaining([
          expect.objectContaining({
            model: defaultModel,
            isDefault: true,
            defaultProviderType: route,
            credentialScope: "member",
          }),
        ]),
      );

      await accept(
        onboardingCompleteClient().complete({
          headers: authHeaders(),
          query: {
            modelProvider: provider === "codex" ? "claudeCode" : "codex",
          },
          body: {},
        }),
        [200],
      );
      const repeated = await accept(
        policies.list({ headers: authHeaders() }),
        [200],
      );
      expect(
        repeated.body.policies.map((policy) => {
          return policy.model;
        }),
      ).toStrictEqual(models);
    },
  );

  it("applies a subscription choice after the previous untouched model seed", async () => {
    const actor = orgActor();
    mocks.clerk.session(actor.userId, actor.orgId, actor.role);
    const policies = modelPoliciesClient();
    const oldSeed = await accept(
      policies.update({
        headers: authHeaders(),
        body: {
          policies: [
            {
              model: "claude-fable-5-1",
              isDefault: false,
              defaultProviderType: "built-in",
              credentialScope: "org",
              modelProviderId: null,
            },
            {
              model: "gpt-6-astra",
              isDefault: false,
              defaultProviderType: "built-in",
              credentialScope: "org",
              modelProviderId: null,
            },
            {
              model: "gpt-5.6-luna",
              isDefault: true,
              defaultProviderType: "built-in",
              credentialScope: "org",
              modelProviderId: null,
            },
          ],
        },
      }),
      [200],
    );
    expect(oldSeed.body.workspaceDefaultModel).toBe("gpt-5.6-luna");

    await accept(
      onboardingCompleteClient().complete({
        headers: authHeaders(),
        query: { modelProvider: "codex" },
        body: {},
      }),
      [200],
    );
    const after = await accept(
      policies.list({ headers: authHeaders() }),
      [200],
    );
    expect(after.body.workspaceDefaultModel).toBe("gpt-6-luna");
    expect(
      after.body.policies.find((policy) => {
        return policy.isDefault;
      }),
    ).toMatchObject({
      model: "gpt-6-luna",
      defaultProviderType: "codex-oauth-token",
    });
  });

  it("seeds the chosen models when no model policies were read before completion", async () => {
    const actor = orgActor();
    mocks.clerk.session(actor.userId, actor.orgId, actor.role);

    await accept(
      onboardingCompleteClient().complete({
        headers: authHeaders(),
        query: { modelProvider: "claudeCode" },
        body: {},
      }),
      [200],
    );
    const policies = await accept(
      modelPoliciesClient().list({ headers: authHeaders() }),
      [200],
    );
    expect(
      policies.body.policies.map((policy) => {
        return policy.model;
      }),
    ).toStrictEqual(["claude-fable-5-1", "claude-opus-5", "claude-sonnet-5"]);
    expect(policies.body.workspaceDefaultModel).toBe("claude-opus-5");
  });

  it("keeps a customized model policy when onboarding completes", async () => {
    const actor = orgActor();
    mocks.clerk.session(actor.userId, actor.orgId, actor.role);
    const policies = modelPoliciesClient();
    const before = await accept(
      policies.list({ headers: authHeaders() }),
      [200],
    );
    await accept(
      policies.update({
        headers: authHeaders(),
        body: {
          revision: before.body.revision,
          policies: [
            {
              model: "gpt-5.6-luna",
              isDefault: true,
              defaultProviderType: "built-in",
              credentialScope: "org",
              modelProviderId: null,
            },
          ],
        },
      }),
      [200],
    );

    await accept(
      onboardingCompleteClient().complete({
        headers: authHeaders(),
        query: { modelProvider: "claudeCode" },
        body: {},
      }),
      [200],
    );
    const after = await accept(
      policies.list({ headers: authHeaders() }),
      [200],
    );
    expect(
      after.body.policies.map((policy) => {
        return policy.model;
      }),
    ).toStrictEqual(["gpt-5.6-luna"]);
    expect(after.body.workspaceDefaultModel).toBe("gpt-5.6-luna");
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

    // Read from the column because no endpoint exposes the stored field.
    await expect(readOnboardingIndustryFixture(actor.orgId)).resolves.toBe(
      "marketing",
    );
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

  it("rejects an unknown model preference before completing onboarding", async () => {
    const actor = orgActor();
    mocks.clerk.session(actor.userId, actor.orgId, actor.role);

    const rejected = await setupRawAppRequest({
      context,
      routes: onboardingCompleteRoutes,
    })("/api/onboarding/complete?modelProvider=unknown", {
      method: "POST",
      headers: { ...authHeaders(), "content-type": "application/json" },
      body: "{}",
    });
    expect(rejected.status).toBe(400);
    const status = await accept(
      onboardingStatusClient().getStatus({ headers: authHeaders() }),
      [200],
    );
    expect(status.body.onboardingComplete).toBeFalsy();
  });

  it("rejects a key the completion body does not declare", async () => {
    const actor = orgActor();
    mocks.clerk.session(actor.userId, actor.orgId, actor.role);

    const rejected = await rawCompleteRequest({ industries: ["marketing"] });

    expect(rejected.status).toBe(400);
  });
});
