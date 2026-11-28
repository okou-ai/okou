import { randomUUID } from "node:crypto";

import { computerUseCommandContract } from "@okouai/api-contracts/contracts/computer-use";
import {
  remoteDevicesContract,
  type RemoteDeviceAccess,
} from "@okouai/api-contracts/contracts/remote-devices";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { describe, expect, it, onTestFinished } from "vitest";

import {
  accept,
  testContext,
  type TestContext,
} from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import {
  TEST_WITH_DOUBLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE,
  TEST_WITH_SINGLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE,
  TEST_WITH_TRIPLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE,
} from "../../../__tests__/test-timeouts";
import { mockEnv, mockOptionalEnv } from "../../../lib/env";
import { clearMockNow, mockNow, now, nowDate } from "../../../lib/time";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { computerUseRoutes } from "../computer-use";
import { remoteDevicesRoutes } from "../remote-devices";
import {
  createBddApi,
  expectApiError,
  type ApiTestUser,
} from "./helpers/api-bdd";
import { createChatFilesBddApi } from "./helpers/api-bdd-chat-files";
import { mockClerkMembership } from "./helpers/api-bdd-clerk";
import { createComputerUseBddApi } from "./helpers/api-bdd-computer-use";
import { createRunsApi } from "./helpers/api-bdd-runs";
import {
  createWebhookCallbackApi,
  deliverOrganizationCreated,
} from "./helpers/api-bdd-webhooks";
import { updateFeatureSwitchesForUser } from "./helpers/feature-switches";
import { createRouteMocks } from "./helpers/route-test";

const context = testContext();

const PNG_SIGNATURE = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);

function requireOrgId(actor: ApiTestUser): string {
  if (!actor.orgId) {
    throw new Error("Expected an organization member");
  }
  return actor.orgId;
}

function extractAuthorizationToken(
  authorizationUrl: string,
  expectedOrigin?: string,
): string {
  const parsed = new URL(authorizationUrl);
  if (expectedOrigin !== undefined) {
    expect(parsed.origin).toBe(expectedOrigin);
  }
  const prefix = "/computer-use/authorize/";
  expect(parsed.pathname.startsWith(prefix)).toBeTruthy();
  const token = decodeURIComponent(parsed.pathname.slice(prefix.length));
  expect(token.length).toBeGreaterThan(0);
  return token;
}

function sessionHeaders(testCtx: TestContext, actor: ApiTestUser) {
  createRouteMocks(testCtx).clerk.session(
    actor.userId,
    actor.orgId,
    actor.orgRole,
  );
  return { authorization: "Bearer clerk-session" };
}

async function findDesktopDevice(
  testCtx: TestContext,
  actor: ApiTestUser,
  hostId: string,
) {
  const client = setupApp({ context: testCtx, routes: remoteDevicesRoutes })(
    remoteDevicesContract,
  );
  const response = await accept(
    client.list({ headers: sessionHeaders(testCtx, actor) }),
    [200],
  );
  const device = response.body.devices.find((candidate) => {
    return candidate.channels.some((channel) => {
      return channel.kind === "desktop" && channel.id === hostId;
    });
  });
  if (!device) {
    throw new Error(`Expected remote device for desktop host ${hostId}`);
  }
  return device;
}

async function setDeviceAccess(
  testCtx: TestContext,
  actor: ApiTestUser,
  deviceId: string,
  body: RemoteDeviceAccess,
) {
  const client = setupApp({ context: testCtx, routes: remoteDevicesRoutes })(
    remoteDevicesContract,
  );
  await accept(
    client.setAccess({
      headers: sessionHeaders(testCtx, actor),
      params: { deviceId },
      body,
    }),
    [200],
  );
}

async function createRunLauncher(testCtx: TestContext, actor: ApiTestUser) {
  const bdd = createBddApi(testCtx);
  const runs = createRunsApi(testCtx);
  const chat = createChatFilesBddApi(testCtx);
  bdd.acceptStorageWrites();
  runs.acceptStorageDownloads();
  runs.acceptTelemetryIngest();
  mockOptionalEnv("OPENROUTER_API_KEY", "bdd-issued-credential-key");

  const [, runnerGroup] = await Promise.all([
    deliverOrganizationCreated(testCtx, actor),
    runs.configureRunnerGroup(),
  ]);

  let activeRun:
    | {
        readonly runId: string;
        readonly sandboxToken: string;
        readonly issuedAt: number;
      }
    | undefined;

  async function cancelActiveRun(restoreRealClock = false): Promise<void> {
    if (!activeRun) {
      if (restoreRealClock) {
        clearMockNow();
      }
      return;
    }
    const toCancel = activeRun;
    activeRun = undefined;
    const savedNow = now();
    mockNow(toCancel.issuedAt);
    await runs.requestCancelRun(actor, toCancel.runId, [200, 400]);
    await createWebhookCallbackApi(testCtx).requestAgentComplete(
      { runId: toCancel.runId, exitCode: 1, error: "Run cancelled" },
      { authorization: `Bearer ${toCancel.sandboxToken}` },
      [200, 400],
    );
    await flushWaitUntilForTest();
    if (restoreRealClock) {
      clearMockNow();
    } else {
      mockNow(savedNow);
    }
  }

  onTestFinished(async () => {
    await cancelActiveRun(true);
  });

  return {
    async launch(hostId?: string) {
      await cancelActiveRun();
      const before = runs.receivedDispatches(runnerGroup).length;
      const sent = await chat.requestSendEvent(
        actor,
        {
          prompt: "Use my desktop",
          model: null,
          clientEventId: randomUUID(),
          computerUseHostId: hostId ?? null,
        },
        [201],
      );
      if (sent.status !== 201) {
        throw new Error("Expected an accepted chat send");
      }
      await flushWaitUntilForTest();
      const dispatches = runs.receivedDispatches(runnerGroup);
      const dispatch = dispatches.at(-1);
      const token = dispatch?.executionContext.platformEnvironment.OKOU_TOKEN;
      if (dispatches.length <= before || !dispatch || !token) {
        throw new Error("Expected a dispatched Run with OKOU_TOKEN");
      }
      activeRun = {
        runId: dispatch.executionContext.runId,
        sandboxToken: dispatch.executionContext.sandboxToken,
        issuedAt: now(),
      };
      return {
        token,
        runId: dispatch.executionContext.runId,
        threadId: sent.body.threadId,
        sandboxToken: dispatch.executionContext.sandboxToken,
      };
    },
  };
}

