import { randomUUID } from "node:crypto";
import { billingUsagePackCreditsContract } from "@okouai/api-contracts/contracts/billing";
import { getStartedContract } from "@okouai/api-contracts/contracts/get-started";

import { describe, expect, it } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { mockEnv } from "../../../lib/env";
import { createBddApi, type ApiTestUser } from "./helpers/api-bdd";
import {
  createConnectorBddApi,
  mockGitHubConnectorOAuth,
} from "./helpers/api-bdd-connectors";
import { createGithubBddApi } from "./helpers/api-bdd-github";
import { createRouteMocks } from "./helpers/route-test";
import { billingUsagePackCreditsRoutes } from "../billing-usage-pack-credits";
import { getStartedRoutes } from "../get-started";

const context = testContext();
const bdd = createBddApi(context);
const connectors = createConnectorBddApi(context);
const github = createGithubBddApi(context);
const mocks = createRouteMocks(context);

async function readConnectorReward(actor: ApiTestUser) {
  mocks.clerk.session(actor.userId, actor.orgId, actor.orgRole);
  const headers = { authorization: "Bearer clerk-session" };
  const status = await accept(
    setupApp({ context, routes: getStartedRoutes })(getStartedContract).status({
      headers,
    }),
    [200],
  );
  const credits = await accept(
    setupApp({ context, routes: billingUsagePackCreditsRoutes })(
      billingUsagePackCreditsContract,
    ).get({ headers }),
    [200],
  );
  return { status: status.body, credits: credits.body };
}

function oauthState(authorizationUrl: string): string {
  const state = new URL(authorizationUrl).searchParams.get("state");
  if (!state) {
    throw new Error("Expected GitHub OAuth state");
  }
  return state;
}

async function connectGithubAdd(
  actor: ApiTestUser,
  args: {
    readonly code: string;
    readonly displayName: string;
    readonly userId: number;
    readonly login: string;
  },
): Promise<void> {
  mockGitHubConnectorOAuth({ userId: args.userId, login: args.login });
  const start = await connectors.startOauth(
    actor,
    "github",
    "oauth",
    undefined,
    { intent: "add", displayName: args.displayName },
  );
  await connectors.completeOauthCallback("github", {
    code: args.code,
    state: oauthState(start.authorizationUrl),
  });
}

