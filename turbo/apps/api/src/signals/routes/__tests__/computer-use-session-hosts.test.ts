import { randomUUID } from "node:crypto";

import {
  computerUseCommandContract,
  computerUseSessionHostsContract,
} from "@okouai/api-contracts/contracts/computer-use";
import { remoteDevicesContract } from "@okouai/api-contracts/contracts/remote-devices";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { describe, expect, it } from "vitest";

import {
  accept,
  desktopCompatibility,
  testContext,
} from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { mockNow, nowDate } from "../../../lib/time";
import { computerUseRoutes } from "../computer-use";
import { remoteDevicesRoutes } from "../remote-devices";
import { createBddApi, type ApiTestUser } from "./helpers/api-bdd";
import { createComputerUseBddApi } from "./helpers/api-bdd-computer-use";
import { updateFeatureSwitchesForUser } from "./helpers/feature-switches";

const context = testContext();
const sessionHeaders = Object.freeze({ authorization: "Bearer clerk-session" });

function sessionHosts() {
  return setupApp({ context, routes: computerUseRoutes })(
    computerUseSessionHostsContract,
  );
}

function runtimeBody(
  options: {
    readonly installationId?: string;
    readonly appVersion?: string;
    readonly supportedCapabilities?: readonly string[];
  } = {},
) {
  return {
    installationId: options.installationId ?? randomUUID(),
    hostName: "Session Desktop",
    appVersion: options.appVersion ?? "0.54.0",
    osVersion: "macOS 15",
    supportedCapabilities: [
      ...(options.supportedCapabilities ?? ["apps.list", "app.state"]),
    ],
    permissions: { accessibility: true, screenRecording: true },
  };
}

function setAuthToken(actor: ApiTestUser, sessionId: string | undefined): void {
  context.mocks.clerk.authenticateRequest.mockResolvedValue({
    isAuthenticated: true,
    toAuth: () => {
      return sessionId === undefined ? { ...actor } : { ...actor, sessionId };
    },
  });
}

function setProviderAuthority(
  actor: ApiTestUser,
  sessionId: string,
  options: {
    readonly sessionStatus?: "active" | "revoked";
    readonly hasMembership?: boolean;
  } = {},
): void {
  const sessionStatus = options.sessionStatus ?? "active";
  const hasMembership = options.hasMembership ?? true;
  context.mocks.clerk.sessions.getSession.mockResolvedValue({
    id: sessionId,
    userId: actor.userId,
    status: sessionStatus,
  });
  context.mocks.clerk.organizations.getOrganizationMembershipList.mockResolvedValue(
    hasMembership
      ? {
          data: [
            {
              organization: { id: actor.orgId ?? "" },
              publicUserData: { userId: actor.userId },
              role: actor.orgRole ?? "org:admin",
            },
          ],
          totalCount: 1,
        }
      : { data: [], totalCount: 0 },
  );
}

function signInDesktop(
  actor: ApiTestUser,
  sessionId = `sess_${actor.userId}`,
  options: {
    readonly sessionStatus?: "active" | "revoked";
    readonly hasMembership?: boolean;
  } = {},
): string {
  setAuthToken(actor, sessionId);
  setProviderAuthority(actor, sessionId, options);
  return sessionId;
}

async function registerAndClaimAppsList(
  admin: ApiTestUser,
  options: {
    readonly appVersion?: string;
    readonly installationId?: string;
    readonly timeoutMs?: number;
  } = {},
) {
  const api = createComputerUseBddApi(context);
  const installationId = options.installationId ?? randomUUID();
  const sessionId = signInDesktop(admin);
  const registered = await accept(
    sessionHosts().register({
      headers: sessionHeaders,
      body: runtimeBody({
        installationId,
        appVersion: options.appVersion,
      }),
    }),
    [200],
  );
  const created = await api.createComputerUseReadCommand(admin, {
    kind: "apps.list",
    ...(options.timeoutMs !== undefined
      ? { timeoutMs: options.timeoutMs }
      : {}),
  });
  setAuthToken(admin, sessionId);
  const claimed = await accept(
    sessionHosts().next({
      headers: sessionHeaders,
      params: { hostId: registered.body.hostId },
      body: {
        connectionGeneration: registered.body.connectionGeneration,
        supportedCapabilities: ["apps.list", "app.state"],
      },
    }),
    [200],
  );
  expect(claimed.body).toMatchObject({
    status: "command",
    command: { id: created.commandId },
  });
  return {
    api,
    sessionId,
    installationId,
    hostId: registered.body.hostId,
    connectionGeneration: registered.body.connectionGeneration,
    commandId: created.commandId,
  };
}

