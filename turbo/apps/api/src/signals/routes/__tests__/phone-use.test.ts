import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { chatThreadsContract } from "@okouai/api-contracts/contracts/chat-threads";
import { featureSwitchesContract } from "@okouai/api-contracts/contracts/feature-switches";
import { phoneUseContract } from "@okouai/api-contracts/contracts/phone-use";
import { remoteDevicesContract } from "@okouai/api-contracts/contracts/remote-devices";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { TEST_WITH_DOUBLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE } from "../../../__tests__/test-timeouts";
import { mockOptionalEnv } from "../../../lib/env";
import { mockNow, now } from "../../../lib/time";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { chatThreadCreateRoutes } from "../chat-threads-create";
import { featureSwitchesRoutes } from "../feature-switches";
import { phoneUseRoutes } from "../phone-use";
import { remoteDevicesRoutes } from "../remote-devices";
import { createBddApi } from "./helpers/api-bdd";
import { createChatFilesBddApi } from "./helpers/api-bdd-chat-files";
import { createRunsApi } from "./helpers/api-bdd-runs";
import { deliverOrganizationCreated } from "./helpers/api-bdd-webhooks";

const context = testContext();

// This test tenant shares a staff-org identity hash, so staff-only gates run for real.
const STAFF_ORG_ID = "org_usage_pack_checkout_test_lgD7Q3";
const headers = Object.freeze({ authorization: "Bearer clerk-session" });

interface PhoneUser {
  readonly userId: string;
  readonly orgId: string;
  readonly sessionId: string;
}

function phoneUser(orgId = `org_${randomUUID()}`): PhoneUser {
  const userId = `user_${randomUUID()}`;
  return { userId, orgId, sessionId: `sess_${randomUUID()}` };
}

/** Signs the user in through Clerk with the native app's session. */
function nativeSession(
  user: PhoneUser,
  status: "active" | "revoked" = "active",
): void {
  context.mocks.clerk.authenticateRequest.mockResolvedValue({
    isAuthenticated: true,
    toAuth: () => {
      return {
        userId: user.userId,
        orgId: user.orgId,
        orgRole: "org:member",
        sessionId: user.sessionId,
      };
    },
  });
  context.mocks.clerk.sessions.getSession.mockResolvedValue({
    id: user.sessionId,
    userId: user.userId,
    status,
  });
  context.mocks.clerk.organizations.getOrganizationMembershipList.mockResolvedValue(
    {
      data: [
        {
          organization: { id: user.orgId },
          publicUserData: { userId: user.userId },
          role: "org:member",
        },
      ],
      totalCount: 1,
    },
  );
}

/** Signs the user in from the browser; the phone keeps its own native session. */
function webSession(user: PhoneUser): void {
  context.mocks.clerk.authenticateRequest.mockResolvedValue({
    isAuthenticated: true,
    toAuth: () => {
      return {
        userId: user.userId,
        orgId: user.orgId,
        orgRole: "org:member",
        sessionId: `sess_web_${user.userId}`,
      };
    },
  });
}

async function ownedThread(user: PhoneUser): Promise<string> {
  webSession(user);
  const thread = await accept(
    setupApp({ context, routes: chatThreadCreateRoutes })(
      chatThreadsContract,
    ).create({ headers, body: { model: null } }),
    [201],
  );
  return thread.body.id;
}

function phoneUseApi() {
  return setupApp({ context, routes: phoneUseRoutes })(phoneUseContract);
}

function featureSwitchesApi() {
  return setupApp({ context, routes: featureSwitchesRoutes })(
    featureSwitchesContract,
  );
}

async function setPhoneUse(user: PhoneUser, enabled: boolean) {
  webSession(user);
  const response = await accept(
    featureSwitchesApi().update({
      headers,
      body: { switches: { [FeatureSwitchKey.PhoneUse]: enabled } },
    }),
    [200],
  );
  return response.body.effectiveSwitches;
}

function registration(installationId: string) {
  return phoneUseApi().register({
    headers,
    body: {
      installationId,
      displayName: "Test iPhone",
      osVersion: "27.1",
      appVersion: "1",
      protocolVersion: 1,
    },
  });
}

