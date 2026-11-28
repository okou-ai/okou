import { randomUUID } from "node:crypto";
import { remoteDevicesContract } from "@okouai/api-contracts/contracts/remote-devices";
import { runnerSshContract } from "@okouai/api-contracts/contracts/runner-ssh";
import { sshConnectionsContract } from "@okouai/api-contracts/contracts/ssh-connections";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { createStore } from "ccstate";
import { describe, expect, it } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { TEST_WITH_DOUBLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE } from "../../../__tests__/test-timeouts";
import { env, mockOptionalEnv } from "../../../lib/env";
import { clearMockNow, mockNow, now } from "../../../lib/time";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { remoteDevicesRoutes } from "../remote-devices";
import { runnerSshRoutes } from "../runner-ssh";
import { sshConnectionsRoutes } from "../ssh-connections";
import { createBddApi } from "./helpers/api-bdd";
import { createChatFilesBddApi } from "./helpers/api-bdd-chat-files";
import { createRunsApi } from "./helpers/api-bdd-runs";
import { deliverOrganizationCreated } from "./helpers/api-bdd-webhooks";
import { updateFeatureSwitchesForUser } from "./helpers/feature-switches";
import { seedOrgMembership$ } from "./helpers/org-membership";
import { createRouteMocks } from "./helpers/route-test";
import { useSecretKmsProbe } from "./helpers/secret-kms-probe";
import { inlineSshKey } from "./helpers/ssh-credential";

const context = testContext();
const store = createStore();
const headers = Object.freeze({ authorization: "Bearer clerk-session" });
const policyHeader = Object.freeze({ "X-Okou-Remote-Device-Policy": "1" });

const remoteDevicesApi = setupApp({
  context,
  routes: remoteDevicesRoutes,
})(remoteDevicesContract);

const sshConnectionsApi = setupApp({
  context,
  routes: sshConnectionsRoutes,
})(sshConnectionsContract);

const runnerSshApi = setupApp({
  context,
  routes: runnerSshRoutes,
})(runnerSshContract);

