import { randomUUID } from "node:crypto";

import { chatRemoteAccessContract } from "@okouai/api-contracts/contracts/chat-remote-access";
import { remotesContract } from "@okouai/api-contracts/contracts/remotes";
import { sshConnectionsContract } from "@okouai/api-contracts/contracts/ssh-connections";
import { userPreferencesContract } from "@okouai/api-contracts/contracts/user-preferences";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { describe, expect, it } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { chatRemoteAccessRoutes } from "../chat-remote-access";
import { remotesRoutes } from "../remotes";
import { sshConnectionsRoutes } from "../ssh-connections";
import { userPreferencesRoutes } from "../user-preferences";
import { createBddApi, type ApiTestUser } from "./helpers/api-bdd";
import { createChatFilesBddApi } from "./helpers/api-bdd-chat-files";
import { createComputerUseBddApi } from "./helpers/api-bdd-computer-use";
import { updateFeatureSwitchesForUser } from "./helpers/feature-switches";
import { createFixtureTracker, createRouteMocks } from "./helpers/route-test";
import { useSecretKmsProbe } from "./helpers/secret-kms-probe";
import { inlineSshKey } from "./helpers/ssh-credential";
import { createVncRuntimeApi, vncConnectionBody } from "./helpers/vnc-runtime";

const context = testContext();
const mocks = createRouteMocks(context);
const bdd = createBddApi(context);
const chat = createChatFilesBddApi(context);
const computerUse = createComputerUseBddApi(context);
const vnc = createVncRuntimeApi(context);
const headers = Object.freeze({ authorization: "Bearer clerk-session" });
const trackCleanup = createFixtureTracker<() => Promise<void>>(
  async (cleanup) => {
    await cleanup();
  },
);

function client() {
  return setupApp({ context, routes: remotesRoutes })(remotesContract);
}

function accessClient() {
  return setupApp({ context, routes: chatRemoteAccessRoutes })(
    chatRemoteAccessContract,
  );
}

function sshClient() {
  return setupApp({ context, routes: sshConnectionsRoutes })(
    sshConnectionsContract,
  );
}

function preferencesClient() {
  return setupApp({ context, routes: userPreferencesRoutes })(
    userPreferencesContract,
  );
}

function owner(
  options: { readonly userId?: string; readonly orgId?: string } = {},
) {
  return {
    ...bdd.user(options),
    orgId: options.orgId ?? `org_${randomUUID()}`,
  };
}

function authenticate(actor: ApiTestUser) {
  mocks.clerk.session(actor.userId, actor.orgId, actor.orgRole);
}

async function overview(actor: ApiTestUser) {
  authenticate(actor);
  return await accept(client().overview({ headers }), [200]);
}

async function startHost(actor: ApiTestUser, hostName: string) {
  const host = await computerUse.startComputerUseHost(actor, { hostName });
  await trackCleanup(
    Promise.resolve(async () => {
      await computerUse.stopComputerUseHost(host.connection);
    }),
  );
  return host;
}

async function createSshHost(actor: ApiTestUser, displayName: string) {
  authenticate(actor);
  const id = randomUUID();
  await accept(
    sshClient().create({
      headers,
      body: {
        id,
        displayName,
        host: `${id}.example.com`,
        credential: inlineSshKey("deploy", "private-key", null),
      },
    }),
    [201],
  );
  return id;
}

