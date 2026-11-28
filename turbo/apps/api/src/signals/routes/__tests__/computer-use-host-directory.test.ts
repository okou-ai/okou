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
import { TEST_WITH_SINGLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE } from "../../../__tests__/test-timeouts";
import { mockOptionalEnv } from "../../../lib/env";
import { mockNow, nowDate } from "../../../lib/time";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { remoteDevicesRoutes } from "../remote-devices";
import { createBddApi, type ApiTestUser } from "./helpers/api-bdd";
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

describe("standalone Computer Use host directory", () => {
  it("computer-use-host-directory-002 returns the complete ordered online, stale and stopped-installation directory without foreign hosts", async () => {
    const start = Date.parse("2026-02-01T12:00:00.000Z");
    mockNow(start);
    const bdd = createBddApi(context);
    const api = createComputerUseBddApi(context);
    const member = bdd.user({ orgRole: "org:member" });
    const peer = bdd.user({ orgId: member.orgId, orgRole: "org:member" });
    const foreign = bdd.user({ orgRole: "org:member" });

    const stale = await api.startComputerUseHost(member, {
      hostName: "Stale Desktop",
    });

    mockNow(start + 1000);
    const stopped = await api.startComputerUseHost(member, {
      hostName: "Stopped Desktop",
    });
    await api.stopComputerUseHost(stopped.connection);

    mockNow(start + 2000);
    const currentCreatedAt = nowDate().toISOString();
    const currentOptions = {
      hostName: "Current Desktop",
      appVersion: "0.52.1",
      osVersion: "macOS 15",
      supportedCapabilities: ["apps.list", "element.click"],
      permissions: { accessibility: true, screenRecording: false },
    };
    const current = await api.startComputerUseHost(member, currentOptions);

    await api.startComputerUseHost(peer, { hostName: "Peer Desktop" });
    await api.startComputerUseHost(foreign, { hostName: "Foreign Desktop" });

    mockNow(start + 120_000);
    const currentLastSeenAt = nowDate().toISOString();
    await api.heartbeatComputerUseHost(current.connection, currentOptions);

    const publishedBeforeRead = context.mocks.ably.publish.mock.calls.length;
    const batchedBeforeRead = context.mocks.ably.batchPublish.mock.calls.length;

    const directory = await api.listComputerUseHosts(member);

    expect(
      directory.hosts.map((host) => {
        return { id: host.id, status: host.status };
      }),
    ).toStrictEqual([
      { id: current.hostId, status: "online" },
      { id: stopped.hostId, status: "offline" },
      { id: stale.hostId, status: "offline" },
    ]);
    expect(directory.hosts[0]).toStrictEqual({
      id: current.hostId,
      hostName: "Current Desktop",
      displayName: "Current Desktop",
      appVersion: "0.52.1",
      osVersion: "macOS 15",
      supportedCapabilities: ["apps.list", "element.click"],
      permissions: {
        accessibility: true,
        screenRecording: false,
        automation: {
          chrome: { status: "unknown", updatedAt: null, reason: null },
          safari: { status: "unknown", updatedAt: null, reason: null },
        },
      },
      status: "online",
      lastSeenAt: currentLastSeenAt,
      createdAt: currentCreatedAt,
    });
    expect(
      context.mocks.ably.publish.mock.calls.slice(publishedBeforeRead),
    ).toStrictEqual([]);
    expect(
      context.mocks.ably.batchPublish.mock.calls.slice(batchedBeforeRead),
    ).toStrictEqual([]);
  });

  it(
    "computer-use-host-directory-003 keeps actual claimed Agent discovery bound to its selected host after that host stops and enforces device policy",
    { timeout: TEST_WITH_SINGLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
    async () => {
      const bdd = createBddApi(context);
      const runs = createRunsApi(context);
      const chat = createChatFilesBddApi(context);
      const api = createComputerUseBddApi(context);
      const member = bdd.user({ orgRole: "org:member" });
      if (!member.orgId) {
        throw new Error("Expected an organization member");
      }
      const memberOrgId = member.orgId;

      await api.startComputerUseHost(member, {
        hostName: "Other Online Desktop",
      });
      const boundHost = await api.startComputerUseHost(member, {
        hostName: "Bound Offline Desktop",
      });

      bdd.acceptStorageWrites();
      runs.acceptStorageDownloads();
      runs.acceptTelemetryIngest();
      mockOptionalEnv("OPENROUTER_API_KEY", "bdd-issued-credential-key");
      const [, runnerGroup] = await Promise.all([
        deliverOrganizationCreated(context, member),
        runs.configureRunnerGroup(),
      ]);

      const sent = await chat.requestSendEvent(
        member,
        {
          prompt: "Discover my selected desktop",
          model: null,
          clientEventId: randomUUID(),
          computerUseHostId: boundHost.hostId,
        },
        [201],
      );
      if (sent.status !== 201) {
        throw new Error("Expected an accepted chat send");
      }
      await flushWaitUntilForTest();
      const dispatch = runs.receivedDispatches(runnerGroup).at(-1);
      const agentToken =
        dispatch?.executionContext.platformEnvironment.OKOU_TOKEN;
      if (!dispatch || !agentToken) {
        throw new Error("Expected a dispatched Run with OKOU_TOKEN");
      }
      const runId = dispatch.executionContext.runId;
      const sandboxToken = dispatch.executionContext.sandboxToken;
      onTestFinished(async () => {
        await runs.requestCancelRun(member, runId, [200, 400]);
        await createWebhookCallbackApi(context).requestAgentComplete(
          { runId, exitCode: 1, error: "Run cancelled" },
          { authorization: `Bearer ${sandboxToken}` },
          [200, 400],
        );
        await flushWaitUntilForTest();
      });

      await api.stopComputerUseHost(boundHost.connection);

      mockClerkMembership(context, member, "org:member");
      const directory = await api.listComputerUseHosts({ bearer: agentToken });
      expect(directory.hosts).toStrictEqual([
        expect.objectContaining({
          id: boundHost.hostId,
          displayName: "Bound Offline Desktop",
          status: "offline",
        }),
      ]);
      expect(JSON.stringify(directory)).not.toContain("Other Online Desktop");

      await updateFeatureSwitchesForUser(
        context,
        { userId: member.userId, orgId: memberOrgId, orgRole: member.orgRole },
        { [FeatureSwitchKey.RemoteDevices]: true },
      );

      mockClerkMembership(context, member, "org:member");
      await expect(
        api.listComputerUseHosts({ bearer: agentToken }),
      ).resolves.toStrictEqual({ hosts: [] });

      const device = await findDesktopDevice(context, member, boundHost.hostId);
      expect(device).toMatchObject({ accessAllowed: false });
      await setDeviceAccess(context, member, device.id, { mode: "always" });

      mockClerkMembership(context, member, "org:member");
      const allowedDirectory = await api.listComputerUseHosts({
        bearer: agentToken,
      });
      expect(allowedDirectory.hosts).toStrictEqual([
        expect.objectContaining({
          id: boundHost.hostId,
          displayName: "Bound Offline Desktop",
          status: "offline",
        }),
      ]);
      expect(JSON.stringify(allowedDirectory)).not.toContain(
        "Other Online Desktop",
      );
    },
  );
});
