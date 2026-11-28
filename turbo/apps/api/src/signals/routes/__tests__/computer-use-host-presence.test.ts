import { randomUUID } from "node:crypto";

import { computerUseSessionHostsContract } from "@okouai/api-contracts/contracts/computer-use";
import { expect, test } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { mockNow, now } from "../../../lib/time";
import { computerUseRoutes } from "../computer-use";
import { createBddApi, type ApiTestUser } from "./helpers/api-bdd";
import { createComputerUseBddApi } from "./helpers/api-bdd-computer-use";

const context = testContext();
const computerUse = createComputerUseBddApi(context);
const sessionHeaders = Object.freeze({ authorization: "Bearer clerk-session" });

interface PresenceHost {
  readonly actor: ApiTestUser;
  readonly hostId: string;
  readonly connectionGeneration: number;
  readonly installationId: string;
}

function sessionHosts() {
  return setupApp({ context, routes: computerUseRoutes })(
    computerUseSessionHostsContract,
  );
}

function desktopSession(actor: ApiTestUser, status = "active") {
  const sessionId = `sess_${actor.userId}`;
  context.mocks.clerk.authenticateRequest.mockResolvedValue({
    isAuthenticated: true,
    toAuth: () => {
      return { ...actor, sessionId };
    },
  });
  context.mocks.clerk.sessions.getSession.mockResolvedValue({
    id: sessionId,
    userId: actor.userId,
    status,
  });
  context.mocks.clerk.organizations.getOrganizationMembershipList.mockResolvedValue(
    {
      data: [
        {
          organization: { id: actor.orgId ?? "" },
          publicUserData: { userId: actor.userId },
          role: actor.orgRole ?? "org:admin",
        },
      ],
      totalCount: 1,
    },
  );
}

function runtimeBody(
  hostName = "BDD Desktop",
  supportedCapabilities = ["apps.list", "app.state"],
) {
  return {
    hostName,
    appVersion: "0.52.1",
    osVersion: "macOS 15",
    supportedCapabilities,
    permissions: { accessibility: true, screenRecording: true },
  };
}

function setPresence(present: boolean | ((channelName: string) => boolean)) {
  context.mocks.ably.presenceGet.mockImplementation((channelName: unknown) => {
    const isPresent =
      typeof present === "function"
        ? typeof channelName === "string" && present(channelName)
        : present;
    return Promise.resolve({
      items: isPresent ? [{ clientId: "desktop" }] : [],
    });
  });
}

interface TokenRequestParams {
  readonly capability: Record<string, readonly string[]>;
  readonly ttl: number;
  readonly clientId: string;
}

function isTokenRequestParams(value: unknown): value is TokenRequestParams {
  return (
    typeof value === "object" &&
    value !== null &&
    "capability" in value &&
    "ttl" in value &&
    "clientId" in value
  );
}

function issueAblyTokenRequests(): TokenRequestParams[] {
  const requested: TokenRequestParams[] = [];
  context.mocks.ably.createTokenRequest.mockImplementation(
    (params: unknown) => {
      if (!isTokenRequestParams(params)) {
        throw new Error("Unexpected Ably token request parameters");
      }
      requested.push(params);
      return Promise.resolve({
        keyName: "app.key",
        ttl: params.ttl,
        timestamp: now(),
        capability: JSON.stringify(params.capability),
        clientId: params.clientId,
        nonce: randomUUID(),
        mac: randomUUID(),
      });
    },
  );
  return requested;
}

async function registerPresenceHost(
  actor: ApiTestUser,
  options: { installationId?: string; presenceOnly?: true } = {},
): Promise<PresenceHost> {
  desktopSession(actor);
  const installationId = options.installationId ?? randomUUID();
  const response = await accept(
    sessionHosts().register({
      headers: sessionHeaders,
      body: {
        ...runtimeBody(),
        installationId,
        livenessMode: "presence",
        ...(options.presenceOnly ? { presenceOnly: true } : {}),
      },
    }),
    [200],
  );
  return {
    actor,
    hostId: response.body.hostId,
    connectionGeneration: response.body.connectionGeneration,
    installationId,
  };
}

async function presentAdminHost(
  options: { presenceOnly?: true } = {},
): Promise<PresenceHost> {
  const bdd = createBddApi(context);
  const admin = bdd.user();
  await bdd.provisionWorkspace(admin);
  setPresence(true);
  return await registerPresenceHost(admin, options);
}

async function listedHost(host: PresenceHost) {
  const listing = await computerUse.listComputerUseHosts(host.actor);
  const listed = listing.hosts.find((candidate) => {
    return candidate.id === host.hostId;
  });
  if (!listed) {
    throw new Error("Expected the Desktop host in the listing");
  }
  return listed;
}

async function requestAppsList(
  host: PresenceHost,
  statuses: readonly (200 | 409)[],
) {
  return await computerUse.requestCreateComputerUseReadCommand(
    host.actor,
    { kind: "apps.list" },
    statuses,
  );
}

function hostPath(host: PresenceHost) {
  desktopSession(host.actor);
  return {
    headers: sessionHeaders,
    params: { hostId: host.hostId },
    body: { connectionGeneration: host.connectionGeneration },
  };
}

