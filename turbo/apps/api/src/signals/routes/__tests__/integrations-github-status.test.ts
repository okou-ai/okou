import { randomUUID } from "node:crypto";

import { describe, expect, it } from "vitest";

import { testContext } from "../../../__tests__/test-context";
import { mockOptionalEnv } from "../../../lib/env";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { createBddApi } from "./helpers/api-bdd";
import {
  createConnectorBddApi,
  mockGitHubConnectorOAuth,
} from "./helpers/api-bdd-connectors";
import { createGithubBddApi } from "./helpers/api-bdd-github";
import { createWebhookCallbackApi } from "./helpers/api-bdd-webhooks";

const context = testContext();
const bdd = createBddApi(context);
const connectors = createConnectorBddApi(context);
const github = createGithubBddApi(context);
const webhooks = createWebhookCallbackApi(context);

describe("GitHub installation status", () => {
  it("removes only the deleted installation and accepts a replayed webhook", async () => {
    const owner = bdd.user();
    const agent = await bdd.createAgent(owner, {
      displayName: `GitHub deleted installation ${randomUUID()}`,
    });
    const installation = await github.installGithubApp(owner, agent.agentId, {
      oauthCode: {
        code: "github-deleted-installation-owner",
        githubUserId: "901",
        login: "github-deleted-installation-owner",
      },
    });
    const other = bdd.user();
    const otherAgent = await bdd.createAgent(other, {
      displayName: `GitHub retained installation ${randomUUID()}`,
    });
    const otherInstallation = await github.installGithubApp(
      other,
      otherAgent.agentId,
      {
        oauthCode: {
          code: "github-retained-installation-owner",
          githubUserId: "902",
          login: "github-retained-installation-owner",
        },
      },
    );
    webhooks.configureGithubWebhookSecret();

    for (const action of ["created", "suspend", "deleted", "deleted"]) {
      const body = JSON.stringify({
        action,
        installation: {
          id: Number(installation.remoteInstallationId),
          account: {
            id: Number(installation.targetId),
            login: "bdd-org",
            type: "Organization",
          },
        },
      });
      const response = await webhooks.requestGithubWebhook(
        body,
        webhooks.signedGithubWebhookHeaders(body, "installation"),
        [200],
      );
      expect(response.status).toBe(200);
      await flushWaitUntilForTest();

      if (action === "deleted") {
        const missing = await github.requestReadInstallation(owner, [404]);
        expect(missing.body).toMatchObject({ error: { code: "NOT_FOUND" } });
      } else {
        await expect(github.readInstallation(owner)).resolves.toMatchObject({
          installation: { installationId: installation.remoteInstallationId },
          isConnected: true,
        });
      }
      await expect(github.readInstallation(other)).resolves.toMatchObject({
        installation: {
          installationId: otherInstallation.remoteInstallationId,
        },
        isConnected: true,
      });
    }
  });

  it("reads installation and linked profile changes on subsequent requests", async () => {
    mockOptionalEnv("GITHUB_APP_SLUG", "bdd-github-app");
    const actor = bdd.user();
    const agent = await bdd.createAgent(actor, {
      displayName: `GitHub status ${randomUUID()}`,
    });
    const missing = await github.requestReadInstallation(actor, [404]);
    expect(missing.body).toMatchObject({
      error: { code: "NOT_FOUND" },
      installUrl: expect.stringContaining(
        "https://github.com/apps/bdd-github-app/installations/new",
      ),
    });

    const installation = await github.installGithubApp(actor, agent.agentId, {
      oauthCode: {
        code: "github-status-initial",
        githubUserId: "701",
        login: "github-status-before",
      },
    });
    await expect(github.readInstallation(actor)).resolves.toMatchObject({
      installation: {
        installationId: installation.remoteInstallationId,
        status: "active",
        isAdmin: true,
      },
      isConnected: true,
      connectedGithubUserId: "701",
      connectedGithubUsername: "github-status-before",
    });

    mockGitHubConnectorOAuth({ userId: 701, login: "github-status-after" });
    const started = await connectors.startOauth(
      actor,
      "github",
      "oauth",
      undefined,
      { intent: "add" },
    );
    const state = new URL(started.authorizationUrl).searchParams.get("state");
    if (!state) {
      throw new Error("Expected GitHub OAuth state");
    }
    await connectors.completeOauthCallback("github", {
      code: "github-status-refresh",
      state,
    });
    await expect(github.readInstallation(actor)).resolves.toMatchObject({
      installation: {
        installationId: installation.remoteInstallationId,
        status: "active",
      },
      isConnected: true,
      connectedGithubUserId: "701",
      connectedGithubUsername: "github-status-after",
    });
  });

  it("keeps linked account details scoped to the authenticated user and organization", async () => {
    const owner = bdd.user();
    const agent = await bdd.createAgent(owner, {
      displayName: `GitHub member status ${randomUUID()}`,
    });
    const installation = await github.installGithubApp(owner, agent.agentId, {
      oauthCode: {
        code: "github-status-owner",
        githubUserId: "801",
        login: "github-status-owner",
      },
    });
    const orgId = owner.orgId;
    if (!orgId) {
      throw new Error("Expected an organization-scoped GitHub owner");
    }
    const member = bdd.user({ orgId, orgRole: "org:member" });
    await expect(github.readInstallation(member)).resolves.toMatchObject({
      installation: {
        installationId: installation.remoteInstallationId,
        isAdmin: false,
      },
      isConnected: false,
      connectedGithubUserId: null,
      connectedGithubUsername: null,
    });
    await expect(github.readInstallation(owner)).resolves.toMatchObject({
      installation: {
        installationId: installation.remoteInstallationId,
        isAdmin: true,
      },
      isConnected: true,
      connectedGithubUserId: "801",
      connectedGithubUsername: "github-status-owner",
    });

    const outsider = bdd.user();
    const foreign = await github.requestReadInstallation(outsider, [404]);
    expect(foreign.body).toMatchObject({ error: { code: "NOT_FOUND" } });
  });
});
