import { randomInt, randomUUID } from "node:crypto";

import { HttpResponse, http } from "msw";
import { describe, expect, it } from "vitest";

import { testContext } from "../../../__tests__/test-context";
import { server } from "../../../mocks/server";
import { createBddApi } from "./helpers/api-bdd";
import { mockClerkMembership } from "./helpers/api-bdd-clerk";
import {
  createConnectorBddApi,
  mockGitHubConnectorOAuth,
} from "./helpers/api-bdd-connectors";
import { createGithubBddApi } from "./helpers/api-bdd-github";

const context = testContext();
const bdd = createBddApi(context);
const connectors = createConnectorBddApi(context);
const github = createGithubBddApi(context);

async function givenRemoteInstallActors() {
  const foreign = bdd.user();
  const foreignAgent = await bdd.createAgent(foreign, {
    displayName: `Foreign GitHub installation ${randomUUID()}`,
  });
  const foreignInstallation = await github.installGithubApp(
    foreign,
    foreignAgent.agentId,
  );
  const actor = bdd.user();
  if (!actor.orgId) {
    throw new Error("Expected an organization-scoped remote install actor");
  }
  const agent = await bdd.createAgent(actor, {
    displayName: `Remote GitHub installation ${randomUUID()}`,
  });
  mockClerkMembership(context, actor, "org:admin");
  return {
    actor,
    orgId: actor.orgId,
    agentId: agent.agentId,
    foreign,
    foreignInstallation,
  };
}

function remoteInstallation(id = randomInt(1_000_000_000, 9_999_999_999)) {
  return {
    id,
    app_id: 123_456,
    app_slug: "okou-test",
    account: { id: 501, login: "remote-owner", type: "User" },
  };
}

function mockRemoteInstallations(
  installations: readonly ReturnType<typeof remoteInstallation>[],
) {
  server.use(
    http.get("https://api.github.com/app/installations", () => {
      return HttpResponse.json(installations);
    }),
    http.post(
      "https://api.github.com/app/installations/:installationId/access_tokens",
      () => {
        return HttpResponse.json({
          token: "ghs_remote_installation_token",
          expires_at: "2099-01-01T00:00:00Z",
        });
      },
    ),
  );
}

describe("GitHub remote installation association", () => {
  it("resolves the Agent organization and links an unclaimed remote User installation", async () => {
    const { actor, agentId } = await givenRemoteInstallActors();
    const remote = remoteInstallation();
    mockRemoteInstallations([remote]);

    const response = await github.requestInstall(
      new URLSearchParams({
        userId: actor.userId,
        composeId: agentId,
      }).toString(),
    );

    expect(response.status).toBe(307);
    expect(new URL(response.location ?? "").pathname).toBe("/workflows");
    await expect(github.readInstallation(actor)).resolves.toMatchObject({
      isConnected: true,
      connectedGithubUserId: "501",
      installation: {
        installationId: String(remote.id),
        status: "active",
        targetType: "User",
        targetName: "remote-owner",
        isAdmin: true,
      },
    });
  });

  it("skips a foreign organization and relinks an existing installation to the default connector identity", async () => {
    const { actor, orgId, agentId, foreign, foreignInstallation } =
      await givenRemoteInstallActors();
    mockGitHubConnectorOAuth({ userId: 502, login: "default-github-identity" });
    const oauth = await connectors.startOauth(actor, "github", "oauth");
    const state = new URL(oauth.authorizationUrl).searchParams.get("state");
    if (!state) {
      throw new Error("Expected public connector OAuth state");
    }
    await connectors.completeOauthCallback("github", {
      code: "remote-install-default-identity",
      state,
    });
    const remote = remoteInstallation();
    mockRemoteInstallations([
      {
        ...remoteInstallation(Number(foreignInstallation.remoteInstallationId)),
        account: {
          id: Number(foreignInstallation.targetId),
          login: "bdd-org",
          type: "Organization",
        },
      },
      remote,
    ]);

    const created = await github.requestInstall(
      new URLSearchParams({
        userId: actor.userId,
        orgId,
        composeId: agentId,
      }).toString(),
    );
    expect(created.status).toBe(307);
    expect(new URL(created.location ?? "").pathname).toBe("/workflows");
    await expect(github.readInstallation(actor)).resolves.toMatchObject({
      connectedGithubUserId: "501",
      installation: { installationId: String(remote.id), isAdmin: true },
    });

    mockRemoteInstallations([{ ...remote, app_slug: "updated-remote-app" }]);
    const relinked = await github.requestInstall(
      new URLSearchParams({ userId: actor.userId }).toString(),
    );
    expect(relinked.status).toBe(307);
    expect(new URL(relinked.location ?? "").pathname).toBe("/workflows");
    await expect(github.readInstallation(actor)).resolves.toMatchObject({
      isConnected: true,
      connectedGithubUserId: "502",
      connectedGithubUsername: "default-github-identity",
      installation: { installationId: String(remote.id), isAdmin: true },
    });
    const member = bdd.user({ orgId, orgRole: "org:member" });
    await expect(github.readInstallation(member)).resolves.toMatchObject({
      isConnected: false,
      installation: { installationId: String(remote.id), isAdmin: false },
    });
    await expect(github.readInstallation(foreign)).resolves.toMatchObject({
      isConnected: false,
      connectedGithubUserId: null,
      installation: {
        installationId: foreignInstallation.remoteInstallationId,
        targetType: "Organization",
        targetName: "bdd-org",
      },
    });
  });

  it("leaves an unclaimed installation unassociated when composeId is missing", async () => {
    const { actor, orgId } = await givenRemoteInstallActors();
    mockRemoteInstallations([remoteInstallation()]);

    const response = await github.requestInstall(
      new URLSearchParams({
        userId: actor.userId,
        orgId,
      }).toString(),
    );

    expect(response.status).toBe(307);
    const target = new URL(response.location ?? "");
    expect(target.origin).toBe("https://github.com");
    expect(target.pathname).toBe("/apps/okou-test/installations/new");
    await github.requestReadInstallation(actor, [404]);
  });

  it("keeps the provider install redirect available after discovery fails", async () => {
    const { actor, orgId, agentId } = await givenRemoteInstallActors();
    server.use(
      http.get("https://api.github.com/app/installations", () => {
        return HttpResponse.json({ message: "Unavailable" }, { status: 503 });
      }),
    );

    const response = await github.requestInstall(
      new URLSearchParams({
        userId: actor.userId,
        orgId,
        composeId: agentId,
      }).toString(),
    );

    expect(response.status).toBe(307);
    const target = new URL(response.location ?? "");
    expect(target.origin).toBe("https://github.com");
    expect(target.pathname).toBe("/apps/okou-test/installations/new");
    await github.requestReadInstallation(actor, [404]);
  });
});