test("computer-use-host-presence-004 recovers queued work through the HTTP wait when realtime publishing fails", async () => {
  const host = await presentAdminHost();
  context.mocks.ably.publish.mockRejectedValue(new Error("Ably unavailable"));
  context.mocks.ably.batchPublish.mockRejectedValue(
    new Error("Ably unavailable"),
  );

  const created = await requestAppsList(host, [200]);
  if (created.status !== 200) {
    throw new Error("Expected the command to be created");
  }
  const waited = await accept(sessionHosts().wait(hostPath(host)), [200]);
  expect(waited.body).toStrictEqual({ hasPendingCommands: true });
  const claimed = await computerUse.claimNextComputerUseCommand(host);
  expect(claimed).toMatchObject({
    status: "command",
    command: { id: created.body.commandId },
  });
});

test("computer-use-host-presence-001 keeps an idle present host online and follows presence leave", async () => {
  const host = await presentAdminHost();
  mockNow(now() + 120_000);

  await expect(listedHost(host)).resolves.toMatchObject({ status: "online" });
  await requestAppsList(host, [200]);

  setPresence(false);
  await expect(listedHost(host)).resolves.toMatchObject({
    status: "offline",
  });
  await requestAppsList(host, [409]);
});

test("computer-use-host-presence-008 syncs changed capabilities and keeps stop authoritative over presence", async () => {
  const host = await presentAdminHost();

  await accept(
    sessionHosts().state({
      ...hostPath(host),
      body: {
        ...runtimeBody("Updated Mac", ["app.state"]),
        connectionGeneration: host.connectionGeneration,
      },
    }),
    [200],
  );
  await expect(listedHost(host)).resolves.toMatchObject({
    displayName: "Updated Mac",
    supportedCapabilities: ["app.state"],
  });

  await accept(sessionHosts().stop(hostPath(host)), [200]);
  await expect(listedHost(host)).resolves.toMatchObject({
    status: "offline",
  });
  await accept(sessionHosts().realtimeToken(hostPath(host)), [409]);
});

test("computer-use-host-presence-006 removes a revoked host session despite retained presence", async () => {
  const host = await presentAdminHost();
  mockNow(now() + 31_000);
  context.mocks.clerk.sessions.getSession.mockResolvedValue({
    id: `sess_${host.actor.userId}`,
    userId: host.actor.userId,
    status: "revoked",
  });

  await expect(listedHost(host)).resolves.toMatchObject({
    status: "offline",
  });
  context.mocks.clerk.authenticateRequest.mockResolvedValue({
    isAuthenticated: true,
    toAuth: () => {
      return { ...host.actor, sessionId: `sess_${host.actor.userId}` };
    },
  });
  await accept(
    sessionHosts().next({
      headers: sessionHeaders,
      params: { hostId: host.hostId },
      body: {
        connectionGeneration: host.connectionGeneration,
        supportedCapabilities: ["apps.list", "app.state"],
      },
    }),
    [409],
  );
});

test("computer-use-host-presence-002 issues current-generation realtime capabilities and rejects a replaced connection", async () => {
  const host = await presentAdminHost();
  const requested = issueAblyTokenRequests();

  const token = await accept(
    sessionHosts().realtimeToken(hostPath(host)),
    [200],
  );
  expect(requested).toHaveLength(1);
  const params = requested[0];
  if (!params) {
    throw new Error("Expected one Ably token request");
  }
  const channels = Object.keys(params.capability);
  expect(channels).toHaveLength(1);
  const hostChannel = channels[0] ?? "";
  expect(hostChannel).toContain(host.hostId);
  expect(params).toStrictEqual({
    capability: { [hostChannel]: ["subscribe", "presence"] },
    ttl: 60 * 60 * 1000,
    clientId: host.actor.userId,
  });
  expect(token.body).toMatchObject({
    capability: JSON.stringify(params.capability),
    clientId: host.actor.userId,
  });
  setPresence((channelName) => {
    return channelName === hostChannel;
  });

  await registerPresenceHost(host.actor, {
    installationId: host.installationId,
  });
  await accept(sessionHosts().realtimeToken(hostPath(host)), [409]);

  mockNow(now() + 120_000);
  await expect(listedHost(host)).resolves.toMatchObject({
    status: "offline",
  });
});

test("computer-use-host-presence-011 expires an unclaimed command and still admits a fresh one", async () => {
  const host = await presentAdminHost({ presenceOnly: true });
  const expiring = await computerUse.createComputerUseReadCommand(host.actor, {
    kind: "apps.list",
    timeoutMs: 1000,
  });

  mockNow(now() + 1001);
  await expect(
    computerUse.claimNextComputerUseCommand(host),
  ).resolves.toStrictEqual({ status: "idle" });
  await expect(
    computerUse.readComputerUseCommand(host.actor, expiring.commandId),
  ).resolves.toMatchObject({
    status: "failed",
    error: { code: "timeout" },
  });

  const fresh = await computerUse.createComputerUseReadCommand(host.actor, {
    kind: "apps.list",
  });
  const claimed = await computerUse.claimNextComputerUseCommand(host);
  expect(claimed).toMatchObject({
    status: "command",
    command: { id: fresh.commandId },
  });
  await computerUse.completeComputerUseCommand(host, fresh.commandId);
});
