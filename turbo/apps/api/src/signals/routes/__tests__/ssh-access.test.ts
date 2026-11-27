import { randomUUID } from "node:crypto";
import { remoteDevicesContract } from "@okouai/api-contracts/contracts/remote-devices";
import { sshConnectionsContract } from "@okouai/api-contracts/contracts/ssh-connections";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { createStore } from "ccstate";
import { describe, expect, it } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { remoteDevicesRoutes } from "../remote-devices";
import { sshConnectionsRoutes } from "../ssh-connections";
import { updateFeatureSwitchesForUser } from "./helpers/feature-switches";
import { seedOrgMembership$ } from "./helpers/org-membership";
import { createRouteMocks } from "./helpers/route-test";
import { useSecretKmsProbe } from "./helpers/secret-kms-probe";
import { inlineSshKey } from "./helpers/ssh-credential";

const context = testContext();
const store = createStore();
const headers = Object.freeze({ authorization: "Bearer clerk-session" });

const remoteDevicesApi = setupApp({
  context,
  routes: remoteDevicesRoutes,
})(remoteDevicesContract);

const sshConnectionsApi = setupApp({
  context,
  routes: sshConnectionsRoutes,
})(sshConnectionsContract);

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
});