async function readListedHost(
  api: ReturnType<typeof createComputerUseBddApi>,
  actor: ApiTestUser,
  hostId: string,
) {
  const listing = await api.listComputerUseHosts(actor);
  const found = listing.hosts.find((host) => {
    return host.id === hostId;
  });
  if (!found) {
    throw new Error("Expected Desktop host in host directory");
  }
  return found;
}

describe("Native Computer Use session authentication", () => {
  it("computer-use-session-hosts-018 denies a missing session and an inactive provider session at registration", async () => {
    const admin = createBddApi(context).user({ orgRole: "org:admin" });
    setAuthToken(admin, undefined);

    const missingSession = await accept(
      sessionHosts().register({
        headers: sessionHeaders,
        body: runtimeBody(),
      }),
      [401],
    );

    expect(missingSession.body.error.code).toBe("UNAUTHORIZED");

    signInDesktop(admin, `sess_${admin.userId}`, {
      sessionStatus: "revoked",
    });

    const inactiveSession = await accept(
      sessionHosts().register({
        headers: sessionHeaders,
        body: runtimeBody(),
      }),
      [401],
    );

    expect(inactiveSession.body.error.code).toBe("UNAUTHORIZED");
  });

  it("computer-use-session-hosts-001 enforces the supported Native version at registration", async () => {
    const admin = createBddApi(context).user({ orgRole: "org:admin" });
    desktopCompatibility.minimumSupportedVersion = "0.54.0";
    signInDesktop(admin);

    const rejected = await accept(
      sessionHosts().register({
        headers: sessionHeaders,
        body: runtimeBody({ appVersion: "0.53.4" }),
      }),
      [426],
    );

    expect(rejected.body).toMatchObject({
      error: { code: "DESKTOP_UPDATE_REQUIRED" },
      minimumSupportedVersion: "0.54.0",
    });

    const accepted = await accept(
      sessionHosts().register({
        headers: sessionHeaders,
        body: runtimeBody({ appVersion: "0.54.0" }),
      }),
      [200],
    );

    expect(accepted.body.connectionGeneration).toBe(1);
  });

  it("computer-use-session-hosts-002 closes admission for existing old hosts but lets their claimed command finish and stop", async () => {
    const admin = createBddApi(context).user({ orgRole: "org:admin" });
    const setup = await registerAndClaimAppsList(admin, {
      appVersion: "0.53.4",
    });
    desktopCompatibility.minimumSupportedVersion = "0.54.0";

    setAuthToken(admin, setup.sessionId);
    const poll = await accept(
      sessionHosts().next({
        headers: sessionHeaders,
        extraHeaders: { "x-client-version": "99.0.0" },
        params: { hostId: setup.hostId },
        body: {
          connectionGeneration: setup.connectionGeneration,
          supportedCapabilities: ["apps.list"],
        },
      }),
      [426],
    );
    expect(poll.body.error.code).toBe("DESKTOP_UPDATE_REQUIRED");

    const listed = await readListedHost(setup.api, admin, setup.hostId);
    expect(listed.status).toBe("offline");

    const blockedCreate = await setup.api.requestCreateComputerUseReadCommand(
      admin,
      { kind: "apps.list" },
      [409],
    );
    expect(blockedCreate.status).toBe(409);

    setAuthToken(admin, setup.sessionId);
    const heartbeat = await accept(
      sessionHosts().heartbeat({
        headers: sessionHeaders,
        params: { hostId: setup.hostId },
        body: {
          ...runtimeBody({ appVersion: "0.53.4" }),
          connectionGeneration: setup.connectionGeneration,
        },
      }),
      [200],
    );
    expect(heartbeat.body.ok).toBeTruthy();

    const completed = await accept(
      sessionHosts().complete({
        headers: sessionHeaders,
        params: { hostId: setup.hostId, commandId: setup.commandId },
        body: {
          connectionGeneration: setup.connectionGeneration,
          status: "succeeded",
          result: { apps: [] },
        },
      }),
      [200],
    );
    expect(completed.body).toStrictEqual({ ok: true });

    const command = await setup.api.readComputerUseCommand(
      admin,
      setup.commandId,
    );
    expect(command).toMatchObject({
      status: "succeeded",
      result: { apps: [] },
    });

    setAuthToken(admin, setup.sessionId);
    const stopped = await accept(
      sessionHosts().stop({
        headers: sessionHeaders,
        params: { hostId: setup.hostId },
        body: { connectionGeneration: setup.connectionGeneration },
      }),
      [200],
    );
    expect(stopped.body).toStrictEqual({ ok: true, hostId: setup.hostId });
  });

  it("computer-use-session-hosts-003 preserves the GUI claim lifecycle for a supported Desktop", async () => {
    const admin = createBddApi(context).user({ orgRole: "org:admin" });
    const api = createComputerUseBddApi(context);
    desktopCompatibility.minimumSupportedVersion = "0.54.0";
    const sessionId = signInDesktop(admin);
    const desktopHeaders = { "x-client-type": "Desktop" };

    const registered = await accept(
      sessionHosts().register({
        headers: sessionHeaders,
        extraHeaders: desktopHeaders,
        body: runtimeBody({ appVersion: "0.54.0" }),
      }),
      [200],
    );

    expect(registered.body).toStrictEqual({
      hostId: registered.body.hostId,
      connectionGeneration: 1,
      commandNotifications: {
        channelName: `computer-use-host:${admin.userId}:${admin.orgId ?? ""}:${registered.body.hostId}:1`,
        eventName: "commandsChanged",
      },
    });

    await accept(
      sessionHosts().heartbeat({
        headers: sessionHeaders,
        extraHeaders: desktopHeaders,
        params: { hostId: registered.body.hostId },
        body: {
          ...runtimeBody({ appVersion: "0.54.0" }),
          connectionGeneration: 1,
        },
      }),
      [200],
    );

    const created = await api.createComputerUseReadCommand(admin, {
      kind: "apps.list",
    });

    setAuthToken(admin, sessionId);
    const claimed = await accept(
      sessionHosts().next({
        headers: sessionHeaders,
        extraHeaders: desktopHeaders,
        params: { hostId: registered.body.hostId },
        body: {
          connectionGeneration: 1,
          supportedCapabilities: ["apps.list"],
        },
      }),
      [200],
    );
    expect(claimed.body).toMatchObject({
      status: "command",
      command: { id: created.commandId },
    });

    await accept(
      sessionHosts().complete({
        headers: sessionHeaders,
        extraHeaders: desktopHeaders,
        params: {
          hostId: registered.body.hostId,
          commandId: created.commandId,
        },
        body: {
          connectionGeneration: 1,
          status: "succeeded",
          result: { apps: [] },
        },
      }),
      [200],
    );

    const command = await api.readComputerUseCommand(admin, created.commandId);
    expect(command).toMatchObject({
      status: "succeeded",
      result: { apps: [] },
    });

    setAuthToken(admin, sessionId);
    await accept(
      sessionHosts().stop({
        headers: sessionHeaders,
        extraHeaders: desktopHeaders,
        params: { hostId: registered.body.hostId },
        body: { connectionGeneration: 1 },
      }),
      [200],
    );

    await accept(
      sessionHosts().heartbeat({
        headers: sessionHeaders,
        extraHeaders: desktopHeaders,
        params: { hostId: registered.body.hostId },
        body: {
          ...runtimeBody({ appVersion: "0.54.0" }),
          connectionGeneration: 1,
        },
      }),
      [409],
    );

    const listed = await readListedHost(api, admin, registered.body.hostId);
    expect(listed.status).toBe("offline");
  });

  it("computer-use-session-hosts-004 refreshes liveness for succeeded completion at 29999 ms and preserves the result through retries", async () => {
    const start = Date.parse("2026-02-01T12:00:00.000Z");
    mockNow(start);
    const registeredAt = nowDate().toISOString();
    const admin = createBddApi(context).user({ orgRole: "org:admin" });
    const setup = await registerAndClaimAppsList(admin, { timeoutMs: 60_000 });

    mockNow(start + 29_999);
    const completedAt = nowDate().toISOString();
    setAuthToken(admin, setup.sessionId);
    const firstComplete = await accept(
      sessionHosts().complete({
        headers: sessionHeaders,
        params: { hostId: setup.hostId, commandId: setup.commandId },
        body: {
          connectionGeneration: setup.connectionGeneration,
          status: "succeeded",
          result: { apps: [] },
        },
      }),
      [200],
    );
    expect(firstComplete.body).toStrictEqual({ ok: true });

    const hostAt29999 = await readListedHost(setup.api, admin, setup.hostId);
    const commandAt29999 = await setup.api.readComputerUseCommand(
      admin,
      setup.commandId,
    );
    expect(hostAt29999).toMatchObject({
      status: "online",
      lastSeenAt: registeredAt,
    });
    expect(commandAt29999).toMatchObject({
      status: "succeeded",
      completedAt,
      result: { apps: [] },
    });

    mockNow(start + 30_000);
    const at30000 = nowDate().toISOString();
    setAuthToken(admin, setup.sessionId);
    const retry1 = await accept(
      sessionHosts().complete({
        headers: sessionHeaders,
        params: { hostId: setup.hostId, commandId: setup.commandId },
        body: {
          connectionGeneration: setup.connectionGeneration,
          status: "failed",
          error: { code: "app_not_found", message: "Finder missing" },
        },
      }),
      [200],
    );
    expect(retry1.body).toStrictEqual({ ok: true });
    await expect(
      readListedHost(setup.api, admin, setup.hostId),
    ).resolves.toMatchObject({ lastSeenAt: at30000 });
    await expect(
      setup.api.readComputerUseCommand(admin, setup.commandId),
    ).resolves.toStrictEqual(commandAt29999);

    mockNow(start + 59_999);
    setAuthToken(admin, setup.sessionId);
    const retry2 = await accept(
      sessionHosts().complete({
        headers: sessionHeaders,
        params: { hostId: setup.hostId, commandId: setup.commandId },
        body: {
          connectionGeneration: setup.connectionGeneration,
          status: "failed",
          error: { code: "app_not_found", message: "Finder missing" },
        },
      }),
      [200],
    );
    expect(retry2.body).toStrictEqual({ ok: true });
    await expect(
      readListedHost(setup.api, admin, setup.hostId),
    ).resolves.toMatchObject({ lastSeenAt: at30000 });
    await expect(
      setup.api.readComputerUseCommand(admin, setup.commandId),
    ).resolves.toStrictEqual(commandAt29999);

    mockNow(start + 60_000);
    const at60000 = nowDate().toISOString();
    setAuthToken(admin, setup.sessionId);
    const retry3 = await accept(
      sessionHosts().complete({
        headers: sessionHeaders,
        params: { hostId: setup.hostId, commandId: setup.commandId },
        body: {
          connectionGeneration: setup.connectionGeneration,
          status: "failed",
          error: { code: "app_not_found", message: "Finder missing" },
        },
      }),
      [200],
    );
    expect(retry3.body).toStrictEqual({ ok: true });
    await expect(
      readListedHost(setup.api, admin, setup.hostId),
    ).resolves.toMatchObject({ lastSeenAt: at60000 });
    await expect(
      setup.api.readComputerUseCommand(admin, setup.commandId),
    ).resolves.toStrictEqual(commandAt29999);
  });

  it("computer-use-session-hosts-006 refreshes liveness for failed completion at 29999 ms and preserves the result through retries", async () => {
    const start = Date.parse("2026-02-01T12:00:00.000Z");
    mockNow(start);
    const registeredAt = nowDate().toISOString();
    const admin = createBddApi(context).user({ orgRole: "org:admin" });
    const setup = await registerAndClaimAppsList(admin, { timeoutMs: 60_000 });

    mockNow(start + 29_999);
    const completedAt = nowDate().toISOString();
    setAuthToken(admin, setup.sessionId);
    const firstComplete = await accept(
      sessionHosts().complete({
        headers: sessionHeaders,
        params: { hostId: setup.hostId, commandId: setup.commandId },
        body: {
          connectionGeneration: setup.connectionGeneration,
          status: "failed",
          error: { code: "app_not_found", message: "App missing" },
        },
      }),
      [200],
    );
    expect(firstComplete.body).toStrictEqual({ ok: true });

    const hostAt29999 = await readListedHost(setup.api, admin, setup.hostId);
    const commandAt29999 = await setup.api.readComputerUseCommand(
      admin,
      setup.commandId,
    );
    expect(hostAt29999).toMatchObject({
      status: "online",
      lastSeenAt: registeredAt,
    });
    expect(commandAt29999).toMatchObject({
      status: "failed",
      completedAt,
      error: { code: "app_not_found", message: "App missing" },
    });

    mockNow(start + 30_000);
    const at30000 = nowDate().toISOString();
    setAuthToken(admin, setup.sessionId);
    const retry1 = await accept(
      sessionHosts().complete({
        headers: sessionHeaders,
        params: { hostId: setup.hostId, commandId: setup.commandId },
        body: {
          connectionGeneration: setup.connectionGeneration,
          status: "succeeded",
          result: { apps: [] },
        },
      }),
      [200],
    );
    expect(retry1.body).toStrictEqual({ ok: true });
    await expect(
      readListedHost(setup.api, admin, setup.hostId),
    ).resolves.toMatchObject({ lastSeenAt: at30000 });
    await expect(
      setup.api.readComputerUseCommand(admin, setup.commandId),
    ).resolves.toStrictEqual(commandAt29999);

    mockNow(start + 59_999);
    setAuthToken(admin, setup.sessionId);
    const retry2 = await accept(
      sessionHosts().complete({
        headers: sessionHeaders,
        params: { hostId: setup.hostId, commandId: setup.commandId },
        body: {
          connectionGeneration: setup.connectionGeneration,
          status: "succeeded",
          result: { apps: [] },
        },
      }),
      [200],
    );
    expect(retry2.body).toStrictEqual({ ok: true });
    await expect(
      readListedHost(setup.api, admin, setup.hostId),
    ).resolves.toMatchObject({ lastSeenAt: at30000 });
    await expect(
      setup.api.readComputerUseCommand(admin, setup.commandId),
    ).resolves.toStrictEqual(commandAt29999);

    mockNow(start + 60_000);
    const at60000 = nowDate().toISOString();
    setAuthToken(admin, setup.sessionId);
    const retry3 = await accept(
      sessionHosts().complete({
        headers: sessionHeaders,
        params: { hostId: setup.hostId, commandId: setup.commandId },
        body: {
          connectionGeneration: setup.connectionGeneration,
          status: "succeeded",
          result: { apps: [] },
        },
      }),
      [200],
    );
    expect(retry3.body).toStrictEqual({ ok: true });
    await expect(
      readListedHost(setup.api, admin, setup.hostId),
    ).resolves.toMatchObject({ lastSeenAt: at60000 });
    await expect(
      setup.api.readComputerUseCommand(admin, setup.commandId),
    ).resolves.toStrictEqual(commandAt29999);
  });

  it("computer-use-session-hosts-009 rejects another user, organization, session, and replaced connection", async () => {
    const bdd = createBddApi(context);
    const admin = bdd.user({ orgRole: "org:admin" });
    const otherUser = bdd.user({ orgId: admin.orgId, orgRole: "org:admin" });
    const otherOrg = bdd.user({ userId: admin.userId, orgRole: "org:admin" });
    const installationId = randomUUID();
    const ownerSessionId = signInDesktop(admin);

    const gen1 = await accept(
      sessionHosts().register({
        headers: sessionHeaders,
        body: runtimeBody({ installationId }),
      }),
      [200],
    );

    signInDesktop(otherUser);
    await accept(
      sessionHosts().next({
        headers: sessionHeaders,
        params: { hostId: gen1.body.hostId },
        body: { connectionGeneration: 1, supportedCapabilities: ["apps.list"] },
      }),
      [409],
    );

    signInDesktop(otherOrg, ownerSessionId);
    await accept(
      sessionHosts().next({
        headers: sessionHeaders,
        params: { hostId: gen1.body.hostId },
        body: { connectionGeneration: 1, supportedCapabilities: ["apps.list"] },
      }),
      [409],
    );

    signInDesktop(admin, `sess_other_${randomUUID()}`);
    await accept(
      sessionHosts().next({
        headers: sessionHeaders,
        params: { hostId: gen1.body.hostId },
        body: { connectionGeneration: 1, supportedCapabilities: ["apps.list"] },
      }),
      [409],
    );

    signInDesktop(admin, ownerSessionId);
    const gen2 = await accept(
      sessionHosts().register({
        headers: sessionHeaders,
        body: runtimeBody({ installationId }),
      }),
      [200],
    );

    expect(gen2.body).toMatchObject({
      hostId: gen1.body.hostId,
      connectionGeneration: 2,
      commandNotifications: {
        channelName: `computer-use-host:${admin.userId}:${admin.orgId ?? ""}:${gen1.body.hostId}:2`,
        eventName: "commandsChanged",
      },
    });

    await accept(
      sessionHosts().stop({
        headers: sessionHeaders,
        params: { hostId: gen1.body.hostId },
        body: { connectionGeneration: 1 },
      }),
      [409],
    );

    await accept(
      sessionHosts().heartbeat({
        headers: sessionHeaders,
        params: { hostId: gen1.body.hostId },
        body: {
          ...runtimeBody({ installationId }),
          connectionGeneration: 2,
        },
      }),
      [200],
    );
  });

  it("computer-use-session-hosts-010 expires cached authority after remote session revocation before heartbeat", async () => {
    const start = Date.parse("2026-02-01T12:00:00.000Z");
    mockNow(start);
    const admin = createBddApi(context).user({ orgRole: "org:admin" });
    const setup = await registerAndClaimAppsList(admin);

    setProviderAuthority(admin, setup.sessionId, { sessionStatus: "revoked" });

    mockNow(start + 29_999);
    setAuthToken(admin, setup.sessionId);
    await accept(
      sessionHosts().heartbeat({
        headers: sessionHeaders,
        params: { hostId: setup.hostId },
        body: {
          ...runtimeBody({ installationId: setup.installationId }),
          connectionGeneration: setup.connectionGeneration,
        },
      }),
      [200],
    );

    mockNow(start + 30_000);
    setAuthToken(admin, setup.sessionId);
    await accept(
      sessionHosts().heartbeat({
        headers: sessionHeaders,
        params: { hostId: setup.hostId },
        body: {
          ...runtimeBody({ installationId: setup.installationId }),
          connectionGeneration: setup.connectionGeneration,
        },
      }),
      [409],
    );

    const listed = await readListedHost(setup.api, admin, setup.hostId);
    expect(listed.status).toBe("offline");
  });

  it("computer-use-session-hosts-011 expires cached authority after remote session revocation before next", async () => {
    const start = Date.parse("2026-02-01T12:00:00.000Z");
    mockNow(start);
    const admin = createBddApi(context).user({ orgRole: "org:admin" });
    const setup = await registerAndClaimAppsList(admin);

    setProviderAuthority(admin, setup.sessionId, { sessionStatus: "revoked" });

    mockNow(start + 29_999);
    setAuthToken(admin, setup.sessionId);
    await accept(
      sessionHosts().heartbeat({
        headers: sessionHeaders,
        params: { hostId: setup.hostId },
        body: {
          ...runtimeBody({ installationId: setup.installationId }),
          connectionGeneration: setup.connectionGeneration,
        },
      }),
      [200],
    );

    mockNow(start + 30_000);
    setAuthToken(admin, setup.sessionId);
    await accept(
      sessionHosts().next({
        headers: sessionHeaders,
        params: { hostId: setup.hostId },
        body: {
          connectionGeneration: setup.connectionGeneration,
          supportedCapabilities: ["apps.list"],
        },
      }),
      [409],
    );

    const listed = await readListedHost(setup.api, admin, setup.hostId);
    expect(listed.status).toBe("offline");
  });

  it("computer-use-session-hosts-015 expires cached authority after remote membership revocation before next", async () => {
    const start = Date.parse("2026-02-01T12:00:00.000Z");
    mockNow(start);
    const admin = createBddApi(context).user({ orgRole: "org:admin" });
    const setup = await registerAndClaimAppsList(admin);

    setProviderAuthority(admin, setup.sessionId, { hasMembership: false });

    mockNow(start + 29_999);
    setAuthToken(admin, setup.sessionId);
    await accept(
      sessionHosts().heartbeat({
        headers: sessionHeaders,
        params: { hostId: setup.hostId },
        body: {
          ...runtimeBody({ installationId: setup.installationId }),
          connectionGeneration: setup.connectionGeneration,
        },
      }),
      [200],
    );

    mockNow(start + 30_000);
    setAuthToken(admin, setup.sessionId);
    await accept(
      sessionHosts().next({
        headers: sessionHeaders,
        params: { hostId: setup.hostId },
        body: {
          connectionGeneration: setup.connectionGeneration,
          supportedCapabilities: ["apps.list"],
        },
      }),
      [409],
    );

    const listed = await readListedHost(setup.api, admin, setup.hostId);
    expect(listed.status).toBe("offline");
  });

  it("computer-use-session-hosts-016 expires cached authority after remote membership revocation before complete", async () => {
    const start = Date.parse("2026-02-01T12:00:00.000Z");
    mockNow(start);
    const admin = createBddApi(context).user({ orgRole: "org:admin" });
    const setup = await registerAndClaimAppsList(admin);

    setProviderAuthority(admin, setup.sessionId, { hasMembership: false });

    mockNow(start + 29_999);
    setAuthToken(admin, setup.sessionId);
    await accept(
      sessionHosts().heartbeat({
        headers: sessionHeaders,
        params: { hostId: setup.hostId },
        body: {
          ...runtimeBody({ installationId: setup.installationId }),
          connectionGeneration: setup.connectionGeneration,
        },
      }),
      [200],
    );

    mockNow(start + 30_000);
    setAuthToken(admin, setup.sessionId);
    await accept(
      sessionHosts().complete({
        headers: sessionHeaders,
        params: { hostId: setup.hostId, commandId: setup.commandId },
        body: {
          connectionGeneration: setup.connectionGeneration,
          status: "succeeded",
          result: { apps: [] },
        },
      }),
      [409],
    );

    const listed = await readListedHost(setup.api, admin, setup.hostId);
    expect(listed.status).toBe("offline");
  });

  it("computer-use-session-hosts-019 does not let a new connection report an older connection's action", async () => {
    const admin = createBddApi(context).user({ orgRole: "org:admin" });
    const setup = await registerAndClaimAppsList(admin);

    setAuthToken(admin, setup.sessionId);
    const gen2 = await accept(
      sessionHosts().register({
        headers: sessionHeaders,
        body: runtimeBody({ installationId: setup.installationId }),
      }),
      [200],
    );
    expect(gen2.body.connectionGeneration).toBe(2);

    await accept(
      sessionHosts().complete({
        headers: sessionHeaders,
        params: { hostId: setup.hostId, commandId: setup.commandId },
        body: {
          connectionGeneration: 1,
          status: "succeeded",
          result: { apps: [] },
        },
      }),
      [409],
    );

    await accept(
      sessionHosts().complete({
        headers: sessionHeaders,
        params: { hostId: setup.hostId, commandId: setup.commandId },
        body: {
          connectionGeneration: 2,
          status: "succeeded",
          result: { apps: [] },
        },
      }),
      [404],
    );

    const command = await setup.api.readComputerUseCommand(
      admin,
      setup.commandId,
    );
    expect(command.status).toBe("running");
  });

  it("pf-149 deletes the Desktop and command history and registers a fresh device on reconnect", async () => {
    const admin = createBddApi(context).user({ orgRole: "org:admin" });
    if (!admin.orgId) {
      throw new Error("Expected an org admin");
    }
    await updateFeatureSwitchesForUser(
      context,
      { userId: admin.userId, orgId: admin.orgId, orgRole: admin.orgRole },
      { [FeatureSwitchKey.RemoteDevices]: true },
    );
    const setup = await registerAndClaimAppsList(admin);
    const remoteDevices = setupApp({ context, routes: remoteDevicesRoutes })(
      remoteDevicesContract,
    );
    const commands = setupApp({ context, routes: computerUseRoutes })(
      computerUseCommandContract,
    );

    setAuthToken(admin, setup.sessionId);
    await accept(
      sessionHosts().complete({
        headers: sessionHeaders,
        params: { hostId: setup.hostId, commandId: setup.commandId },
        body: {
          connectionGeneration: setup.connectionGeneration,
          status: "succeeded",
          result: { apps: [] },
        },
      }),
      [200],
    );

    const beforeDirectory = await accept(
      remoteDevices.list({ headers: sessionHeaders }),
      [200],
    );
    const originalDevice = beforeDirectory.body.devices.find((device) => {
      return device.channels.some((channel) => {
        return channel.kind === "desktop" && channel.id === setup.hostId;
      });
    });
    expect(originalDevice).toBeDefined();
    if (!originalDevice) {
      throw new Error("Expected Desktop channel in remote devices directory");
    }

    const commandBefore = await setup.api.readComputerUseCommand(
      admin,
      setup.commandId,
    );
    expect(commandBefore.status).toBe("succeeded");

    setAuthToken(admin, setup.sessionId);
    await accept(
      remoteDevices.delete({
        headers: sessionHeaders,
        params: { deviceId: originalDevice.id },
      }),
      [204],
    );

    const [afterDirectory, hostsAfter, commandAfter, auditAfter] =
      await Promise.all([
        accept(remoteDevices.list({ headers: sessionHeaders }), [200]),
        setup.api.listComputerUseHosts(admin),
        accept(
          commands.get({
            headers: sessionHeaders,
            params: { commandId: setup.commandId },
          }),
          [404],
        ),
        setup.api.listComputerUseAuditEvents(admin, { hostId: setup.hostId }),
      ]);

    expect(
      afterDirectory.body.devices.some((device) => {
        return device.id === originalDevice.id;
      }),
    ).toBeFalsy();
    expect(
      hostsAfter.hosts.some((host) => {
        return host.id === setup.hostId;
      }),
    ).toBeFalsy();
    expect(commandAfter.status).toBe(404);
    expect(auditAfter.auditEvents).toStrictEqual([]);

    signInDesktop(admin, setup.sessionId);
    const reconnected = await accept(
      sessionHosts().register({
        headers: sessionHeaders,
        body: runtimeBody({ installationId: setup.installationId }),
      }),
      [200],
    );
    expect(reconnected.body.hostId).not.toBe(setup.hostId);
    expect(reconnected.body.connectionGeneration).toBe(1);

    const reconnectedDirectory = await accept(
      remoteDevices.list({ headers: sessionHeaders }),
      [200],
    );
    const freshDevice = reconnectedDirectory.body.devices.find((device) => {
      return device.channels.some((channel) => {
        return (
          channel.kind === "desktop" && channel.id === reconnected.body.hostId
        );
      });
    });
    expect(freshDevice).toBeDefined();
    expect(freshDevice?.id).not.toBe(originalDevice.id);
  });

  it("pf-156 renames an owned remote device and rejects another member's rename", async () => {
    const bdd = createBddApi(context);
    const owner = bdd.user({ orgRole: "org:admin" });
    const peer = bdd.user({ orgId: owner.orgId, orgRole: "org:member" });
    if (!owner.orgId) {
      throw new Error("Expected an org admin");
    }
    await updateFeatureSwitchesForUser(
      context,
      { userId: owner.userId, orgId: owner.orgId, orgRole: owner.orgRole },
      { [FeatureSwitchKey.RemoteDevices]: true },
    );
    const remoteDevices = setupApp({ context, routes: remoteDevicesRoutes })(
      remoteDevicesContract,
    );

    const desktopSessionId = `sess_${randomUUID()}`;
    signInDesktop(owner, desktopSessionId);
    const registered = await accept(
      sessionHosts().register({
        headers: sessionHeaders,
        body: runtimeBody({ installationId: randomUUID() }),
      }),
      [200],
    );

    setAuthToken(owner, desktopSessionId);
    const beforeDirectory = await accept(
      remoteDevices.list({ headers: sessionHeaders }),
      [200],
    );
    const ownedDevice = beforeDirectory.body.devices.find((device) => {
      return device.channels.some((channel) => {
        return (
          channel.kind === "desktop" && channel.id === registered.body.hostId
        );
      });
    });
    expect(ownedDevice).toBeDefined();
    if (!ownedDevice) {
      throw new Error("Expected owned Desktop device in directory");
    }

    const renamed = await accept(
      remoteDevices.rename({
        headers: sessionHeaders,
        params: { deviceId: ownedDevice.id },
        body: { displayName: "Studio Mac" },
      }),
      [200],
    );
    expect(renamed.body.id).toBe(ownedDevice.id);
    expect(renamed.body.displayName).toBe("Studio Mac");

    setAuthToken(peer, undefined);
    await accept(
      remoteDevices.rename({
        headers: sessionHeaders,
        params: { deviceId: ownedDevice.id },
        body: { displayName: "Unauthorized Name" },
      }),
      [404],
    );

    setAuthToken(owner, desktopSessionId);
    const afterDirectory = await accept(
      remoteDevices.list({ headers: sessionHeaders }),
      [200],
    );
    const readBack = afterDirectory.body.devices.find((device) => {
      return device.id === ownedDevice.id;
    });
    expect(readBack?.displayName).toBe("Studio Mac");
  });
});