async function registeredPhone(user: PhoneUser) {
  await setPhoneUse(user, true);
  nativeSession(user);
  const installationId = randomUUID();
  const device = await accept(registration(installationId), [200]);
  return { installationId, device: device.body };
}

async function listDevices() {
  const response = await accept(phoneUseApi().devices({ headers }), [200]);
  return response.body.devices;
}

describe("Phone Use native connection authority", () => {
  it("phone-use-006 hides a phone from another account and refuses its disconnect", async () => {
    const owner = phoneUser();
    const { device } = await registeredPhone(owner);
    const other = phoneUser(owner.orgId);
    await setPhoneUse(other, true);
    nativeSession(other);

    await expect(listDevices()).resolves.toStrictEqual([]);
    await accept(
      phoneUseApi().disconnect({
        headers,
        params: { deviceId: device.id },
        body: { generation: device.generation },
      }),
      [409],
    );
  });

  it("phone-use-002 reports a phone online only while it is ready and present", async () => {
    const user = phoneUser();
    const startedAt = Date.parse("2026-04-01T08:00:00.000Z");
    mockNow(startedAt);
    const { installationId, device } = await registeredPhone(user);
    const authority = { generation: device.generation };
    context.mocks.ably.createTokenRequest.mockResolvedValue({
      keyName: "test.key",
      timestamp: startedAt,
      capability: "{}",
      clientId: user.userId,
      nonce: randomUUID(),
      mac: "test-mac",
    });
    const realtime = await accept(
      phoneUseApi().realtime({
        headers,
        params: { deviceId: device.id },
        body: authority,
      }),
      [200],
    );
    let present = true;
    context.mocks.ably.presenceGet.mockImplementation(
      (channelName: unknown) => {
        return Promise.resolve({
          items:
            present && channelName === realtime.body.channel
              ? [{ clientId: user.userId }]
              : [],
        });
      },
    );
    async function readyHeartbeat() {
      await accept(
        phoneUseApi().heartbeat({
          headers,
          params: { deviceId: device.id },
          body: { ...authority, ready: true },
        }),
        [200],
      );
    }

    mockNow(startedAt + 2 * 60_000);
    await expect(listDevices()).resolves.toMatchObject([
      { id: device.id, online: false },
    ]);
    await readyHeartbeat();
    await expect(listDevices()).resolves.toMatchObject([
      { id: device.id, online: true },
    ]);

    mockNow(startedAt + 2 * 60_000 + 45_001);
    await expect(listDevices()).resolves.toMatchObject([
      { id: device.id, online: false },
    ]);
    await readyHeartbeat();
    present = false;
    await expect(listDevices()).resolves.toMatchObject([
      { id: device.id, online: false },
    ]);

    present = true;
    const replaced = await accept(registration(installationId), [200]);
    expect(replaced.body).toMatchObject({
      id: device.id,
      generation: device.generation + 1,
      online: false,
    });
  });

  it("phone-use-007 requires opt-in and a live native session in a staff organization", async () => {
    const user = phoneUser(STAFF_ORG_ID);
    nativeSession(user);
    const switches = await accept(featureSwitchesApi().get({ headers }), [200]);
    expect(switches.body.effectiveSwitches).toMatchObject({
      [FeatureSwitchKey.PhoneUse]: false,
    });
    const installationId = randomUUID();
    const refused = await accept(registration(installationId), [403]);
    expect(refused.body.error.message).toContain("disabled");

    await expect(setPhoneUse(user, true)).resolves.toMatchObject({
      [FeatureSwitchKey.PhoneUse]: true,
    });
    nativeSession(user);
    const device = await accept(registration(installationId), [200]);

    await expect(setPhoneUse(user, false)).resolves.toMatchObject({
      [FeatureSwitchKey.PhoneUse]: false,
    });
    nativeSession(user);
    await accept(phoneUseApi().devices({ headers }), [403]);
    await accept(
      phoneUseApi().disconnect({
        headers,
        params: { deviceId: device.body.id },
        body: { generation: device.body.generation },
      }),
      [200],
    );

    await setPhoneUse(user, true);
    nativeSession(user, "revoked");
    await accept(registration(installationId), [403]);
  });
});

