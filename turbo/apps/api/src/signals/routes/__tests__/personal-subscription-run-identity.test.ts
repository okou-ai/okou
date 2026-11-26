import { randomUUID } from "node:crypto";
import { personalModelProvidersMainContract } from "@okouai/api-contracts/contracts/personal-model-providers";
import { runModelsMainContract } from "@okouai/api-contracts/contracts/run-models";
import { userPreferencesContract } from "@okouai/api-contracts/contracts/user-preferences";
import { describe, expect, it } from "vitest";
import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { meModelProvidersUpsertRoutes } from "../me-model-providers-upsert";
import { runModelsRoutes } from "../run-models";
import { userPreferencesRoutes } from "../user-preferences";
import {
  makeCodexAuthJson,
  mockClaudeCodeTokenEndpoint,
} from "./helpers/api-bdd-auth-device";
import { createRouteMocks } from "./helpers/route-test";

const context = testContext();
const headers = Object.freeze({ authorization: "Bearer clerk-session" });

function signIn(
  userId: string,
  orgId: string,
  role: "org:admin" | "org:member",
): void {
  createRouteMocks(context).clerk.session(userId, orgId, role);
}

async function listRunModels() {
  const api = setupApp({ context, routes: runModelsRoutes })(
    runModelsMainContract,
  );
  return (await accept(api.list({ headers }), [200])).body.models;
}

async function setupWorkspaceWithOwnerClaude() {
  const orgId = `org_${randomUUID()}`;
  const ownerId = `user_${randomUUID()}`;
  const memberId = `user_${randomUUID()}`;

  signIn(ownerId, orgId, "org:admin");
  mockClaudeCodeTokenEndpoint();
  await accept(
    setupApp({ context, routes: meModelProvidersUpsertRoutes })(
      personalModelProvidersMainContract,
    ).upsert({
      headers,
      body: {
        type: "claude-code-oauth-token",
        secret: "owner-claude-token",
      },
    }),
    [201],
  );

  signIn(memberId, orgId, "org:member");
  await accept(
    setupApp({ context, routes: userPreferencesRoutes })(
      userPreferencesContract,
    ).initialize({
      headers,
      body: { locale: "en-US" },
    }),
    [200],
  );

  return { orgId, ownerId, memberId };
}

describe("member-effective model contract", () => {
  it("personal-subscription-run-identity-031 (1/2) shares Auto and scopes the owner's Claude subscription to the owner", async () => {
    const { orgId, ownerId, memberId } = await setupWorkspaceWithOwnerClaude();

    signIn(ownerId, orgId, "org:admin");
    const ownerInitial = await listRunModels();

    signIn(memberId, orgId, "org:member");
    const memberInitial = await listRunModels();

    const ownerAuto = ownerInitial.find((entry) => {
      return entry.model === "auto";
    });
    const memberAuto = memberInitial.find((entry) => {
      return entry.model === "auto";
    });
    expect(ownerAuto).toBeDefined();
    expect(ownerAuto?.modelLabel).toBe("Auto");
    expect(memberAuto).toStrictEqual(ownerAuto);

    const ownerClaude = ownerInitial.find((entry) => {
      return entry.model === "claude-sonnet-5-5";
    });
    expect(ownerClaude).toBeDefined();
    expect(ownerClaude?.memberEffective).toMatchObject({
      runtimeProviderType: "claude-code-oauth-token",
      credentialScope: "member",
      accountSelection: "capture_required",
    });
    expect(
      memberInitial.some((entry) => {
        return entry.model === "claude-sonnet-5-5";
      }),
    ).toBeFalsy();
  });

  it("personal-subscription-run-identity-031 (2/2) scopes a member's Codex subscription without changing the owner's models", async () => {
    const { orgId, ownerId, memberId } = await setupWorkspaceWithOwnerClaude();

    signIn(ownerId, orgId, "org:admin");
    const ownerBefore = (await listRunModels()).find((entry) => {
      return entry.model === "claude-sonnet-5-5";
    });

    signIn(memberId, orgId, "org:member");
    await accept(
      setupApp({ context, routes: meModelProvidersUpsertRoutes })(
        personalModelProvidersMainContract,
      ).upsert({
        headers,
        body: {
          type: "codex-oauth-token",
          authMethod: "auth_json",
          secrets: { CODEX_AUTH_JSON: makeCodexAuthJson() },
        },
      }),
      [201],
    );

    const memberAfter = await listRunModels();
    const memberCodex = memberAfter.find((entry) => {
      return entry.model === "gpt-6-astra";
    });
    expect(memberCodex).toBeDefined();
    expect(memberCodex?.memberEffective).toMatchObject({
      runtimeProviderType: "codex-oauth-token",
      credentialScope: "member",
    });
    expect(
      memberAfter.some((entry) => {
        return entry.model === "claude-sonnet-5-5";
      }),
    ).toBeFalsy();

    signIn(ownerId, orgId, "org:admin");
    const ownerAfter = await listRunModels();
    expect(
      ownerAfter.some((entry) => {
        return entry.model === "gpt-6-astra";
      }),
    ).toBeFalsy();
    expect(
      ownerAfter.find((entry) => {
        return entry.model === "claude-sonnet-5-5";
      }),
    ).toStrictEqual(ownerBefore);
  });
});