describe("GitHub OAuth account mutation selection", () => {
  it("links connector callbacks only to their organization's active installation", async () => {
    const first = bdd.user();
    const firstAgent = await bdd.createAgent(first, {
      displayName: `First GitHub organization ${randomUUID()}`,
    });
    const firstInstallation = await github.installGithubApp(
      first,
      firstAgent.agentId,
    );
    const second = bdd.user();
    const secondAgent = await bdd.createAgent(second, {
      displayName: `Second GitHub organization ${randomUUID()}`,
    });
    const secondInstallation = await github.installGithubApp(
      second,
      secondAgent.agentId,
    );

    await connectGithubAdd(first, {
      code: "github-first-organization-link",
      displayName: "First organization",
      userId: 901,
      login: "github-first-organization",
    });
    await expect(github.readInstallation(first)).resolves.toMatchObject({
      connectedGithubUserId: "901",
      isConnected: true,
      installation: {
        installationId: firstInstallation.remoteInstallationId,
        status: "active",
      },
    });
    await expect(github.readInstallation(second)).resolves.toMatchObject({
      connectedGithubUserId: null,
      isConnected: false,
      installation: {
        installationId: secondInstallation.remoteInstallationId,
        status: "active",
      },
    });

    await connectGithubAdd(second, {
      code: "github-second-organization-link",
      displayName: "Second organization",
      userId: 902,
      login: "github-second-organization",
    });
    await expect(github.readInstallation(second)).resolves.toMatchObject({
      connectedGithubUserId: "902",
      isConnected: true,
      installation: {
        installationId: secondInstallation.remoteInstallationId,
        status: "active",
      },
    });
    await expect(github.readInstallation(first)).resolves.toMatchObject({
      connectedGithubUserId: "901",
      isConnected: true,
      installation: {
        installationId: firstInstallation.remoteInstallationId,
        status: "active",
      },
    });
  });

  it("redirects state-less GitHub App updates to the configured Okou app", async () => {
    mockEnv("APP_URL", "https://app.okou.ai");
    mockEnv("OKOU_WEB_URL", "https://www.okou.ai");
    mockEnv("OKOU_API_BACKEND_URL", "https://api.okou.ai");

    const actor = bdd.user();
    const agent = await bdd.createAgent(actor, {
      displayName: `Okou GitHub setup ${randomUUID()}`,
    });
    const installation = await github.installGithubApp(actor, agent.agentId);
    await expect(github.readInstallation(actor)).resolves.toMatchObject({
      installation: {
        installationId: installation.remoteInstallationId,
        status: "active",
        targetType: "Organization",
        targetName: "bdd-org",
      },
    });
    const update = await github.requestSetupCallback(
      new URLSearchParams({
        installation_id: installation.remoteInstallationId,
        setup_action: "update",
      }).toString(),
      { origin: "https://api.okou.ai" },
    );
    expect(update.status).toBe(307);
    expect(new URL(update.location ?? "").origin).toBe("https://app.okou.ai");
  });

  it("adds a new identity and refreshes the exact existing sibling", async () => {
    const actor = bdd.user();
    await connectors.updateFeatureSwitches(actor, {});

    await connectGithubAdd(actor, {
      code: "github-first-add",
      displayName: "First",
      userId: 101,
      login: "github-first",
    });
    await connectGithubAdd(actor, {
      code: "github-second-add",
      displayName: "Second",
      userId: 202,
      login: "github-second",
    });

    const beforeRefresh = await connectors.listBuiltinConnectorAccounts(
      actor,
      "github",
    );
    expect(beforeRefresh).toHaveLength(2);
    const secondBefore = beforeRefresh.find((account) => {
      return account.externalId === "202";
    });
    expect(secondBefore).toMatchObject({
      displayName: "Second",
      externalUsername: "github-second",
      isDefault: false,
    });

    await connectGithubAdd(actor, {
      code: "github-second-refresh",
      displayName: "Ignored on refresh",
      userId: 202,
      login: "github-second-updated",
    });

    const afterRefresh = await connectors.listBuiltinConnectorAccounts(
      actor,
      "github",
    );
    expect(afterRefresh).toHaveLength(2);
    expect(
      afterRefresh.find((account) => {
        return account.externalId === "101";
      }),
    ).toMatchObject({
      id: beforeRefresh.find((account) => {
        return account.externalId === "101";
      })?.id,
      displayName: "First",
      externalUsername: "github-first",
      isDefault: true,
    });
    expect(
      afterRefresh.find((account) => {
        return account.externalId === "202";
      }),
    ).toMatchObject({
      id: secondBefore?.id,
      displayName: "Second",
      externalUsername: "github-second-updated",
      isDefault: false,
    });
  });

  it("deduplicates concurrent callbacks and their connector reward", async () => {
    const actor = bdd.user();
    await connectors.updateFeatureSwitches(actor, {});
    mockGitHubConnectorOAuth({ userId: 303, login: "github-concurrent" });

    const [first, second] = await Promise.all([
      connectors.startOauth(actor, "github", "oauth", undefined, {
        intent: "add",
        displayName: "Concurrent first",
      }),
      connectors.startOauth(actor, "github", "oauth", undefined, {
        intent: "add",
        displayName: "Concurrent second",
      }),
    ]);
    await Promise.all([
      connectors.completeOauthCallback("github", {
        code: "github-concurrent-first",
        state: oauthState(first.authorizationUrl),
      }),
      connectors.completeOauthCallback("github", {
        code: "github-concurrent-second",
        state: oauthState(second.authorizationUrl),
      }),
    ]);

    await expect(
      connectors.listBuiltinConnectorAccounts(actor, "github"),
    ).resolves.toMatchObject([
      {
        externalId: "303",
        externalUsername: "github-concurrent",
        isDefault: true,
      },
    ]);
    const firstReward = await readConnectorReward(actor);
    expect(firstReward.status.quests).toContainEqual(
      expect.objectContaining({
        key: "connector",
        claimedCount: 1,
        earnedCredits: 100,
        pendingCount: 0,
      }),
    );
    expect(firstReward.credits.bonusCredits).toBe(100);
    expect(firstReward.credits.creditGrants).toStrictEqual([
      expect.objectContaining({
        grantType: "bonus",
        amount: 100,
        remaining: 100,
      }),
    ]);
    const grant = firstReward.status.recentGrants.find((claim) => {
      return claim.questKey === "connector";
    });
    expect(grant).toMatchObject({
      status: "granted",
      rewardAmount: 100,
      rewardTarget: "user",
      reason: null,
    });
    if (!grant?.grantedAt || !grant.expiresAt) {
      throw new Error("Expected the connector reward's grant and expiry");
    }
    expect(
      new Date(grant.expiresAt).getTime() - new Date(grant.grantedAt).getTime(),
    ).toBe(168 * 60 * 60 * 1000);

    await connectGithubAdd(actor, {
      code: "github-concurrent-refresh",
      displayName: "Existing identity",
      userId: 303,
      login: "github-concurrent-refreshed",
    });
    const refreshed = await readConnectorReward(actor);
    expect(refreshed.status.recentGrants).toStrictEqual(
      firstReward.status.recentGrants,
    );
    expect(refreshed.credits.creditGrants).toStrictEqual(
      firstReward.credits.creditGrants,
    );
    expect(refreshed.credits.bonusCredits).toBe(100);
  });

  it("does not match a provider identity owned by another organization", async () => {
    const firstActor = bdd.user();
    const secondActor = bdd.user();
    await connectors.updateFeatureSwitches(firstActor, {});
    await connectors.updateFeatureSwitches(secondActor, {});

    await connectGithubAdd(firstActor, {
      code: "github-first-owner",
      displayName: "First owner",
      userId: 304,
      login: "github-shared-identity",
    });
    await connectGithubAdd(secondActor, {
      code: "github-second-owner",
      displayName: "Second owner",
      userId: 304,
      login: "github-shared-identity",
    });

    const firstAccounts = await connectors.listBuiltinConnectorAccounts(
      firstActor,
      "github",
    );
    const secondAccounts = await connectors.listBuiltinConnectorAccounts(
      secondActor,
      "github",
    );
    expect(firstAccounts).toMatchObject([
      { externalId: "304", displayName: "First owner", isDefault: true },
    ]);
    expect(secondAccounts).toMatchObject([
      { externalId: "304", displayName: "Second owner", isDefault: true },
    ]);
    expect(firstAccounts[0]?.id).not.toBe(secondAccounts[0]?.id);
  });

  it("uses the same exact-identity selection for GitHub App setup", async () => {
    const actor = bdd.user();
    await connectors.updateFeatureSwitches(actor, {});
    await connectGithubAdd(actor, {
      code: "github-before-setup-first",
      displayName: "Before setup first",
      userId: 501,
      login: "github-before-setup-first",
    });
    await connectGithubAdd(actor, {
      code: "github-before-setup-second",
      displayName: "Before setup second",
      userId: 502,
      login: "github-before-setup-second",
    });
    const beforeRefresh = await connectors.listBuiltinConnectorAccounts(
      actor,
      "github",
    );
    const secondBefore = beforeRefresh.find((account) => {
      return account.externalId === "502";
    });
    const agent = await bdd.createAgent(actor, {
      displayName: `GitHub account setup ${randomUUID()}`,
    });

    await github.installGithubApp(actor, agent.agentId, {
      oauthCode: {
        code: "github-setup-existing",
        githubUserId: "502",
        login: "github-setup-existing-updated",
      },
    });

    const afterRefresh = await connectors.listBuiltinConnectorAccounts(
      actor,
      "github",
    );
    expect(afterRefresh).toHaveLength(2);
    expect(
      afterRefresh.find((account) => {
        return account.externalId === "502";
      }),
    ).toMatchObject({
      id: secondBefore?.id,
      externalUsername: "github-setup-existing-updated",
      isDefault: false,
    });
    await expect(github.readInstallation(actor)).resolves.toMatchObject({
      connectedGithubUserId: "502",
      isConnected: true,
      installation: { status: "active" },
    });

    const siblingActor = bdd.user();
    await connectors.updateFeatureSwitches(siblingActor, {});
    await connectGithubAdd(siblingActor, {
      code: "github-before-setup-sibling",
      displayName: "Existing before setup",
      userId: 601,
      login: "github-before-setup-sibling",
    });
    const siblingAgent = await bdd.createAgent(siblingActor, {
      displayName: `GitHub sibling setup ${randomUUID()}`,
    });
    await github.installGithubApp(siblingActor, siblingAgent.agentId, {
      oauthCode: {
        code: "github-setup-new-sibling",
        githubUserId: "602",
        login: "github-setup-new-sibling",
      },
    });

    const afterSiblingSetup = await connectors.listBuiltinConnectorAccounts(
      siblingActor,
      "github",
    );
    expect(afterSiblingSetup).toHaveLength(2);
    expect(
      afterSiblingSetup.find((account) => {
        return account.externalId === "602";
      }),
    ).toMatchObject({
      externalUsername: "github-setup-new-sibling",
      isDefault: false,
    });
    await expect(github.readInstallation(siblingActor)).resolves.toMatchObject({
      connectedGithubUserId: "602",
      isConnected: true,
      installation: { status: "active" },
    });
  });
});