describe("GET /api/remotes/overview", () => {
  it("requires an authenticated session with an organization", async () => {
    context.mocks.clerk.authenticateRequest.mockResolvedValue({
      isAuthenticated: false,
    });
    const unauthenticated = await accept(
      client().overview({ headers: {} }),
      [401],
    );
    expect(unauthenticated.body.error.code).toBe("UNAUTHORIZED");

    mocks.clerk.session(`user_${randomUUID()}`, null);
    const withoutOrg = await accept(client().overview({ headers }), [401]);
    expect(withoutOrg.body.error.code).toBe("UNAUTHORIZED");
  });

  it("returns defaults for an uninitialized member without requiring memory or preference initialization", async () => {
    const result = await overview(owner());
    expect(result.headers.get("cache-control")).toBe("no-store");
    expect(result.body).toStrictEqual({
      computerUseHosts: [],
      cloudBrowserAvailable: false,
      cloudBrowserEnabledByDefault: true,
      sshHosts: [],
      vncHosts: [],
    });
  });

  it("keeps member browser defaults distinct from thread Computer Use and browser selections", async () => {
    const actor = owner();
    bdd.acceptAgentStorageWrites();
    const agentId = await bdd.bootstrapLimitedFreeOnboarding(actor, {
      displayName: "Remote overview member",
    });
    const thread = await chat.createThread(actor, { agentId });
    const host = await startHost(actor, "Selected Desktop");
    await chat.updateThreadComputerUseHost(actor, thread.id, host.hostId);

    const selected = await overview(actor);
    expect(selected.body.cloudBrowserEnabledByDefault).toBeTruthy();
    expect(selected.body.cloudBrowserAvailable).toBeTruthy();
    expect(selected.body.computerUseHosts).toContainEqual({
      id: host.hostId,
      hostName: "Selected Desktop",
      displayName: "Selected Desktop",
      lastSeenAt: expect.any(String),
      status: "online",
    });

    authenticate(actor);
    await accept(
      preferencesClient().update({
        headers,
        body: { cloudBrowserEnabledByDefault: false },
      }),
      [200],
    );
    await chat.updateThreadComputerUseHost(actor, thread.id, null, {
      cloudBrowserEnabled: true,
    });
    const browserSelected = await overview(actor);
    expect(browserSelected.body.cloudBrowserEnabledByDefault).toBeFalsy();
    expect(browserSelected.body.cloudBrowserAvailable).toBeTruthy();
    expect(browserSelected.body.computerUseHosts).toStrictEqual(
      selected.body.computerUseHosts,
    );
  });

  it("projects only the current member's Desktop hosts across users and organizations", async () => {
    const actor = owner();
    const host = await startHost(actor, "Owned Desktop");
    await startHost(owner({ orgId: actor.orgId }), "Peer Desktop");
    await startHost(owner({ userId: actor.userId }), "Other org Desktop");

    const result = await overview(actor);
    expect(result.body.computerUseHosts).toStrictEqual([
      {
        id: host.hostId,
        hostName: "Owned Desktop",
        displayName: "Owned Desktop",
        lastSeenAt: expect.any(String),
        status: "online",
      },
    ]);
  });

  it("returns independent SSH and VNC host defaults, not thread overrides or credentials", async () => {
    useSecretKmsProbe();
    const actor = owner();
    bdd.acceptAgentStorageWrites();
    const agent = await bdd.createAgent(actor, { visibility: "private" });
    const thread = await chat.createThread(actor, { agentId: agent.agentId });
    const sshId = await createSshHost(actor, "SSH server");
    await updateFeatureSwitchesForUser(context, actor, {
      [FeatureSwitchKey.VncAccess]: true,
    });
    vnc.authenticate(actor);
    const vncHost = await accept(
      vnc.connections().create({ headers, body: vncConnectionBody() }),
      [201],
    );
    const vncId = vncHost.body.id;
    await vnc.enableDefault(actor, "ssh", sshId);
    await vnc.enableDefault(actor, "vnc", vncId);
    for (const [protocol, connectionId] of [
      ["ssh", sshId],
      ["vnc", vncId],
    ] as const) {
      vnc.authenticate(actor);
      await accept(
        accessClient().setThreadOverride({
          headers,
          params: { threadId: thread.id, protocol, connectionId },
          body: { enabled: false },
        }),
        [200],
      );
    }

    vnc.authenticate(actor);
    const result = await overview(actor);
    expect(result.body.sshHosts).toStrictEqual([
      { connectionId: sshId, displayName: "SSH server", defaultEnabled: true },
    ]);
    expect(result.body.vncHosts).toStrictEqual([
      { connectionId: vncId, displayName: "VNC desktop", defaultEnabled: true },
    ]);
    expect(result.body.cloudBrowserEnabledByDefault).toBeTruthy();

    const peer = owner({ orgId: actor.orgId });
    vnc.authenticate(peer);
    await updateFeatureSwitchesForUser(context, peer, {
      [FeatureSwitchKey.VncAccess]: true,
    });
    const peerResult = await overview(peer);
    expect(peerResult.body.sshHosts).toStrictEqual([]);
    expect(peerResult.body.vncHosts).toStrictEqual([]);
    const otherOrg = owner({ userId: actor.userId });
    const otherOrgResult = await overview(otherOrg);
    expect(otherOrgResult.body.sshHosts).toStrictEqual([]);
    expect(otherOrgResult.body.vncHosts).toStrictEqual([]);

    await updateFeatureSwitchesForUser(context, actor, {
      [FeatureSwitchKey.VncAccess]: false,
    });
    vnc.authenticate(actor);
    const disabled = await overview(actor);
    expect(disabled.body.vncHosts).toStrictEqual([]);
    expect(disabled.body.sshHosts).toStrictEqual(result.body.sshHosts);

    await updateFeatureSwitchesForUser(context, actor, {
      [FeatureSwitchKey.VncAccess]: true,
    });
    context.mocks.clerk.organizations.getOrganizationMembershipList.mockResolvedValue(
      {
        data: [],
        totalCount: 0,
      },
    );
    const departed = await overview(actor);
    expect(departed.body.vncHosts).toStrictEqual([]);
    expect(departed.body.sshHosts).toStrictEqual(result.body.sshHosts);
  });
});
