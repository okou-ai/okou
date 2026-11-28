import { randomUUID } from "node:crypto";

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
import { TEST_WITH_TRIPLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE } from "../../../__tests__/test-timeouts";
import { mockOptionalEnv } from "../../../lib/env";
import { clearMockNow, mockNow, now, nowDate } from "../../../lib/time";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { remoteDevicesRoutes } from "../remote-devices";
import {
  createBddApi,
  expectApiError,
  type ApiTestUser,
} from "./helpers/api-bdd";
import { createAuthOrgBddApi } from "./helpers/api-bdd-auth-org";
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
  const response = await accept(
    client.setAccess({
      headers: sessionHeaders(testCtx, actor),
      params: { deviceId },
      body,
    }),
    [200],
  );
  return response.body;
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
      const beforeCount = runs.receivedDispatches(runnerGroup).length;
      const sent = await chat.requestSendEvent(
        actor,
        {
          prompt: "Inspect my computer-use command",
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
      if (dispatches.length <= beforeCount || !dispatch) {
        throw new Error("Expected chat send to dispatch a Run");
      }
      const token = dispatch.executionContext.platformEnvironment.OKOU_TOKEN;
      if (!token) {
        throw new Error("Expected dispatched Run OKOU_TOKEN");
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

describe("GET /api/computer-use/commands/:commandId", () => {
  it("computer-use-command-get-002 (1/2) preserves queued, running and succeeded offloaded response fields", async () => {
    const start = Date.parse("2026-02-01T12:00:00.000Z");
    mockNow(start);
    const bdd = createBddApi(context);
    const api = createComputerUseBddApi(context);
    const member = bdd.user({ orgRole: "org:member" });
    const storage = api.installComputerUseS3Fake();
    const host = await api.startComputerUseHost(member, {
      hostName: "Projection Desktop",
    });

    mockNow(start + 1000);
    const createdAt = nowDate().toISOString();
    const readCommand = await api.createComputerUseReadCommand(member, {
      kind: "app.state",
      app: "Safari",
      timeoutMs: 15_000,
    });
    const queued = await api.readComputerUseCommand(
      member,
      readCommand.commandId,
    );

    expect(queued).toStrictEqual({
      id: readCommand.commandId,
      kind: "app.state",
      status: "queued",
      hostId: host.hostId,
      hostName: "Projection Desktop",
      payload: { app: "Safari" },
      timeoutMs: 15_000,
      createdAt,
      claimedAt: null,
      completedAt: null,
    });

    mockNow(start + 2000);
    const claimedAt = nowDate().toISOString();
    const claimedRead = await api.claimNextComputerUseCommand(host.connection);
    expect(claimedRead).toMatchObject({
      status: "command",
      command: { id: readCommand.commandId },
    });
    const running = await api.readComputerUseCommand(
      member,
      readCommand.commandId,
    );

    expect(running).toStrictEqual({
      id: readCommand.commandId,
      kind: "app.state",
      status: "running",
      hostId: host.hostId,
      hostName: "Projection Desktop",
      payload: { app: "Safari" },
      timeoutMs: 15_000,
      createdAt,
      claimedAt,
      completedAt: null,
    });

    mockNow(start + 3000);
    const completedAt = nowDate().toISOString();
    const png = Buffer.concat([PNG_SIGNATURE, Buffer.alloc(64, 9)]);
    const dataUrl = `data:image/png;base64,${png.toString("base64")}`;
    const visibleText = "Safari — 検索結果 café";
    await api.completeComputerUseCommandWith(
      host.connection,
      readCommand.commandId,
      {
        status: "succeeded",
        result: {
          snapshotId: "snap_projection_1",
          visibleText,
          screenshot: dataUrl,
          screenshotWidth: 1280,
          screenshotHeight: 720,
        },
      },
    );
    const succeeded = await api.readComputerUseCommand(
      member,
      readCommand.commandId,
    );

    expect(succeeded).toStrictEqual({
      id: readCommand.commandId,
      kind: "app.state",
      status: "succeeded",
      hostId: host.hostId,
      hostName: "Projection Desktop",
      payload: { app: "Safari" },
      result: {
        snapshotId: "snap_projection_1",
        visibleText,
        screenshot: {
          type: "s3",
          mimeType: "image/png",
          sizeBytes: png.length,
          width: 1280,
          height: 720,
        },
        screenshotWidth: 1280,
        screenshotHeight: 720,
      },
      timeoutMs: 15_000,
      createdAt,
      claimedAt,
      completedAt,
    });
    expect(JSON.stringify(succeeded)).not.toContain(png.toString("base64"));
    expect(storage.puts).toHaveLength(1);
  });

  it("computer-use-command-get-002 (2/2) preserves failed response fields without a result", async () => {
    const start = Date.parse("2026-02-01T12:00:00.000Z");
    mockNow(start);
    const bdd = createBddApi(context);
    const api = createComputerUseBddApi(context);
    const member = bdd.user({ orgRole: "org:member" });
    api.installComputerUseS3Fake();
    const host = await api.startComputerUseHost(member, {
      hostName: "Projection Desktop",
    });

    mockNow(start + 4000);
    const writeCreatedAt = nowDate().toISOString();
    const writeCommand = await api.createComputerUseWriteCommand(member, {
      kind: "app.open",
      app: "Finder",
    });

    mockNow(start + 5000);
    const writeClaimedAt = nowDate().toISOString();
    const claimedWrite = await api.claimNextComputerUseCommand(host.connection);
    expect(claimedWrite).toMatchObject({
      status: "command",
      command: { id: writeCommand.commandId },
    });

    mockNow(start + 6000);
    const writeCompletedAt = nowDate().toISOString();
    const failureMessage = "Finder が見つかりません — résumé";
    await api.completeComputerUseCommandWith(
      host.connection,
      writeCommand.commandId,
      {
        status: "failed",
        error: {
          code: "app_not_found",
          message: failureMessage,
        },
      },
    );
    const failed = await api.readComputerUseCommand(
      member,
      writeCommand.commandId,
    );

    expect(failed).toStrictEqual({
      id: writeCommand.commandId,
      kind: "app.open",
      status: "failed",
      hostId: host.hostId,
      hostName: "Projection Desktop",
      payload: { app: "Finder" },
      error: {
        code: "app_not_found",
        message: failureMessage,
      },
      timeoutMs: 60_000,
      createdAt: writeCreatedAt,
      claimedAt: writeClaimedAt,
      completedAt: writeCompletedAt,
    });
    expect(failed).not.toHaveProperty("result");
  });

  it(
    "computer-use-command-get-001 preserves session, PAT and supported Agent auth with exact owner, host and device-policy isolation",
    { timeout: TEST_WITH_TRIPLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
    async () => {
      const bdd = createBddApi(context);
      const authOrg = createAuthOrgBddApi(context);
      const api = createComputerUseBddApi(context);
      const member = bdd.user({ orgRole: "org:member" });
      const memberOrgId = requireOrgId(member);
      const noOrg = bdd.user({ orgId: null });
      const peer = bdd.user({ orgId: member.orgId, orgRole: "org:member" });
      const outsider = bdd.user({ orgRole: "org:member" });

      const firstHost = await api.startComputerUseHost(member, {
        hostName: "Primary Desktop",
      });
      const secondHost = await api.startComputerUseHost(member, {
        hostName: "Secondary Desktop",
      });

      const launcher = await createRunLauncher(context, member);
      const secondHostRun = await launcher.launch(secondHost.hostId);
      const unboundRun = await launcher.launch();
      const boundRun = await launcher.launch(firstHost.hostId);

      mockClerkMembership(context, member, "org:member");
      const created = await api.createComputerUseWriteCommand(
        { bearer: boundRun.token },
        { kind: "app.open", app: "Safari" },
      );
      const pat = await authOrg.createCliToken(member);

      const anonymous = await api.requestReadComputerUseCommand(
        null,
        created.commandId,
        [401],
      );
      expectApiError(anonymous.body);

      const withoutOrg = await api.requestReadComputerUseCommand(
        noOrg,
        created.commandId,
        [401],
      );
      expectApiError(withoutOrg.body);

      const sessionRead = await api.readComputerUseCommand(
        member,
        created.commandId,
      );

      mockClerkMembership(context, member, "org:member");
      const patRead = await api.readComputerUseCommand(
        { bearer: pat.token },
        created.commandId,
      );
      const boundRead = await api.readComputerUseCommand(
        { bearer: boundRun.token },
        created.commandId,
      );
      expect(patRead).toStrictEqual(sessionRead);
      expect(boundRead).toStrictEqual(sessionRead);

      const expectedNotFound = {
        error: {
          message: "Computer-use command not found",
          code: "NOT_FOUND",
        },
      };
      const wrongHostRead = await api.requestReadComputerUseCommand(
        { bearer: secondHostRun.token },
        created.commandId,
        [404],
      );
      expect(wrongHostRead.body).toStrictEqual(expectedNotFound);

      const unboundRead = await api.requestReadComputerUseCommand(
        { bearer: unboundRun.token },
        created.commandId,
        [403],
      );
      expectApiError(unboundRead.body);

      const peerRead = await api.requestReadComputerUseCommand(
        peer,
        created.commandId,
        [404],
      );
      expect(peerRead.body).toStrictEqual(expectedNotFound);

      const outsiderRead = await api.requestReadComputerUseCommand(
        outsider,
        created.commandId,
        [404],
      );
      expect(outsiderRead.body).toStrictEqual(expectedNotFound);

      await updateFeatureSwitchesForUser(
        context,
        { userId: member.userId, orgId: memberOrgId, orgRole: member.orgRole },
        { [FeatureSwitchKey.RemoteDevices]: true },
      );

      mockClerkMembership(context, member, "org:member");
      const deniedByDevicePolicy = await api.requestReadComputerUseCommand(
        { bearer: boundRun.token },
        created.commandId,
        [404],
      );
      expect(deniedByDevicePolicy.body).toStrictEqual(expectedNotFound);

      const device = await findDesktopDevice(context, member, firstHost.hostId);
      expect(device).toMatchObject({ accessAllowed: false });
      await setDeviceAccess(context, member, device.id, { mode: "always" });

      mockClerkMembership(context, member, "org:member");
      const admittedRead = await api.readComputerUseCommand(
        { bearer: boundRun.token },
        created.commandId,
      );
      expect(admittedRead).toStrictEqual(sessionRead);
    },
  );
});

describe("Computer Use screenshot download URLs", () => {
  it(
    "computer-use-content-get-001 returns private screenshot metadata with owner, host and device-policy authorization",
    { timeout: TEST_WITH_TRIPLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
    async () => {
      mockNow(Date.parse("2026-02-01T12:00:00.000Z"));
      const bdd = createBddApi(context);
      const authOrg = createAuthOrgBddApi(context);
      const api = createComputerUseBddApi(context);
      const owner = bdd.user({ orgRole: "org:admin" });
      const ownerOrgId = requireOrgId(owner);
      const noOrg = bdd.user({ orgId: null });
      const peer = bdd.user({ orgId: owner.orgId, orgRole: "org:member" });
      const outsider = bdd.user({ orgRole: "org:member" });

      const host = await api.startComputerUseHost(owner, {
        hostName: "Screenshot Owner Desktop",
      });
      const otherHost = await api.startComputerUseHost(owner, {
        hostName: "Screenshot Other Desktop",
      });

      const launcher = await createRunLauncher(context, owner);
      const wrongHostRun = await launcher.launch(otherHost.hostId);
      const unboundRun = await launcher.launch();
      const boundRun = await launcher.launch(host.hostId);

      const storage = api.installComputerUseS3Fake();
      const pat = await authOrg.createCliToken(owner);

      mockClerkMembership(context, owner, "org:admin");
      const { commandId } = await api.createComputerUseReadCommand(
        { bearer: boundRun.token },
        { kind: "app.state", app: "Safari" },
      );
      await api.claimNextComputerUseCommand(host.connection);
      const png = Buffer.concat([PNG_SIGNATURE, Buffer.alloc(48, 5)]);
      await api.completeComputerUseCommandWith(host.connection, commandId, {
        status: "succeeded",
        result: {
          snapshotId: "snap_content_get_1",
          screenshot: `data:image/png;base64,${png.toString("base64")}`,
          screenshotWidth: 1280,
          screenshotHeight: 720,
        },
      });
      expect(storage.puts).toHaveLength(1);

      const ownerMeta = await api.resolveComputerUseScreenshot(
        owner,
        commandId,
      );
      mockClerkMembership(context, owner, "org:admin");
      const patMeta = await api.resolveComputerUseScreenshot(
        { bearer: pat.token },
        commandId,
      );
      const boundMeta = await api.resolveComputerUseScreenshot(
        { bearer: boundRun.token },
        commandId,
      );

      const expectedKey = `computer-use/${ownerOrgId}/${owner.userId}/${commandId}/screenshot.png`;
      expect(ownerMeta).toStrictEqual({
        downloadUrl: expect.stringContaining(encodeURIComponent(expectedKey)),
        filename: "screenshot.png",
        contentType: "image/png",
        size: png.length,
        cacheControl: "private, no-store",
      });
      expect(patMeta).toStrictEqual(ownerMeta);
      expect(boundMeta).toStrictEqual(ownerMeta);

      const anonymous = await api.requestComputerUseScreenshot(
        null,
        commandId,
        [401],
      );
      expectApiError(anonymous.body);

      const withoutOrg = await api.requestComputerUseScreenshot(
        noOrg,
        commandId,
        [401],
      );
      expectApiError(withoutOrg.body);

      const expectedNotFound = {
        error: {
          code: "NOT_FOUND",
          message: "Computer-use command screenshot not found",
        },
      };
      const peerResponse = await api.requestComputerUseScreenshot(
        peer,
        commandId,
        [404],
      );
      expect(peerResponse.body).toStrictEqual(expectedNotFound);

      const outsiderResponse = await api.requestComputerUseScreenshot(
        outsider,
        commandId,
        [404],
      );
      expect(outsiderResponse.body).toStrictEqual(expectedNotFound);

      mockClerkMembership(context, owner, "org:admin");
      const wrongHostResponse = await api.requestComputerUseScreenshot(
        { bearer: wrongHostRun.token },
        commandId,
        [404],
      );
      expect(wrongHostResponse.body).toStrictEqual(expectedNotFound);

      const unboundResponse = await api.requestComputerUseScreenshot(
        { bearer: unboundRun.token },
        commandId,
        [403],
      );
      expectApiError(unboundResponse.body);

      await updateFeatureSwitchesForUser(
        context,
        { userId: owner.userId, orgId: ownerOrgId, orgRole: owner.orgRole },
        { [FeatureSwitchKey.RemoteDevices]: true },
      );

      mockClerkMembership(context, owner, "org:admin");
      const deniedByDevicePolicy = await api.requestComputerUseScreenshot(
        { bearer: boundRun.token },
        commandId,
        [404],
      );
      expect(deniedByDevicePolicy.body).toStrictEqual(expectedNotFound);

      const device = await findDesktopDevice(context, owner, host.hostId);
      expect(device).toMatchObject({ accessAllowed: false });
      await setDeviceAccess(context, owner, device.id, { mode: "always" });

      mockClerkMembership(context, owner, "org:admin");
      const admittedMeta = await api.resolveComputerUseScreenshot(
        { bearer: boundRun.token },
        commandId,
      );
      expect(admittedMeta).toStrictEqual(ownerMeta);
    },
  );
});