describe("Phone Use chat consent", () => {
  it("phone-use-009 keeps chat consent owner-scoped and revocable without native readiness", async () => {
    const owner = phoneUser();
    const threadId = await ownedThread(owner);
    const { device } = await registeredPhone(owner);
    const other = phoneUser(owner.orgId);
    await setPhoneUse(other, true);
    function grant(generation: number, allow: boolean) {
      return phoneUseApi().grant({
        headers,
        body: { deviceId: device.id, threadId, generation, allow },
      });
    }
    function readGrant() {
      return phoneUseApi().chatGrant({ headers, params: { threadId } });
    }

    webSession(owner);
    await accept(grant(device.generation + 1, true), [404]);
    await accept(grant(device.generation, true), [200]);
    const granted = await accept(readGrant(), [200]);
    expect(granted.body.selection).toStrictEqual({
      deviceId: device.id,
      generation: device.generation,
    });

    webSession(other);
    await accept(readGrant(), [404]);
    await accept(grant(device.generation, true), [404]);

    nativeSession(owner, "revoked");
    webSession(owner);
    await accept(grant(device.generation, true), [403]);
    await setPhoneUse(owner, false);
    webSession(owner);
    await accept(grant(device.generation, false), [200]);
    const revoked = await accept(readGrant(), [200]);
    expect(revoked.body.selection).toBeNull();
  });

  it(
    "pf-112 admits the current Run after device approval and checks the policy again at native claim",
    { timeout: TEST_WITH_DOUBLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
    async () => {
      const owner = phoneUser();
      const bdd = createBddApi(context);
      const runs = createRunsApi(context);
      const chats = createChatFilesBddApi(context);
      const actor = bdd.user({
        userId: owner.userId,
        orgId: owner.orgId,
        orgRole: "org:admin",
      });
      bdd.acceptStorageWrites();
      runs.acceptStorageDownloads();
      runs.acceptTelemetryIngest();
      mockOptionalEnv("OPENROUTER_API_KEY", "bdd-issued-credential-key");
      const remoteDevicesApi = setupApp({
        context,
        routes: remoteDevicesRoutes,
      })(remoteDevicesContract);

      nativeSession(owner);
      const [runnerGroup] = await Promise.all([
        runs.configureRunnerGroup(),
        deliverOrganizationCreated(context, actor),
        accept(
          featureSwitchesApi().update({
            headers,
            body: {
              switches: {
                [FeatureSwitchKey.PhoneUse]: true,
                [FeatureSwitchKey.RemoteDevices]: true,
              },
            },
          }),
          [200],
        ),
      ]);

      const installationId = randomUUID();
      const registered = await accept(registration(installationId), [200]);
      const device = registered.body;
      const [, directory] = await Promise.all([
        accept(
          phoneUseApi().heartbeat({
            headers,
            params: { deviceId: device.id },
            body: { generation: device.generation, ready: true },
          }),
          [200],
        ),
        accept(remoteDevicesApi.list({ headers }), [200]),
      ]);
      const remoteDevice = directory.body.devices.find((entry) => {
        return entry.channels.some((channel) => {
          return channel.kind === "ios" && channel.id === device.id;
        });
      });
      if (!remoteDevice) {
        throw new Error("Expected registered phone to publish a remote device");
      }
      expect(remoteDevice.accessAllowed).toBeFalsy();

      const sent = await chats.requestSendEvent(
        actor,
        { prompt: "Use my iPhone", clientEventId: randomUUID(), model: null },
        [201],
      );
      await flushWaitUntilForTest();
      const dispatch = runs.receivedDispatches(runnerGroup).at(-1);
      const agentToken =
        dispatch?.executionContext.platformEnvironment.OKOU_TOKEN;
      if (!dispatch || !agentToken || !("threadId" in sent.body)) {
        throw new Error("Expected a dispatched active Run");
      }
      const runId = dispatch.executionContext.runId;
      const threadId = sent.body.threadId;
      const agentHeaders = { authorization: `Bearer ${agentToken}` };
      context.mocks.ably.publish.mockResolvedValue(undefined);
      context.mocks.ably.presenceGet.mockResolvedValue({
        items: [{ clientId: owner.userId }],
      });
      context.mocks.ably.createTokenRequest.mockResolvedValue({
        keyName: "test.key",
        timestamp: now(),
        capability: "{}",
        clientId: owner.userId,
        nonce: randomUUID(),
        mac: "test-mac",
      });

      nativeSession(owner);
      context.mocks.clerk.authenticateRequest.mockResolvedValue({
        isAuthenticated: false,
      });
      const [hiddenDevices, deniedCreate] = await Promise.all([
        accept(phoneUseApi().devices({ headers: agentHeaders }), [200]),
        accept(
          phoneUseApi().create({
            headers: agentHeaders,
            body: {
              id: randomUUID(),
              deviceId: device.id,
              action: { kind: "observe" },
            },
          }),
          [403],
        ),
      ]);
      expect(hiddenDevices.body.devices).toStrictEqual([]);
      expect(deniedCreate.body.error.message).toContain("current access");

      webSession(owner);
      const approved = await accept(
        remoteDevicesApi.approve({
          headers,
          params: { threadId },
          body: { deviceId: remoteDevice.id },
        }),
        [200],
      );
      expect(approved.body).toMatchObject({
        id: remoteDevice.id,
        accessAllowed: true,
        accessExpiresAt: expect.any(String),
      });

      context.mocks.clerk.authenticateRequest.mockResolvedValue({
        isAuthenticated: false,
      });
      const operationId = randomUUID();
      const [visibleDevices, queued] = await Promise.all([
        accept(phoneUseApi().devices({ headers: agentHeaders }), [200]),
        accept(
          phoneUseApi().create({
            headers: agentHeaders,
            body: {
              id: operationId,
              deviceId: device.id,
              action: { kind: "observe" },
            },
          }),
          [200],
        ),
      ]);
      expect(visibleDevices.body.devices).toMatchObject([
        { id: device.id, generation: device.generation, online: true },
      ]);
      expect(queued.body).toMatchObject({
        id: operationId,
        deviceId: device.id,
        runId,
        grantId: device.id,
        status: "queued",
      });

      webSession(owner);
      await accept(
        remoteDevicesApi.setAccess({
          headers,
          params: { deviceId: remoteDevice.id },
          body: { mode: "denied" },
        }),
        [200],
      );

      nativeSession(owner);
      const blockedClaim = await accept(
        phoneUseApi().next({
          headers,
          params: { deviceId: device.id },
          body: { generation: device.generation },
        }),
        [200],
      );
      expect(blockedClaim.body.operation).toBeNull();

      webSession(owner);
      await accept(
        remoteDevicesApi.setAccess({
          headers,
          params: { deviceId: remoteDevice.id },
          body: { mode: "always" },
        }),
        [200],
      );

      nativeSession(owner);
      const claimed = await accept(
        phoneUseApi().next({
          headers,
          params: { deviceId: device.id },
          body: { generation: device.generation },
        }),
        [200],
      );
      expect(claimed.body.operation).toMatchObject({
        id: operationId,
        deviceId: device.id,
        runId,
        grantId: device.id,
        status: "running",
      });

      webSession(owner);
      await accept(
        remoteDevicesApi.setAccess({
          headers,
          params: { deviceId: remoteDevice.id },
          body: { mode: "denied" },
        }),
        [200],
      );
      nativeSession(owner);
      await accept(
        phoneUseApi().validate({
          headers,
          params: { deviceId: device.id },
          body: { generation: device.generation, operationId },
        }),
        [403],
      );

      webSession(owner);
      await accept(
        remoteDevicesApi.setAccess({
          headers,
          params: { deviceId: remoteDevice.id },
          body: { mode: "always" },
        }),
        [200],
      );
      nativeSession(owner);
      const replaced = await accept(registration(installationId), [200]);
      expect(replaced.body.generation).toBe(device.generation + 1);
      await accept(
        phoneUseApi().validate({
          headers,
          params: { deviceId: device.id },
          body: { generation: replaced.body.generation, operationId },
        }),
        [403],
      );
    },
  );
});
