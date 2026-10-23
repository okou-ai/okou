import {
  authenticateCallbackActor,
  callbackAuthenticationModes,
  callbackBrowserHeaders,
  callbackNeedsSignIn,
} from "./helpers/oauth-callback-auth";
import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { githubOauthRoutes } from "../github-oauth";
import { githubOauthContract } from "@okouai/api-contracts/contracts/github-oauth";
import { randomInt, randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";

import { mockEnv } from "../../../lib/env";
import { mockNow, now } from "../../../lib/time";
import { createBddApi, type ApiTestUser } from "./helpers/api-bdd";
import { mockClerkMembership } from "./helpers/api-bdd-clerk";
import { createGithubBddApi } from "./helpers/api-bdd-github";

const context = testContext();
const bdd = createBddApi(context);
const github = createGithubBddApi(context);
const ORIGIN = "https://api.okou.ai";

async function installationActor() {
  const actor = bdd.user();
  const agent = await bdd.createAgent(actor, {
    displayName: `Authorized GitHub install ${randomUUID()}`,
  });
  github.configureApp();
  mockClerkMembership(context, actor, "org:admin");
  return { actor, agentId: agent.agentId };
}

async function start(actor: ApiTestUser, agentId: string) {
  const response = await github.requestInstall(
    new URLSearchParams({
      userId: actor.userId,
      orgId: actor.orgId!,
      composeId: agentId,
    }).toString(),
    { auth: actor, origin: ORIGIN },
  );
  expect(response.status).toBe(307);
  const url = new URL(response.location!);
  expect(url.origin).toBe("https://github.com");
  return url.searchParams.get("state")!;
}

function error(location: string | null) {
  return new URL(location!).searchParams.get("error");
}

describe("GitHub installation authorization", () => {
  beforeEach(() => {
    mockEnv("OKOU_API_BACKEND_URL", ORIGIN);
    mockEnv("OKOU_WEB_URL", "https://www.okou.ai");
    mockEnv("APP_URL", "https://app.okou.ai");
  });
  it("requires sign-in before accepting a named administrator", async () => {
    const { actor, agentId } = await installationActor();
    const response = await github.requestInstall(
      new URLSearchParams({
        userId: actor.userId,
        orgId: actor.orgId!,
        composeId: agentId,
      }).toString(),
      { origin: ORIGIN, auth: null },
    );
    expect(new URL(response.location!).pathname).toBe("/sign-in");
    expect(response.cacheControl).toBe("no-store");
    await github.requestReadInstallation(actor, [404]);
  });

  it("rejects another user's principal even when that user is an administrator", async () => {
    const { actor: victim, agentId } = await installationActor();
    const attacker = bdd.user();
    const response = await github.requestInstall(
      new URLSearchParams({
        userId: victim.userId,
        orgId: victim.orgId!,
        composeId: agentId,
      }).toString(),
      { auth: attacker, origin: ORIGIN },
    );
    expect(error(response.location)).toContain(
      "different account or organization",
    );
    await github.requestReadInstallation(victim, [404]);
    await github.requestReadInstallation(attacker, [404]);
  });

  it("rejects non-admin callers and agents outside the active organization", async () => {
    const { actor, agentId } = await installationActor();
    const member = bdd.user({ orgId: actor.orgId, orgRole: "org:member" });
    const denied = await github.requestInstall(
      new URLSearchParams({ composeId: agentId }).toString(),
      { auth: member, origin: ORIGIN },
    );
    expect(error(denied.location)).toContain("Only organization admins");
    const other = await installationActor();
    const foreignAgent = await github.requestInstall(
      new URLSearchParams({ composeId: other.agentId }).toString(),
      { auth: actor, origin: ORIGIN },
    );
    expect(error(foreignAgent.location)).toContain("does not belong");
  });

  it("checks the user's provider access before associating an installation", async () => {
    const { actor, agentId } = await installationActor();
    const state = await start(actor, agentId);
    github.mockInstallation({
      installationId: "2002",
      targetId: "7007",
      login: "foreign-org",
      type: "Organization",
    });
    github.mockUserAuthorization({
      code: "foreign-installation",
      githubUserId: "701",
      organizationId: "7007",
      organizationRole: "member",
    });
    const response = await github.requestSetupCallback(
      new URLSearchParams({
        state,
        code: "foreign-installation",
        installation_id: "2002",
        setup_action: "install",
      }).toString(),
      { origin: ORIGIN, auth: actor },
    );
    expect(error(response.location)).toContain(
      "active organization administrator",
    );
    await github.requestReadInstallation(actor, [404]);
  });

  it("rejects a callback after the authenticated Okou actor switches", async () => {
    const { actor, agentId } = await installationActor();
    const state = await start(actor, agentId);
    const other = bdd.user({ orgId: actor.orgId });
    const response = await github.requestSetupCallback(
      new URLSearchParams({
        state,
        code: "switched-actor",
        installation_id: "6006",
      }).toString(),
      { origin: ORIGIN, auth: other },
    );
    expect(error(response.location)).toContain(
      "active account or organization changed",
    );
    await github.requestReadInstallation(actor, [404]);
  });

  it("verifies the provider account, persists the installation, and rejects state replay", async () => {
    const { actor, agentId } = await installationActor();
    const installed = await github.installGithubApp(actor, agentId, {
      oauthCode: { code: "authorized-installation", githubUserId: "702" },
    });
    await expect(github.readInstallation(actor)).resolves.toMatchObject({
      isConnected: true,
      connectedGithubUserId: "702",
      installation: { installationId: installed.remoteInstallationId },
    });
    const replay = await github.requestSetupCallback(
      new URLSearchParams({
        state: installed.state,
        code: "authorized-installation",
        installation_id: installed.remoteInstallationId,
      }).toString(),
      { origin: ORIGIN, auth: actor },
    );
    expect(error(replay.location)).toContain("expired or was already used");
    await expect(github.readInstallation(actor)).resolves.toMatchObject({
      connectedGithubUserId: "702",
      installation: { installationId: installed.remoteInstallationId },
    });
  });

  it("accepts a personal installation only for the verified GitHub account owner", async () => {
    const { actor, agentId } = await installationActor();
    const installed = await github.installGithubApp(actor, agentId, {
      targetType: "User",
      oauthCode: { code: "personal-owner", githubUserId: "703" },
    });
    await expect(github.readInstallation(actor)).resolves.toMatchObject({
      connectedGithubUserId: "703",
      installation: {
        installationId: installed.remoteInstallationId,
        targetType: "User",
      },
    });
  });

  it("rejects a personal installation owned by a different GitHub account", async () => {
    const { actor, agentId } = await installationActor();
    const state = await start(actor, agentId);
    github.mockInstallation({
      installationId: "7007",
      targetId: "704",
      type: "User",
    });
    github.mockUserAuthorization({
      code: "other-personal-owner",
      githubUserId: "705",
    });
    const response = await github.requestSetupCallback(
      new URLSearchParams({
        state,
        code: "other-personal-owner",
        installation_id: "7007",
      }).toString(),
      { origin: ORIGIN, auth: actor },
    );
    expect(error(response.location)).toContain("GitHub account owner");
    await github.requestReadInstallation(actor, [404]);
  });

  it("requires user verification when installation returns no authorization code", async () => {
    const { actor, agentId } = await installationActor();
    const state = await start(actor, agentId);
    const pending = await github.requestSetupCallback(
      new URLSearchParams({
        state,
        installation_id: "3003",
        setup_action: "install",
      }).toString(),
      { origin: ORIGIN, auth: actor },
    );
    const authorization = new URL(pending.location!);
    expect(authorization.pathname).toBe("/login/oauth/authorize");
    await github.requestReadInstallation(actor, [404]);
    const continuation = authorization.searchParams.get("state")!;
    const switched = await github.requestSetupCallback(
      new URLSearchParams({
        state: continuation,
        code: "another-installation",
        installation_id: "4004",
      }).toString(),
      { origin: ORIGIN, auth: actor },
    );
    expect(error(switched.location)).toContain(
      "does not match this authorization",
    );
    await github.requestReadInstallation(actor, [404]);
  });

  it("recovers an existing provider installation only after verifying its administrator", async () => {
    const { actor, agentId } = await installationActor();
    const installationId = String(randomInt(1_000_000_000, 9_999_999_999));
    const organizationId = String(randomInt(1_000_000_000, 9_999_999_999));
    const state = await start(actor, agentId);
    const configured = await github.requestSetupCallback(
      new URLSearchParams({
        state,
        installation_id: installationId,
        setup_action: "update",
      }).toString(),
      { origin: ORIGIN, auth: actor },
    );
    const authorization = new URL(configured.location!);
    expect(authorization.pathname).toBe("/login/oauth/authorize");
    await github.requestReadInstallation(actor, [404]);
    github.mockInstallation({
      installationId,
      targetId: organizationId,
      login: "verified-org",
      type: "Organization",
    });
    github.mockUserAuthorization({
      code: "verify-existing-installation",
      githubUserId: "706",
      organizationId,
    });
    const completed = await github.requestSetupCallback(
      new URLSearchParams({
        state: authorization.searchParams.get("state")!,
        code: "verify-existing-installation",
      }).toString(),
      { origin: ORIGIN, auth: actor },
    );
    expect(new URL(completed.location!).pathname).toBe("/workflows");
    await expect(github.readInstallation(actor)).resolves.toMatchObject({
      isConnected: false,
      installation: { installationId, targetName: "verified-org" },
    });
  });

  it("expires an abandoned authorization without creating an installation", async () => {
    const { actor, agentId } = await installationActor();
    const instant = now();
    mockNow(instant);
    const state = await start(actor, agentId);
    mockNow(instant + 15 * 60 * 1000);
    const response = await github.requestSetupCallback(
      new URLSearchParams({
        state,
        code: "late-code",
        installation_id: "5005",
      }).toString(),
      { origin: ORIGIN, auth: actor },
    );
    expect(error(response.location)).toContain("expired or was already used");
    await github.requestReadInstallation(actor, [404]);
  });
  it.each(callbackAuthenticationModes)(
    "requires the GitHub installation completing actor (%s)",
    async (mode) => {
      const { actor, agentId } = await installationActor();
      const state = await start(actor, agentId);
      const installationId = String(randomInt(1_000_000_000, 9_999_999_999));
      github.mockInstallation({
        installationId,
        targetId: "888001",
        type: "User",
        login: "provider-owner",
      });
      github.mockUserAuthorization({
        code: "provider-result",
        githubUserId: "888001",
      });
      const query = {
        state,
        code: "provider-result",
        installation_id: installationId,
      };
      const browser = await github.requestSetupCallback(
        new URLSearchParams(query).toString(),
        { origin: ORIGIN, auth: null },
      );
      expect(new URL(browser.location!).searchParams.get("integration")).toBe(
        "github",
      );
      await github.requestReadInstallation(actor, [404]);
      const client = setupApp({
        context,
        routes: githubOauthRoutes,
        baseUrl: ORIGIN,
      })(githubOauthContract);
      const completion = await accept(
        client.setupCallback({
          query: { ...query, responseMode: "json" },
          extraHeaders: callbackBrowserHeaders(context, mode, actor),
        }),
        [200, 401],
      );
      expect(completion.status).toBe(callbackNeedsSignIn(mode) ? 401 : 200);
      if (completion.status === 200) {
        const target = new URL(completion.body.redirectUrl);
        if (mode === "matching-cookie") {
          expect(target.searchParams.get("error")).toBeNull();
        } else {
          expect(target.searchParams.get("error")).toContain(
            "active account or organization changed",
          );
        }
      }
      if (mode === "matching-cookie") {
        await expect(github.readInstallation(actor)).resolves.toMatchObject({
          isConnected: true,
          connectedGithubUserId: "888001",
          installation: { installationId },
        });
      } else {
        await github.requestReadInstallation(actor, [404]);
      }
      if (callbackNeedsSignIn(mode)) {
        const resumed = await github.requestSetupCallback(
          new URLSearchParams(query).toString(),
          { origin: ORIGIN, auth: actor },
        );
        expect(new URL(resumed.location!).searchParams.get("error")).toBeNull();
        await expect(github.readInstallation(actor)).resolves.toMatchObject({
          isConnected: true,
          connectedGithubUserId: "888001",
          installation: { installationId },
        });
      }
    },
  );
  it.each(["missing", "expired-cookie"] as const)(
    "protects GitHub no-code continuation (%s)",
    async (mode) => {
      const { actor, agentId } = await installationActor();
      const state = await start(actor, agentId);
      const installationId = String(randomInt(1_000_000_000, 9_999_999_999));
      const first = await github.requestSetupCallback(
        new URLSearchParams({
          state,
          installation_id: installationId,
          setup_action: "install",
        }).toString(),
        { origin: ORIGIN, auth: actor },
      );
      const authorization = new URL(first.location!);
      expect(authorization.pathname).toBe("/login/oauth/authorize");
      await github.requestReadInstallation(actor, [404]);
      github.mockInstallation({
        installationId,
        targetId: "888002",
        type: "User",
        login: "provider-owner",
      });
      github.mockUserAuthorization({
        code: "provider-verification",
        githubUserId: "888002",
      });
      const client = setupApp({
        context,
        routes: githubOauthRoutes,
        baseUrl: ORIGIN,
      })(githubOauthContract);
      const query = {
        state: authorization.searchParams.get("state")!,
        code: "provider-verification",
        responseMode: "json" as const,
      };
      await accept(
        client.setupCallback({
          query,
          extraHeaders: callbackBrowserHeaders(context, mode, actor),
        }),
        [401],
      );
      await github.requestReadInstallation(actor, [404]);
      authenticateCallbackActor(context, actor);
      const completed = await accept(
        client.setupCallback({
          query,
          extraHeaders: { authorization: "Bearer clerk-session" },
        }),
        [200],
      );
      expect(
        new URL(completed.body.redirectUrl).searchParams.get("error"),
      ).toBeNull();
      await expect(github.readInstallation(actor)).resolves.toMatchObject({
        isConnected: false,
        installation: { installationId },
      });
    },
  );
  it.each([undefined, "invalid-state"])(
    "keeps GitHub update without valid state read only (%s)",
    async (state) => {
      const { actor } = await installationActor();
      const query = new URLSearchParams({
        setup_action: "update",
        installation_id: "988000",
      });
      if (state) {
        query.set("state", state);
      }
      const result = await github.requestSetupCallback(query.toString(), {
        origin: ORIGIN,
        auth: null,
      });
      expect(new URL(result.location!).pathname).toBe("/workflows");
      await github.requestReadInstallation(actor, [404]);
    },
  );
});