describe("SSH remote device channel management", () => {
  it("pf-134 attaches and moves an SSH channel without changing its identity or either device's access", async () => {
    useSecretKmsProbe();
    const owner = {
      orgId: `org_${randomUUID()}`,
      userId: `user_${randomUUID()}`,
      orgRole: "org:admin" as const,
    };
    await Promise.all([
      store.set(
        seedOrgMembership$,
        { orgId: owner.orgId, userId: owner.userId, role: "admin" },
        context.signal,
      ),
      updateFeatureSwitchesForUser(context, owner, {
        [FeatureSwitchKey.RemoteDevices]: true,
      }),
    ]);
    createRouteMocks(context).clerk.session(
      owner.userId,
      owner.orgId,
      owner.orgRole,
    );

    const sourceDeviceId = randomUUID();
    const targetDeviceId = randomUUID();
    await Promise.all([
      accept(
        remoteDevicesApi.create({
          headers,
          body: { id: sourceDeviceId, displayName: "Source Host" },
        }),
        [201],
      ),
      accept(
        remoteDevicesApi.create({
          headers,
          body: { id: targetDeviceId, displayName: "Target Host" },
        }),
        [201],
      ),
    ]);
    await accept(
      remoteDevicesApi.setAccess({
        headers,
        params: { deviceId: sourceDeviceId },
        body: { mode: "always" },
      }),
      [200],
    );

    const channelId = randomUUID();
    const created = await accept(
      sshConnectionsApi.create({
        headers,
        body: {
          id: channelId,
          remoteDeviceId: sourceDeviceId,
          displayName: "Primary Bastion",
          host: "bastion.example.com",
          credential: inlineSshKey("ops", `key-${randomUUID()}`),
        },
      }),
      [201],
    );
    expect(created.body.id).toBe(channelId);

    await accept(
      remoteDevicesApi.moveChannel({
        headers,
        params: {
          deviceId: targetDeviceId,
          kind: "ssh",
          channelId,
        },
      }),
      [204],
    );

    const directory = await accept(remoteDevicesApi.list({ headers }), [200]);
    const source = directory.body.devices.find((device) => {
      return device.id === sourceDeviceId;
    });
    const target = directory.body.devices.find((device) => {
      return device.id === targetDeviceId;
    });
    expect(source).toMatchObject({
      id: sourceDeviceId,
      accessAllowed: true,
      accessExpiresAt: null,
      channels: [],
    });
    expect(target).toMatchObject({
      id: targetDeviceId,
      accessAllowed: false,
      accessExpiresAt: null,
    });
    expect(target?.channels).toContainEqual(
      expect.objectContaining({
        id: channelId,
        kind: "ssh",
        displayName: "Primary Bastion",
      }),
    );
  });

  it("pf-150 deletes an owned device and its SSH channel and rejects new attachments", async () => {
    useSecretKmsProbe();
    const owner = {
      orgId: `org_${randomUUID()}`,
      userId: `user_${randomUUID()}`,
      orgRole: "org:admin" as const,
    };
    await Promise.all([
      store.set(
        seedOrgMembership$,
        { orgId: owner.orgId, userId: owner.userId, role: "admin" },
        context.signal,
      ),
      updateFeatureSwitchesForUser(context, owner, {
        [FeatureSwitchKey.RemoteDevices]: true,
      }),
    ]);
    createRouteMocks(context).clerk.session(
      owner.userId,
      owner.orgId,
      owner.orgRole,
    );

    const deviceId = randomUUID();
    await accept(
      remoteDevicesApi.create({
        headers,
        body: { id: deviceId, displayName: "Decommissioned Host" },
      }),
      [201],
    );

    const channelId = randomUUID();
    await accept(
      sshConnectionsApi.create({
        headers,
        body: {
          id: channelId,
          remoteDeviceId: deviceId,
          displayName: "Retired SSH",
          host: "retired.example.com",
          credential: inlineSshKey("ops", `key-${randomUUID()}`),
        },
      }),
      [201],
    );

    await accept(
      remoteDevicesApi.delete({ headers, params: { deviceId } }),
      [204],
    );

    const [directory, sshList, secondDelete, attachAfterDelete] =
      await Promise.all([
        accept(remoteDevicesApi.list({ headers }), [200]),
        accept(sshConnectionsApi.list({ headers }), [200]),
        accept(
          remoteDevicesApi.delete({ headers, params: { deviceId } }),
          [404],
        ),
        accept(
          sshConnectionsApi.create({
            headers,
            body: {
              id: randomUUID(),
              remoteDeviceId: deviceId,
              displayName: "Late Attachment",
              host: "late.example.com",
              credential: inlineSshKey("ops", `key-${randomUUID()}`),
            },
          }),
          [404],
        ),
      ]);

    expect(
      directory.body.devices.some((device) => {
        return device.id === deviceId;
      }),
    ).toBeFalsy();
    expect(sshList.body.connections).toStrictEqual([]);
    expect(secondDelete.status).toBe(404);
    expect(attachAfterDelete.status).toBe(404);
  });

  it(
    "pf-135 admits a running SSH client on approval and distinguishes changed configuration from expiry",
    { timeout: TEST_WITH_DOUBLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
    async () => {
      useSecretKmsProbe();
      const bdd = createBddApi(context);
      const runs = createRunsApi(context);
      const chats = createChatFilesBddApi(context);
      bdd.acceptStorageWrites();
      runs.acceptStorageDownloads();
      runs.acceptTelemetryIngest();
      mockOptionalEnv("OPENROUTER_API_KEY", "bdd-issued-credential-key");
      const actor = bdd.user({ orgRole: "org:admin" });
      if (!actor.orgId) {
        throw new Error("Expected an organization owner");
      }
      const owner = {
        orgId: actor.orgId,
        userId: actor.userId,
        orgRole: "org:admin" as const,
      };
      const [runnerGroup] = await Promise.all([
        runs.configureRunnerGroup(),
        deliverOrganizationCreated(context, actor),
        store.set(
          seedOrgMembership$,
          { orgId: owner.orgId, userId: owner.userId, role: "admin" },
          context.signal,
        ),
        updateFeatureSwitchesForUser(context, owner, {
          [FeatureSwitchKey.RemoteDevices]: true,
        }),
      ]);
      createRouteMocks(context).clerk.session(
        owner.userId,
        owner.orgId,
        owner.orgRole,
      );

      const deviceId = randomUUID();
      const connectionId = randomUUID();
      await accept(
        remoteDevicesApi.create({
          headers,
          body: { id: deviceId, displayName: "Production Bastion" },
        }),
        [201],
      );
      const [created, sent] = await Promise.all([
        accept(
          sshConnectionsApi.create({
            headers,
            body: {
              id: connectionId,
              remoteDeviceId: deviceId,
              displayName: "Bastion SSH",
              host: "bastion.example.com",
              credential: inlineSshKey("ops", `key-${randomUUID()}`),
            },
          }),
          [201],
        ),
        chats.requestSendEvent(
          actor,
          {
            prompt: "Use my configured SSH host",
            clientEventId: randomUUID(),
            model: null,
          },
          [201],
        ),
      ]);
      await flushWaitUntilForTest();
      const dispatch = runs.receivedDispatches(runnerGroup).at(-1);
      const agentToken =
        dispatch?.executionContext.platformEnvironment.OKOU_TOKEN;
      if (!dispatch || !agentToken || !("threadId" in sent.body)) {
        throw new Error("Expected a dispatched active Run");
      }
      const runId = dispatch.executionContext.runId;
      const threadId = sent.body.threadId;
      const runnerIdentity = {
        runnerId: dispatch.runnerId,
        heartbeatGeneration: dispatch.heartbeatGeneration,
      };
      const runnerHeaders = {
        authorization: `Bearer vm0_official_${env("OFFICIAL_RUNNER_SECRET")}`,
      };
      const runHeaders = { authorization: `Bearer ${agentToken}` };

      const beforeApproval = await accept(
        runnerSshApi.resolve({
          headers: runnerHeaders,
          extraHeaders: policyHeader,
          params: { runId },
          body: { connectionId, runnerIdentity },
        }),
        [200],
      );
      expect(beforeApproval.body).toStrictEqual({ outcome: "unavailable" });

      context.mocks.clerk.authenticateRequest.mockResolvedValue({
        isAuthenticated: false,
      });
      const discovered = await accept(
        remoteDevicesApi.listForRun({ headers: runHeaders }),
        [200],
      );
      expect(discovered.body.chatThreadId).toBe(threadId);
      expect(discovered.body.devices).toContainEqual(
        expect.objectContaining({
          id: deviceId,
          accessAllowed: false,
          channels: [
            expect.objectContaining({ id: connectionId, kind: "ssh" }),
          ],
        }),
      );

      const approvedAt = now();
      mockNow(approvedAt);
      createRouteMocks(context).clerk.session(
        owner.userId,
        owner.orgId,
        owner.orgRole,
      );
      const approved = await accept(
        remoteDevicesApi.approve({
          headers,
          params: { threadId },
          body: { deviceId },
        }),
        [200],
      );
      expect(approved.body).toMatchObject({
        id: deviceId,
        accessAllowed: true,
        accessExpiresAt: expect.any(String),
      });

      const [legacyRunner, resolved] = await Promise.all([
        accept(
          runnerSshApi.resolve({
            headers: runnerHeaders,
            params: { runId },
            body: { connectionId, runnerIdentity },
          }),
          [200],
        ),
        accept(
          runnerSshApi.resolve({
            headers: runnerHeaders,
            extraHeaders: policyHeader,
            params: { runId },
            body: { connectionId, runnerIdentity },
          }),
          [200],
        ),
      ]);
      expect(legacyRunner.body).toStrictEqual({ outcome: "unavailable" });
      expect(resolved.headers.get("x-okou-remote-device-policy")).toBe("1");
      const createdAt = resolved.headers.get("x-ssh-connection-created-at");
      if (!createdAt || resolved.body.outcome !== "resolved") {
        throw new Error("Expected a resolved SSH connection with createdAt");
      }
      expect(resolved.body).toMatchObject({
        outcome: "resolved",
        host: "bastion.example.com",
        username: "ops",
        generation: created.body.generation,
      });

      const validCheck = await accept(
        runnerSshApi.check({
          headers: runnerHeaders,
          extraHeaders: policyHeader,
          params: { runId },
          body: {
            connectionId,
            runnerIdentity,
            expectedGeneration: resolved.body.generation,
            expectedCreatedAt: createdAt,
          },
        }),
        [200],
      );
      expect(validCheck.body).toStrictEqual({ outcome: "valid" });

      const updated = await accept(
        sshConnectionsApi.update({
          headers,
          params: { connectionId },
          body: {
            expectedGeneration: resolved.body.generation,
            host: "bastion-v2.example.com",
          },
        }),
        [200],
      );
      expect(updated.body.generation).toBe(resolved.body.generation + 1);

      const [changedCheck, refreshedCheck] = await Promise.all([
        accept(
          runnerSshApi.check({
            headers: runnerHeaders,
            extraHeaders: policyHeader,
            params: { runId },
            body: {
              connectionId,
              runnerIdentity,
              expectedGeneration: resolved.body.generation,
              expectedCreatedAt: createdAt,
            },
          }),
          [200],
        ),
        accept(
          runnerSshApi.check({
            headers: runnerHeaders,
            extraHeaders: policyHeader,
            params: { runId },
            body: {
              connectionId,
              runnerIdentity,
              expectedGeneration: updated.body.generation,
              expectedCreatedAt: createdAt,
            },
          }),
          [200],
        ),
      ]);
      expect(changedCheck.body).toStrictEqual({
        outcome: "configuration_changed",
      });
      expect(refreshedCheck.body).toStrictEqual({ outcome: "valid" });

      mockNow(approvedAt + 60 * 60_000 + 1000);
      const [expiredCheck, expiredResolve] = await Promise.all([
        accept(
          runnerSshApi.check({
            headers: runnerHeaders,
            extraHeaders: policyHeader,
            params: { runId },
            body: {
              connectionId,
              runnerIdentity,
              expectedGeneration: updated.body.generation,
              expectedCreatedAt: createdAt,
            },
          }),
          [200],
        ),
        accept(
          runnerSshApi.resolve({
            headers: runnerHeaders,
            extraHeaders: policyHeader,
            params: { runId },
            body: { connectionId, runnerIdentity },
          }),
          [200],
        ),
      ]);
      expect(expiredCheck.body).toStrictEqual({ outcome: "unavailable" });
      expect(expiredResolve.body).toStrictEqual({ outcome: "unavailable" });

      clearMockNow();
    },
  );
});