describe("desktop computer-use runtime", () => {
  it("computer-use.bdd-017 keeps an installation's host stable across stop and restart", async () => {
    const api = createComputerUseBddApi(context);
    const member = createBddApi(context).user({ orgRole: "org:member" });
    const installationId = randomUUID();
    const host = await api.startComputerUseHost(member, {
      installationId,
      hostName: "Studio Mac",
    });

    await api.stopComputerUseHost(host.connection);
    const heartbeat = await api.requestComputerUseHeartbeat(
      host.connection,
      [409],
    );
    const stopped = await api.listComputerUseHosts(member);
    const restarted = await api.startComputerUseHost(member, {
      installationId,
      hostName: "Renamed Studio Mac",
    });
    const relisted = await api.listComputerUseHosts(member);

    expect(heartbeat.body).toMatchObject({
      error: {
        message: "Computer-use host connection is no longer authorized",
      },
    });
    expect(stopped.hosts).toStrictEqual([
      expect.objectContaining({ id: host.hostId, status: "offline" }),
    ]);
    expect(restarted.hostId).toBe(host.hostId);
    expect(restarted.connectionGeneration).toBeGreaterThan(
      host.connectionGeneration,
    );
    expect(relisted.hosts).toStrictEqual([
      expect.objectContaining({
        id: host.hostId,
        status: "online",
        displayName: "Renamed Studio Mac",
      }),
    ]);
  });

  it("computer-use.bdd-016 keeps multiple active hosts and lets a stale heartbeat recover", async () => {
    const api = createComputerUseBddApi(context);
    const member = createBddApi(context).user({ orgRole: "org:member" });
    const startedAt = now();
    mockNow(startedAt);
    const office = await api.startComputerUseHost(member, {
      hostName: "Office Mac",
    });
    const firstHeartbeat = await api.heartbeatComputerUseHost(
      office.connection,
      { hostName: "Office Mac" },
    );
    mockNow(startedAt + 120_000);
    const studio = await api.startComputerUseHost(member, {
      hostName: "Studio Mac",
    });

    const recoveredHeartbeat = await api.heartbeatComputerUseHost(
      office.connection,
      { hostName: "Office Mac" },
    );
    const listing = await api.listComputerUseHosts(member);
    const stopped = await api.stopComputerUseHost(studio.connection);
    const recovered = await api.startComputerUseHost(member, {
      hostName: "Recovered Desktop",
    });

    expect(firstHeartbeat).toStrictEqual({
      ok: true,
      hostId: office.hostId,
      hasPendingCommands: false,
    });
    expect(recoveredHeartbeat).toStrictEqual({
      ok: true,
      hostId: office.hostId,
      hasPendingCommands: false,
    });
    expect(studio.hostId).not.toBe(office.hostId);
    expect(listing.hosts).toHaveLength(2);
    expect(listing.hosts).toStrictEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: office.hostId,
          status: "online",
          displayName: "Office Mac",
        }),
        expect.objectContaining({
          id: studio.hostId,
          status: "online",
          displayName: "Studio Mac",
        }),
      ]),
    );
    expect(stopped).toStrictEqual({ ok: true, hostId: studio.hostId });
    expect(recovered.hostId).not.toBe(studio.hostId);
  });

  it("computer-use.bdd-013 chains host start, command claim, completion, audit and host stop", async () => {
    const api = createComputerUseBddApi(context);
    const bdd = createBddApi(context);
    const member = bdd.user({ orgRole: "org:member" });
    const peer = bdd.user({ orgId: member.orgId, orgRole: "org:member" });

    const initial = await api.listComputerUseHosts(member);
    const host = await api.startComputerUseHost(member, {
      hostName: "lancy-macbook-pro.local",
    });
    const listed = await api.listComputerUseHosts(member);
    const created = await api.createComputerUseWriteCommand(member, {
      kind: "app.open",
      app: "Safari",
    });
    const claimed = await api.claimNextComputerUseCommand(host.connection);
    await api.completeComputerUseCommand(host.connection, created.commandId);
    const completed = await api.readComputerUseCommand(
      member,
      created.commandId,
    );
    const peerRead = await api.requestReadComputerUseCommand(
      peer,
      created.commandId,
      [403, 404],
    );
    const audit = await api.listComputerUseAuditEvents(member, {
      commandId: created.commandId,
    });
    await api.stopComputerUseHost(host.connection);
    const afterStop = await api.listComputerUseHosts(member);
    const heartbeat = await api.requestComputerUseHeartbeat(
      host.connection,
      [409],
    );

    expect(initial.hosts).toStrictEqual([]);
    expect(host.connectionGeneration).toBe(1);
    expect(listed.hosts).toStrictEqual([
      expect.objectContaining({
        id: host.hostId,
        status: "online",
        permissions: expect.objectContaining({
          accessibility: true,
          screenRecording: true,
        }),
      }),
    ]);
    expect(created.status).toBe("queued");
    expect(claimed).toMatchObject({
      status: "command",
      command: { id: created.commandId, kind: "app.open" },
    });
    expect(completed).toMatchObject({
      status: "succeeded",
      hostId: host.hostId,
    });
    expect(peerRead.body).toMatchObject({
      error: { code: expect.stringMatching(/^(FORBIDDEN|NOT_FOUND)$/) },
    });
    expect(audit.auditEvents).toStrictEqual(
      expect.arrayContaining([
        expect.objectContaining({
          commandId: created.commandId,
          event: "completed",
        }),
      ]),
    );
    expect(afterStop.hosts).toStrictEqual([
      expect.objectContaining({ id: host.hostId, status: "offline" }),
    ]);
    expect(heartbeat.status).toBe(409);
  });

  it("computer-use.bdd-025 offloads a screenshot and resolves its download URL for the owner only", async () => {
    const api = createComputerUseBddApi(context);
    const bdd = createBddApi(context);
    const member = bdd.user({ orgRole: "org:member" });
    const outsider = bdd.user({ orgRole: "org:member" });
    const storage = api.installComputerUseS3Fake();
    const host = await api.startComputerUseHost(member);
    const { commandId } = await api.createComputerUseReadCommand(member, {
      kind: "app.state",
      app: "Safari",
    });
    await api.claimNextComputerUseCommand(host.connection);
    const png = Buffer.concat([PNG_SIGNATURE, Buffer.alloc(56, 7)]);

    await api.completeComputerUseCommandWith(host.connection, commandId, {
      status: "succeeded",
      result: {
        app: "Safari",
        snapshotId: "snapshot-1",
        screenshot: `data:image/png;base64,${png.toString("base64")}`,
        screenshotWidth: 1363,
        screenshotHeight: 1200,
      },
    });
    const completed = await api.readComputerUseCommand(member, commandId);
    const download = await api.resolveComputerUseScreenshot(member, commandId);
    const outsiderDownload = await api.requestComputerUseScreenshot(
      outsider,
      commandId,
      [404],
    );

    const key = `computer-use/${member.orgId ?? ""}/${member.userId}/${commandId}/screenshot.png`;
    expect(storage.puts).toStrictEqual([
      {
        bucket: expect.stringContaining("user-storages"),
        key,
        body: png,
        contentType: "image/png",
      },
    ]);
    expect(completed).toMatchObject({
      status: "succeeded",
      result: {
        screenshot: {
          type: "s3",
          mimeType: "image/png",
          sizeBytes: png.length,
          width: 1363,
          height: 1200,
        },
      },
    });
    expect(JSON.stringify(completed)).not.toContain(png.toString("base64"));
    expect(download).toMatchObject({
      downloadUrl: expect.stringContaining(encodeURIComponent(key)),
      contentType: "image/png",
      size: png.length,
    });
    expect(outsiderDownload.body).toMatchObject({
      error: { code: "NOT_FOUND" },
    });
  });

  it(
    "computer-use.bdd-001 creates a delegated authorization link, keeps its host directory fresh across heartbeat and stop, and hides legacy links under remoteDevices",
    { timeout: TEST_WITH_SINGLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
    async () => {
      mockEnv("APP_URL", "https://app.okou.ai");
      const bdd = createBddApi(context);
      const chat = createChatFilesBddApi(context);
      const api = createComputerUseBddApi(context);
      const member = bdd.user({ orgRole: "org:member" });
      const memberOrgId = requireOrgId(member);

      const host = await api.startComputerUseHost(member, {
        hostName: "Studio Mac",
      });
      const launcher = await createRunLauncher(context, member);
      const run = await launcher.launch();

      mockClerkMembership(context, member, "org:member");
      const created = await api.createComputerUseAuthorizationRequest({
        bearer: run.token,
      });
      expect(created.source).toBe("chat");
      const requestToken = extractAuthorizationToken(
        created.authorizationUrl,
        "https://app.okou.ai",
      );

      const initialDirectory = await api.listComputerUseHosts(member);
      const beforeApply = await api.readComputerUseAuthorizationRequest(
        member,
        requestToken,
      );
      expect(beforeApply).toMatchObject({
        source: "chat",
        chatThreadId: run.threadId,
        completedAt: null,
        computerUseHostId: null,
        hosts: initialDirectory.hosts,
      });

      const applied = await api.applyComputerUseAuthorizationRequest(
        member,
        requestToken,
        host.hostId,
      );
      expect(applied).toStrictEqual({
        ok: true,
        source: "chat",
        computerUseHostId: host.hostId,
      });

      const metadata = await chat.readThreadMetadata(member, run.threadId);
      expect(metadata.computerUseHostId).toBe(host.hostId);

      const afterApply = await api.readComputerUseAuthorizationRequest(
        member,
        requestToken,
      );
      expect(afterApply.completedAt).not.toBeNull();
      expect(afterApply.computerUseHostId).toBe(host.hostId);

      await api.heartbeatComputerUseHost(host.connection, {
        hostName: "Renamed Studio Mac",
        supportedCapabilities: ["apps.list"],
        permissions: { accessibility: false, screenRecording: true },
      });
      const refreshedDirectory = await api.listComputerUseHosts(member);
      const afterHeartbeat = await api.readComputerUseAuthorizationRequest(
        member,
        requestToken,
      );
      expect(afterHeartbeat.completedAt).toBe(afterApply.completedAt);
      expect(afterHeartbeat.hosts).toStrictEqual(refreshedDirectory.hosts);
      expect(afterHeartbeat.hosts).toStrictEqual([
        expect.objectContaining({
          id: host.hostId,
          displayName: "Renamed Studio Mac",
          supportedCapabilities: ["apps.list"],
          permissions: expect.objectContaining({ accessibility: false }),
          status: "online",
        }),
      ]);

      await api.stopComputerUseHost(host.connection);
      const stoppedDirectory = await api.listComputerUseHosts(member);
      expect(stoppedDirectory.hosts).toStrictEqual([
        expect.objectContaining({ id: host.hostId, status: "offline" }),
      ]);
      const afterStop = await api.readComputerUseAuthorizationRequest(
        member,
        requestToken,
      );
      expect(afterStop).toStrictEqual({ ...afterHeartbeat, hosts: [] });

      await updateFeatureSwitchesForUser(
        context,
        { userId: member.userId, orgId: memberOrgId, orgRole: member.orgRole },
        { [FeatureSwitchKey.RemoteDevices]: true },
      );
      mockClerkMembership(context, member, "org:member");
      const createDisabled =
        await api.requestCreateComputerUseAuthorizationRequest(
          { bearer: run.token },
          [404],
        );
      expect(createDisabled.body).toStrictEqual({
        error: {
          message: "Computer Use authorization request not found",
          code: "NOT_FOUND",
        },
      });
      const applyDisabled =
        await api.requestApplyComputerUseAuthorizationRequest(
          member,
          requestToken,
          host.hostId,
          [404],
        );
      expect(applyDisabled.body).toStrictEqual({
        error: {
          message: "Computer Use authorization request not found",
          code: "NOT_FOUND",
        },
      });
    },
  );

  it(
    "computer-use.bdd-002 denies authorization tokens to another user in the same org without changing their owner's state",
    { timeout: TEST_WITH_SINGLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
    async () => {
      const bdd = createBddApi(context);
      const chat = createChatFilesBddApi(context);
      const api = createComputerUseBddApi(context);
      const member = bdd.user({ orgRole: "org:member" });
      const peer = bdd.user({ orgId: member.orgId, orgRole: "org:member" });

      const host = await api.startComputerUseHost(member, {
        hostName: "Owner Desktop",
      });
      const launcher = await createRunLauncher(context, member);
      const run = await launcher.launch();

      mockClerkMembership(context, member, "org:member");
      const created = await api.createComputerUseAuthorizationRequest({
        bearer: run.token,
      });
      const requestToken = extractAuthorizationToken(created.authorizationUrl);

      const requestBefore = await api.readComputerUseAuthorizationRequest(
        member,
        requestToken,
      );
      const metadataBefore = await chat.readThreadMetadata(
        member,
        run.threadId,
      );
      const eventsBefore = await chat.requestThreadEvents(member, {}, [200]);

      const peerRead = await api.requestReadComputerUseAuthorizationRequest(
        peer,
        requestToken,
        [404],
      );
      expect(peerRead.body).toStrictEqual({
        error: {
          message: "Computer Use authorization request not found",
          code: "NOT_FOUND",
        },
      });

      const peerApply = await api.requestApplyComputerUseAuthorizationRequest(
        peer,
        requestToken,
        host.hostId,
        [404],
      );
      expect(peerApply.body).toStrictEqual({
        error: {
          message: "Computer Use authorization request not found",
          code: "NOT_FOUND",
        },
      });

      await expect(
        api.readComputerUseAuthorizationRequest(member, requestToken),
      ).resolves.toStrictEqual(requestBefore);
      await expect(
        chat.readThreadMetadata(member, run.threadId),
      ).resolves.toStrictEqual(metadataBefore);
      const eventsAfter = await chat.requestThreadEvents(member, {}, [200]);
      expect(eventsAfter.body).toStrictEqual(eventsBefore.body);
    },
  );

  it(
    "computer-use.bdd-003 denies authorization tokens to the same user in another org without changing their owner's state",
    { timeout: TEST_WITH_SINGLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
    async () => {
      const bdd = createBddApi(context);
      const chat = createChatFilesBddApi(context);
      const api = createComputerUseBddApi(context);
      const member = bdd.user({ orgRole: "org:member" });
      const sameUserOtherOrg = bdd.user({
        userId: member.userId,
        orgRole: "org:member",
      });

      const host = await api.startComputerUseHost(member, {
        hostName: "Owner Org Desktop",
      });
      const launcher = await createRunLauncher(context, member);
      const run = await launcher.launch();

      mockClerkMembership(context, member, "org:member");
      const created = await api.createComputerUseAuthorizationRequest({
        bearer: run.token,
      });
      const requestToken = extractAuthorizationToken(created.authorizationUrl);

      const requestBefore = await api.readComputerUseAuthorizationRequest(
        member,
        requestToken,
      );
      const metadataBefore = await chat.readThreadMetadata(
        member,
        run.threadId,
      );
      const eventsBefore = await chat.requestThreadEvents(member, {}, [200]);

      const foreignRead = await api.requestReadComputerUseAuthorizationRequest(
        sameUserOtherOrg,
        requestToken,
        [404],
      );
      expect(foreignRead.body).toStrictEqual({
        error: {
          message: "Computer Use authorization request not found",
          code: "NOT_FOUND",
        },
      });

      const foreignApply =
        await api.requestApplyComputerUseAuthorizationRequest(
          sameUserOtherOrg,
          requestToken,
          host.hostId,
          [404],
        );
      expect(foreignApply.body).toStrictEqual({
        error: {
          message: "Computer Use authorization request not found",
          code: "NOT_FOUND",
        },
      });

      await expect(
        api.readComputerUseAuthorizationRequest(member, requestToken),
      ).resolves.toStrictEqual(requestBefore);
      await expect(
        chat.readThreadMetadata(member, run.threadId),
      ).resolves.toStrictEqual(metadataBefore);
      const eventsAfter = await chat.requestThreadEvents(member, {}, [200]);
      expect(eventsAfter.body).toStrictEqual(eventsBefore.body);
    },
  );

  it(
    "computer-use.bdd-004 rejects an online host owned by another user in the same org without completing authorization",
    { timeout: TEST_WITH_SINGLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
    async () => {
      const bdd = createBddApi(context);
      const chat = createChatFilesBddApi(context);
      const api = createComputerUseBddApi(context);
      const member = bdd.user({ orgRole: "org:member" });
      const peer = bdd.user({ orgId: member.orgId, orgRole: "org:member" });

      const peerHost = await api.startComputerUseHost(peer, {
        hostName: "Peer Online Desktop",
      });
      const launcher = await createRunLauncher(context, member);
      const run = await launcher.launch();

      mockClerkMembership(context, member, "org:member");
      const created = await api.createComputerUseAuthorizationRequest({
        bearer: run.token,
      });
      const requestToken = extractAuthorizationToken(created.authorizationUrl);

      const requestBefore = await api.readComputerUseAuthorizationRequest(
        member,
        requestToken,
      );
      expect(requestBefore).toMatchObject({
        completedAt: null,
        computerUseHostId: null,
        hosts: [],
      });
      const metadataBefore = await chat.readThreadMetadata(
        member,
        run.threadId,
      );
      const eventsBefore = await chat.requestThreadEvents(member, {}, [200]);

      const rejected = await api.requestApplyComputerUseAuthorizationRequest(
        member,
        requestToken,
        peerHost.hostId,
        [404],
      );
      expect(rejected.body).toStrictEqual({
        error: {
          message: "Computer-use host not found",
          code: "NOT_FOUND",
        },
      });

      await expect(
        api.readComputerUseAuthorizationRequest(member, requestToken),
      ).resolves.toStrictEqual(requestBefore);
      await expect(
        chat.readThreadMetadata(member, run.threadId),
      ).resolves.toStrictEqual(metadataBefore);
      const eventsAfter = await chat.requestThreadEvents(member, {}, [200]);
      expect(eventsAfter.body).toStrictEqual(eventsBefore.body);
    },
  );

  it(
    "computer-use.bdd-006 expires a pending authorization at the inclusive one-hour boundary",
    { timeout: TEST_WITH_SINGLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
    async () => {
      const start = Date.parse("2026-02-01T12:00:00.000Z");
      mockNow(start);
      const bdd = createBddApi(context);
      const chat = createChatFilesBddApi(context);
      const api = createComputerUseBddApi(context);
      const member = bdd.user({ orgRole: "org:member" });

      const host = await api.startComputerUseHost(member, {
        hostName: "Expiry Desktop",
      });
      const launcher = await createRunLauncher(context, member);
      const run = await launcher.launch();

      const createdAtMs = start + 1000;
      const expiryMs = createdAtMs + 60 * 60 * 1000;
      mockNow(createdAtMs);
      mockClerkMembership(context, member, "org:member");
      const created = await api.createComputerUseAuthorizationRequest({
        bearer: run.token,
      });
      expect(created.expiresAt).toBe(new Date(expiryMs).toISOString());
      const requestToken = extractAuthorizationToken(created.authorizationUrl);

      const metadataBefore = await chat.readThreadMetadata(
        member,
        run.threadId,
      );
      const eventsBefore = await chat.requestThreadEvents(member, {}, [200]);

      mockNow(expiryMs - 1);
      await api.heartbeatComputerUseHost(host.connection, {
        hostName: "Expiry Desktop",
      });
      const beforeExpiry = await api.readComputerUseAuthorizationRequest(
        member,
        requestToken,
      );
      expect(beforeExpiry).toMatchObject({
        completedAt: null,
        computerUseHostId: null,
        hosts: [expect.objectContaining({ id: host.hostId })],
      });

      mockNow(expiryMs);
      const expiredRead = await api.requestReadComputerUseAuthorizationRequest(
        member,
        requestToken,
        [410],
      );
      expect(expiredRead.body).toMatchObject({ error: { code: "GONE" } });

      const expiredApply =
        await api.requestApplyComputerUseAuthorizationRequest(
          member,
          requestToken,
          host.hostId,
          [410],
        );
      expect(expiredApply.body).toMatchObject({ error: { code: "GONE" } });

      await expect(
        chat.readThreadMetadata(member, run.threadId),
      ).resolves.toStrictEqual(metadataBefore);
      const eventsAfter = await chat.requestThreadEvents(member, {}, [200]);
      expect(eventsAfter.body).toStrictEqual(eventsBefore.body);
    },
  );

  it(
    "computer-use.bdd-010 only exposes online hosts for delegated authorization requests",
    { timeout: TEST_WITH_SINGLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
    async () => {
      const start = Date.parse("2026-02-01T12:00:00.000Z");
      mockNow(start);
      const bdd = createBddApi(context);
      const chat = createChatFilesBddApi(context);
      const api = createComputerUseBddApi(context);
      const member = bdd.user({ orgRole: "org:member" });
      const memberOrgId = requireOrgId(member);

      const staleHost = await api.startComputerUseHost(member, {
        hostName: "Stale Desktop",
      });

      mockNow(start + 1000);
      const stoppedHost = await api.startComputerUseHost(member, {
        hostName: "Stopped Desktop",
      });
      await api.stopComputerUseHost(stoppedHost.connection);

      mockNow(start + 120_000);
      const onlineHost = await api.startComputerUseHost(member, {
        hostName: "Online Desktop",
      });

      const launcher = await createRunLauncher(context, member);
      const run = await launcher.launch();

      mockClerkMembership(context, member, "org:member");
      const created = await api.createComputerUseAuthorizationRequest({
        bearer: run.token,
      });
      const requestToken = extractAuthorizationToken(created.authorizationUrl);

      const readable = await api.readComputerUseAuthorizationRequest(
        member,
        requestToken,
      );
      expect(readable.hosts).toStrictEqual([
        expect.objectContaining({ id: onlineHost.hostId, status: "online" }),
      ]);

      const staleApply = await api.requestApplyComputerUseAuthorizationRequest(
        member,
        requestToken,
        staleHost.hostId,
        [404],
      );
      expect(staleApply.body).toStrictEqual({
        error: { message: "Computer-use host not found", code: "NOT_FOUND" },
      });

      const stoppedApply =
        await api.requestApplyComputerUseAuthorizationRequest(
          member,
          requestToken,
          stoppedHost.hostId,
          [404],
        );
      expect(stoppedApply.body).toStrictEqual({
        error: { message: "Computer-use host not found", code: "NOT_FOUND" },
      });

      const onlineApply = await api.applyComputerUseAuthorizationRequest(
        member,
        requestToken,
        onlineHost.hostId,
      );
      expect(onlineApply).toStrictEqual({
        ok: true,
        source: "chat",
        computerUseHostId: onlineHost.hostId,
      });

      const metadata = await chat.readThreadMetadata(member, run.threadId);
      expect(metadata.computerUseHostId).toBe(onlineHost.hostId);

      await updateFeatureSwitchesForUser(
        context,
        { userId: member.userId, orgId: memberOrgId, orgRole: member.orgRole },
        { [FeatureSwitchKey.RemoteDevices]: true },
      );
      mockClerkMembership(context, member, "org:member");
      const createDisabled =
        await api.requestCreateComputerUseAuthorizationRequest(
          { bearer: run.token },
          [404],
        );
      expect(createDisabled.body).toStrictEqual({
        error: {
          message: "Computer Use authorization request not found",
          code: "NOT_FOUND",
        },
      });
    },
  );

  it(
    "computer-use.bdd-018 scopes host discovery to the bound host and enforces device policy for agent run tokens",
    { timeout: TEST_WITH_DOUBLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
    async () => {
      const bdd = createBddApi(context);
      const api = createComputerUseBddApi(context);
      const member = bdd.user({ orgRole: "org:member" });
      const memberOrgId = requireOrgId(member);

      await api.startComputerUseHost(member, {
        hostName: "Other Desktop",
        supportedCapabilities: ["apps.list"],
      });
      const notesHost = await api.startComputerUseHost(member, {
        hostName: "Apple Notes Desktop",
        supportedCapabilities: ["app.state"],
      });

      const launcher = await createRunLauncher(context, member);
      const unboundRun = await launcher.launch();
      const boundRun = await launcher.launch(notesHost.hostId);

      mockClerkMembership(context, member, "org:member");
      const boundHosts = await api.listComputerUseHosts({
        bearer: boundRun.token,
      });
      expect(boundHosts.hosts).toStrictEqual([
        expect.objectContaining({
          id: notesHost.hostId,
          displayName: "Apple Notes Desktop",
          supportedCapabilities: ["app.state"],
        }),
      ]);

      const unboundResponse = await api.requestListComputerUseHosts(
        { bearer: unboundRun.token },
        [403],
      );
      expectApiError(unboundResponse.body);

      await updateFeatureSwitchesForUser(
        context,
        { userId: member.userId, orgId: memberOrgId, orgRole: member.orgRole },
        { [FeatureSwitchKey.RemoteDevices]: true },
      );

      mockClerkMembership(context, member, "org:member");
      await expect(
        api.listComputerUseHosts({ bearer: boundRun.token }),
      ).resolves.toStrictEqual({ hosts: [] });

      const device = await findDesktopDevice(context, member, notesHost.hostId);
      expect(device).toMatchObject({ accessAllowed: false });
      await setDeviceAccess(context, member, device.id, { mode: "always" });

      mockClerkMembership(context, member, "org:member");
      const allowedHosts = await api.listComputerUseHosts({
        bearer: boundRun.token,
      });
      expect(allowedHosts.hosts).toStrictEqual([
        expect.objectContaining({
          id: notesHost.hostId,
          displayName: "Apple Notes Desktop",
          supportedCapabilities: ["app.state"],
        }),
      ]);
    },
  );

  it(
    "computer-use.bdd-021 routes commands across offline, unsupported, ambiguous, granted and device-policy hosts",
    { timeout: TEST_WITH_TRIPLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
    async () => {
      const start = Date.parse("2026-02-01T12:00:00.000Z");
      mockNow(start);
      const bdd = createBddApi(context);
      const api = createComputerUseBddApi(context);
      const member = bdd.user({ orgRole: "org:member" });
      const memberOrgId = requireOrgId(member);

      const noHost = await api.requestCreateComputerUseReadCommand(
        member,
        { kind: "apps.list" },
        [404],
      );
      expect(noHost.body).toStrictEqual({
        error: {
          message: "No linked computer-use host found",
          code: "NOT_FOUND",
        },
      });

      const hostA = await api.startComputerUseHost(member, {
        hostName: "Host A",
        supportedCapabilities: ["apps.list"],
      });

      mockNow(start + 91_000);
      const staleOnly = await api.requestCreateComputerUseReadCommand(
        member,
        { kind: "apps.list" },
        [409],
      );
      expect(staleOnly.body).toStrictEqual({
        error: {
          message: "No online computer-use host found",
          code: "CONFLICT",
        },
      });

      const hostB = await api.startComputerUseHost(member, {
        hostName: "Host B",
        supportedCapabilities: ["apps.list", "element.click"],
      });
      const unsupported = await api.requestCreateComputerUseReadCommand(
        member,
        { kind: "app.state", app: "Safari" },
        [409],
      );
      expect(unsupported.body).toStrictEqual({
        error: {
          message: "No online computer-use host supports this command",
          code: "CONFLICT",
        },
      });

      await expect(
        api.claimNextComputerUseCommand(hostA.connection, ["apps.list"]),
      ).resolves.toStrictEqual({ status: "idle" });

      const ambiguous = await api.requestCreateComputerUseReadCommand(
        member,
        { kind: "apps.list" },
        [409],
      );
      expect(ambiguous.body).toStrictEqual({
        error: {
          message: "Multiple active computer-use hosts are online",
          code: "CONFLICT",
        },
      });

      const launcher = await createRunLauncher(context, member);
      const unboundRun = await launcher.launch();

      mockClerkMembership(context, member, "org:member");
      const unboundDenied = await api.requestCreateComputerUseReadCommand(
        { bearer: unboundRun.token },
        { kind: "apps.list" },
        [403],
      );
      expect(unboundDenied.body).toStrictEqual({
        error: {
          message:
            "Computer Use is not authorized for this run. Authorize a computer once in the conversation, then retry.",
          code: "FORBIDDEN",
        },
      });

      const runB = await launcher.launch(hostB.hostId);
      mockClerkMembership(context, member, "org:member");
      const bRead = await api.createComputerUseReadCommand(
        { bearer: runB.token },
        { kind: "apps.list" },
      );
      const bClick = await api.createComputerUseWriteCommand(
        { bearer: runB.token },
        {
          kind: "element.click",
          app: "Safari",
          snapshotId: "snap_route_1",
          elementIndex: 3,
          button: "left",
          clickCount: 1,
        },
      );
      expect(bRead.status).toBe("queued");
      expect(bClick.status).toBe("queued");

      await expect(
        api.claimNextComputerUseCommand(hostA.connection, ["apps.list"]),
      ).resolves.toStrictEqual({ status: "idle" });

      const claimedRead = await api.claimNextComputerUseCommand(
        hostB.connection,
        ["apps.list", "element.click"],
      );
      expect(claimedRead).toMatchObject({
        status: "command",
        command: {
          id: bRead.commandId,
          status: "running",
          kind: "apps.list",
        },
      });
      await api.completeComputerUseCommandWith(
        hostB.connection,
        bRead.commandId,
        { status: "succeeded", result: { apps: ["Safari"] } },
      );

      const claimedClick = await api.claimNextComputerUseCommand(
        hostB.connection,
        ["apps.list", "element.click"],
      );
      expect(claimedClick).toMatchObject({
        status: "command",
        command: {
          id: bClick.commandId,
          status: "running",
          kind: "element.click",
          payload: {
            app: "Safari",
            snapshotId: "snap_route_1",
            elementIndex: 3,
            button: "left",
            clickCount: 1,
          },
        },
      });
      const rawAppState = "<app_state>secret-window-state</app_state>!";
      expect(rawAppState).toHaveLength(43);
      await api.completeComputerUseCommandWith(
        hostB.connection,
        bClick.commandId,
        {
          status: "succeeded",
          result: {
            app: "Safari",
            elementIndex: 3,
            button: "left",
            clickCount: 1,
            appState: rawAppState,
            metrics: { durationMs: 18 },
          },
        },
      );

      const audit = await api.listComputerUseAuditEvents(member, {
        runId: runB.runId,
        hostId: hostB.hostId,
      });
      expect(audit.auditEvents).toStrictEqual([
        expect.objectContaining({
          commandId: bClick.commandId,
          runId: runB.runId,
          hostId: hostB.hostId,
          kind: "element.click",
          event: "completed",
          redactedResult: expect.objectContaining({
            appStateLength: 43,
            metrics: { durationMs: 18 },
          }),
        }),
      ]);
      expect(JSON.stringify(audit)).not.toContain("<app_state>");

      const runA = await launcher.launch(hostA.hostId);
      mockNow(start + 182_000);
      await expect(
        api.claimNextComputerUseCommand(hostB.connection, [
          "apps.list",
          "element.click",
        ]),
      ).resolves.toStrictEqual({ status: "idle" });

      mockClerkMembership(context, member, "org:member");
      const hostAOffline = await api.requestCreateComputerUseReadCommand(
        { bearer: runA.token },
        { kind: "apps.list" },
        [409],
      );
      expect(hostAOffline.body).toStrictEqual({
        error: {
          message: "No online computer-use host found",
          code: "CONFLICT",
        },
      });

      await updateFeatureSwitchesForUser(
        context,
        { userId: member.userId, orgId: memberOrgId, orgRole: member.orgRole },
        { [FeatureSwitchKey.RemoteDevices]: true },
      );
      const readClient = setupApp({ context, routes: computerUseRoutes })(
        computerUseCommandContract,
      );
      mockClerkMembership(context, member, "org:member");
      const deniedDeviceB = await accept(
        readClient.create({
          headers: { authorization: `Bearer ${runA.token}` },
          body: {
            kind: "apps.list",
            hostId: hostB.hostId,
            timeoutMs: 60_000,
          },
        }),
        [404],
      );
      expect(deniedDeviceB.body.error.message).toBe(
        "No linked computer-use host found",
      );

      const deviceB = await findDesktopDevice(context, member, hostB.hostId);
      await setDeviceAccess(context, member, deviceB.id, { mode: "always" });
      mockClerkMembership(context, member, "org:member");
      const admittedDeviceB = await accept(
        readClient.create({
          headers: { authorization: `Bearer ${runA.token}` },
          body: {
            kind: "apps.list",
            hostId: hostB.hostId,
            timeoutMs: 60_000,
          },
        }),
        [200],
      );
      expect(admittedDeviceB.body).toStrictEqual({
        commandId: expect.any(String),
        status: "queued",
      });
    },
  );

  it("computer-use.bdd-024 times out stale running commands and reports completion failures", async () => {
    const start = Date.parse("2026-02-01T12:00:00.000Z");
    mockNow(start);
    const api = createComputerUseBddApi(context);
    const member = createBddApi(context).user({ orgRole: "org:member" });
    const host = await api.startComputerUseHost(member, {
      hostName: "Timeout Desktop",
    });

    const first = await api.createComputerUseReadCommand(member, {
      kind: "app.state",
      app: "Safari",
      timeoutMs: 1000,
    });
    const claimedFirst = await api.claimNextComputerUseCommand(host.connection);
    expect(claimedFirst).toMatchObject({
      status: "command",
      command: { id: first.commandId },
    });

    const second = await api.createComputerUseReadCommand(member, {
      kind: "apps.list",
    });

    await expect(
      api.claimNextComputerUseCommand(host.connection),
    ).resolves.toStrictEqual({ status: "idle" });

    const completeQueued = await api.requestCompleteComputerUseCommand(
      host.connection,
      second.commandId,
      { status: "succeeded", result: { apps: [] } },
      [404],
    );
    expect(completeQueued.body).toStrictEqual({
      error: { message: "Computer-use command not found", code: "NOT_FOUND" },
    });

    mockNow(start + 1500);
    const timedOutAt = nowDate().toISOString();
    const claimedSecond = await api.claimNextComputerUseCommand(
      host.connection,
    );
    expect(claimedSecond).toMatchObject({
      status: "command",
      command: { id: second.commandId, kind: "apps.list" },
    });

    const timedOutFirst = await api.readComputerUseCommand(
      member,
      first.commandId,
    );
    expect(timedOutFirst).toMatchObject({
      id: first.commandId,
      status: "failed",
      error: {
        code: "timeout",
        message: "Computer-use command timed out after 1000ms",
      },
      completedAt: timedOutAt,
    });

    await api.completeComputerUseCommandWith(
      host.connection,
      second.commandId,
      {
        status: "failed",
        error: {
          code: "app_not_found",
          message: "Finder is not available",
        },
      },
    );
    const failedSecond = await api.readComputerUseCommand(
      member,
      second.commandId,
    );
    expect(failedSecond).toMatchObject({
      id: second.commandId,
      status: "failed",
      error: {
        code: "app_not_found",
        message: "Finder is not available",
      },
    });

    const duplicate = await api.requestCompleteComputerUseCommand(
      host.connection,
      second.commandId,
      { status: "succeeded", result: { apps: ["Finder"] } },
      [200],
    );
    expect(duplicate.body).toStrictEqual({ ok: true });
    await expect(
      api.readComputerUseCommand(member, second.commandId),
    ).resolves.toStrictEqual(failedSecond);

    const unknown = await api.requestCompleteComputerUseCommand(
      host.connection,
      randomUUID(),
      { status: "succeeded", result: { apps: [] } },
      [404],
    );
    expect(unknown.body).toStrictEqual({
      error: { message: "Computer-use command not found", code: "NOT_FOUND" },
    });
  });
});
