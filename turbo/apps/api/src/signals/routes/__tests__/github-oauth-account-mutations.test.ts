import { randomUUID } from "node:crypto";

import { describe, expect, it } from "vitest";

import { testContext } from "../../../__tests__/test-context";
import { mockEnv } from "../../../lib/env";
import { installApiTestConnectorCatalog } from "../../../test-fixtures/connector-catalog";
import { createBddApi, type ApiTestUser } from "./helpers/api-bdd";
import {
  createConnectorBddApi,
  mockGitHubConnectorOAuth,
} from "./helpers/api-bdd-connectors";
import { createGithubBddApi } from "./helpers/api-bdd-github";
import { setConnectorExternalIdState } from "./helpers/connector-credential-storage-state";

const context = testContext({ connectorCatalog: true });
const bdd = createBddApi(context);
const connectors = createConnectorBddApi(context);
const github = createGithubBddApi(context);

function requiredOrgId(actor: ApiTestUser): string {
  if (!actor.orgId) {
    throw new Error("Expected an org-scoped actor");
  }
  return actor.orgId;
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
  it("redirects state-less GitHub App updates to the configured Okou app", async () => {
    mockEnv("APP_URL", "https://app.okou.ai");
    mockEnv("OKOU_WEB_URL", "https://www.okou.ai");
    mockEnv("OKOU_API_BACKEND_URL", "https://api.okou.ai");
    await installApiTestConnectorCatalog();

    const actor = bdd.user();
    const agent = await bdd.createAgent(actor, {
      displayName: `Okou GitHub setup ${randomUUID()}`,
    });
    const installation = await github.installGithubApp(actor, agent.agentId);
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
    await installApiTestConnectorCatalog();
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

  it("serializes concurrent callbacks for the same new identity", async () => {
    await installApiTestConnectorCatalog();
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
  });

  it("does not match a provider identity owned by another organization", async () => {
    await installApiTestConnectorCatalog();
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

  it("fails closed when historical rows duplicate an owned identity", async () => {
    await installApiTestConnectorCatalog();
    const actor = bdd.user();
    await connectors.updateFeatureSwitches(actor, {});
    await connectGithubAdd(actor, {
      code: "github-duplicate-first",
      displayName: "Duplicate first",
      userId: 404,
      login: "github-duplicate-first",
    });
    await connectGithubAdd(actor, {
      code: "github-duplicate-second",
      displayName: "Duplicate second",
      userId: 405,
      login: "github-duplicate-second",
    });
    const beforeDuplicate = await connectors.listBuiltinConnectorAccounts(
      actor,
      "github",
    );
    const second = beforeDuplicate.find((account) => {
      return account.externalId === "405";
    });
    if (!second) {
      throw new Error("Expected the second GitHub connector account");
    }
    await setConnectorExternalIdState(context, {
      orgId: requiredOrgId(actor),
      userId: actor.userId,
      connectorId: second.id,
      externalId: "404",
    });

    mockGitHubConnectorOAuth({ userId: 404, login: "must-not-be-written" });
    const start = await connectors.startOauth(
      actor,
      "github",
      "oauth",
      undefined,
      { intent: "add" },
    );
    const callback = await connectors.completeOauthCallback("github", {
      code: "github-duplicate-rejected",
      state: oauthState(start.authorizationUrl),
    });
    const location = new URL(callback.headers.get("location") ?? "");
    expect(location.pathname).toBe("/connector/error");
    expect(location.searchParams.get("message")).toBe(
      "Multiple connector accounts require an exact choice",
    );

    const afterDuplicate = await connectors.listBuiltinConnectorAccounts(
      actor,
      "github",
    );
    expect(afterDuplicate).toHaveLength(2);
    expect(
      afterDuplicate.map((account) => {
        return account.externalUsername;
      }),
    ).toStrictEqual(
      expect.arrayContaining([
        "github-duplicate-first",
        "github-duplicate-second",
      ]),
    );
    expect(afterDuplicate).not.toContainEqual(
      expect.objectContaining({ externalUsername: "must-not-be-written" }),
    );
  });

  it("uses the same exact-identity selection for GitHub App setup", async () => {
    await installApiTestConnectorCatalog();
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
