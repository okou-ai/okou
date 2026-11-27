import { createSshExecutionApi } from "./helpers/ssh-execution";
import { inlineSshKey } from "./helpers/ssh-credential";
import { randomUUID } from "node:crypto";
import { sshHostsContract } from "@okouai/api-contracts/contracts/ssh-access";
import { sshConnectionsContract } from "@okouai/api-contracts/contracts/ssh-connections";
import { chatRemoteAccessContract } from "@okouai/api-contracts/contracts/chat-remote-access";
import { runnerSshContract } from "@okouai/api-contracts/contracts/runner-ssh";
import { remoteDevicesContract } from "@okouai/api-contracts/contracts/remote-devices";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { afterEach, describe, expect, it } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { mockNow, now, withMockNowForTest } from "../../../lib/time";
import { mockEnv } from "../../../lib/env";
import {
  generateSandboxToken,
  signSandboxJwtForTests,
} from "../../auth/tokens";
import { sshAccessRoutes } from "../ssh-access";
import { sshConnectionsRoutes } from "../ssh-connections";
import { runnerSshRoutes } from "../runner-ssh";
import { chatRemoteAccessRoutes } from "../chat-remote-access";
import { remoteDevicesRoutes } from "../remote-devices";
import { createRouteMocks } from "./helpers/route-test";
import { createBddApi } from "./helpers/api-bdd";
import { createChatFilesBddApi } from "./helpers/api-bdd-chat-files";
import { createWebhookCallbackApi } from "./helpers/api-bdd-webhooks";
import { createRunsApi } from "./helpers/api-bdd-runs";
import { createPublicRemoteAccessRunApi } from "./helpers/public-remote-access-run";
import { updateFeatureSwitchesForUser } from "./helpers/feature-switches";
import { flushWaitUntilForTest } from "../../context/wait-until";

const context = testContext();
const mocks = createRouteMocks(context);
const headers = Object.freeze({ authorization: "Bearer clerk-session" });
const inventory = () => {
  return setupApp({ context, routes: sshAccessRoutes })(sshHostsContract);
};
const config = () => {
  return setupApp({ context, routes: sshConnectionsRoutes })(
    sshConnectionsContract,
  );
};

function authenticate(owner: { userId: string; orgId: string }) {
  mocks.clerk.session(owner.userId, owner.orgId);
  context.mocks.clerk.users.getOrganizationMembershipList.mockResolvedValue({
    data: [
      {
        role: "org:member",
        organization: { id: owner.orgId },
        publicUserData: { userId: owner.userId },
      },
    ],
  });
}

describe("live chat SSH Run inventory", () => {
  const publicRuns = createPublicRemoteAccessRunApi(context);
  const ordinary = createSshExecutionApi(context, {
    runnerHeaders: { authorization: `Bearer vm0_official_${"c".repeat(64)}` },
    authenticate,
  });
  const executionCleanups: (() => Promise<void>)[] = [];

  afterEach(async () => {
    await publicRuns.cleanup();
    await ordinary.cleanup();
    for (const cleanup of executionCleanups.splice(0)) {
      await cleanup();
      await flushWaitUntilForTest();
    }
  });

  async function publicInventoryRun(
    owner = {
      userId: `user_ssh_${randomUUID()}`,
      orgId: `org_ssh_${randomUUID()}`,
    },
  ) {
    mockEnv("OFFICIAL_RUNNER_SECRET", "c".repeat(64));
    const run = await publicRuns.start(owner);
    const execution = await publicRuns.executionInput(run, {
      authorization: `Bearer vm0_official_${"c".repeat(64)}`,
    });
    authenticate(owner);
    return {
      ...execution,
      token: () => {
        return { authorization: `Bearer ${execution.agentToken}` };
      },
    };
  }

  async function executionFixture() {
    const bdd = createBddApi(context);
    const runs = createRunsApi(context);
    const actor = bdd.user();
    if (!actor.orgId) {
      throw new Error("Expected an SSH inventory owner organization");
    }
    const owner = { userId: actor.userId, orgId: actor.orgId };
    bdd.acceptStorageWrites();
    runs.acceptStorageDownloads();
    runs.acceptTelemetryIngest();
    const secret = "d".repeat(64);
    mockEnv("OFFICIAL_RUNNER_SECRET", secret);
    await runs.configureRunnerGroup({
      runnerIdentity: {
        runnerId: randomUUID(),
        heartbeatGeneration: 5_000_000_000,
      },
      heartbeatAuthorization: `Bearer vm0_official_${secret}`,
    });
    await runs.grantProEntitlement(actor);
    await runs.ensurePersonalSubscriptionModel(actor, {
      model: "claude-fable-5-1",
    });
    // Keep this owner host-free so first-host defaults remain the behavior under test.
    const { runId, threadId } = await runs.createThreadRun(actor, {
      prompt: "List my enabled SSH hosts",
    });
    const input = await runs.executionInput(runId);
    executionCleanups.push(async () => {
      await runs.requestCancelRun(actor, runId, [200]);
      await createWebhookCallbackApi(context).requestAgentComplete(
        { runId, exitCode: 137 },
        { authorization: `Bearer ${input.sandboxToken}` },
        [200],
      );
    });
    const agentToken = input.platformEnvironment.OKOU_TOKEN;
    if (!agentToken) {
      throw new Error("Expected the execution to issue its Agent token");
    }
    await expect(runs.readRun(actor, runId)).resolves.toMatchObject({
      status: "running",
    });
    await flushWaitUntilForTest();
    authenticate(owner);
    return {
      ...owner,
      runId,
      threadId,
      token: () => {
        return { authorization: `Bearer ${agentToken}` };
      },
    };
  }

  it("filters multiple SSH hosts by the Run's chat, current defaults, and sparse overrides", async () => {
    const f = await publicInventoryRun();
    const first = await createHost();
    const second = await createHost("second.example.com");
    if (!f.threadId) {
      throw new Error("Missing fixture chat thread");
    }
    const threadId = f.threadId;
    authenticate(f);
    const remote = setupApp({ context, routes: chatRemoteAccessRoutes })(
      chatRemoteAccessContract,
    );
    const listIds = async () => {
      return (
        await accept(inventory().list({ headers: f.token() }), [200])
      ).body.hosts.map((host) => {
        return host.id;
      });
    };
    await expect(listIds()).resolves.toStrictEqual([]);
    await accept(
      remote.updateHostDefault({
        headers,
        params: { protocol: "ssh", connectionId: second.body.id },
        body: { enabled: true },
      }),
      [200],
    );
    await expect(listIds()).resolves.toStrictEqual([second.body.id]);
    const otherThread = await publicInventoryRun(f);
    const otherThreadIds = async () => {
      return (
        await accept(inventory().list({ headers: otherThread.token() }), [200])
      ).body.hosts.map((host) => {
        return host.id;
      });
    };
    await expect(otherThreadIds()).resolves.toStrictEqual([second.body.id]);
    await accept(
      remote.setThreadOverride({
        headers,
        params: { threadId, protocol: "ssh", connectionId: first.body.id },
        body: { enabled: true },
      }),
      [200],
    );
    await expect(listIds()).resolves.toStrictEqual(
      [first.body.id, second.body.id].sort(),
    );
    await expect(otherThreadIds()).resolves.toStrictEqual([second.body.id]);
    await accept(
      remote.updateHostDefault({
        headers,
        params: { protocol: "ssh", connectionId: second.body.id },
        body: { enabled: false },
      }),
      [200],
    );
    await expect(listIds()).resolves.toStrictEqual([first.body.id]);
    await accept(
      remote.clearThreadOverride({
        headers,
        params: { threadId, protocol: "ssh", connectionId: first.body.id },
      }),
      [200],
    );
    await expect(listIds()).resolves.toStrictEqual([]);
  });

  it("returns creation identities from the same visible inventory and distinguishes recreated IDs", async () => {
    const f = await publicInventoryRun();
    const first = await createHost();
    await enableChatDefault(first.body.id);
    const diagnostic = await accept(
      inventory().list({ headers: f.token() }),
      [200],
    );
    expect(diagnostic.body.identities).toMatchObject([
      { id: first.body.id, generation: first.body.generation },
    ]);
    const originalIdentity = diagnostic.body.identities[0];
    expect(originalIdentity?.createdAt).toMatch(/\.\d{6}Z$/);
    expect(JSON.stringify(diagnostic.body)).not.toContain("test-private-key");
    await accept(
      config().delete({
        headers,
        params: { connectionId: first.body.id },
        body: { expectedGeneration: first.body.generation },
      }),
      [204],
    );
    const replacement = await accept(
      config().create({
        headers,
        body: {
          id: first.body.id,
          displayName: "Replacement",
          host: "replacement.example.com",
          credential: inlineSshKey("deploy", "replacement-private-key"),
        },
      }),
      [201],
    );
    const hidden = await accept(
      inventory().list({ headers: f.token() }),
      [200],
    );
    expect(hidden.body.identities).toStrictEqual([]);
    await enableChatDefault(replacement.body.id);
    const recreated = await accept(
      inventory().list({ headers: f.token() }),
      [200],
    );
    expect(recreated.body.identities[0]?.createdAt).not.toBe(
      originalIdentity?.createdAt,
    );
    expect(recreated.body.identities[0]?.id).toBe(first.body.id);
  });

  async function createHost(host = "ssh.example.com") {
    return await accept(
      config().create({
        headers,
        body: {
          id: randomUUID(),
          displayName: "Deployment",
          host,
          credential: inlineSshKey("deploy", "test-private-key"),
        },
      }),
      [201],
    );
  }

  async function enableChatDefault(connectionId: string) {
    const remote = setupApp({ context, routes: chatRemoteAccessRoutes })(
      chatRemoteAccessContract,
    );
    await accept(
      remote.updateHostDefault({
        headers,
        params: { protocol: "ssh", connectionId },
        body: { enabled: true },
      }),
      [200],
    );
  }

  it("deletes an owned device and its SSH channel and rejects new attachments", async () => {
    const f = await publicInventoryRun();
    const policy = setupApp({ context, routes: remoteDevicesRoutes })(
      remoteDevicesContract,
    );
    await updateFeatureSwitchesForUser(context, f, {
      [FeatureSwitchKey.RemoteDevices]: true,
    });
    authenticate(f);
    const deviceId = randomUUID();
    await accept(
      policy.create({
        headers,
        body: { id: deviceId, displayName: "Build machine" },
      }),
      [201],
    );
    const channelInput = {
      remoteDeviceId: deviceId,
      displayName: "Build login",
      host: "build.example.com",
      credential: inlineSshKey("deploy", "test-private-key"),
    };
    await accept(
      config().create({
        headers,
        body: { ...channelInput, id: randomUUID() },
      }),
      [201],
    );

    const other = { orgId: f.orgId, userId: `user_ssh_${randomUUID()}` };
    await updateFeatureSwitchesForUser(context, other, {
      [FeatureSwitchKey.RemoteDevices]: true,
    });
    authenticate(other);
    await accept(
      policy.delete({ headers, params: { deviceId }, body: undefined }),
      [404],
    );
    authenticate(f);
    await accept(
      policy.delete({ headers, params: { deviceId }, body: undefined }),
      [204],
    );
    const { body } = await accept(policy.list({ headers }), [200]);
    expect(body.devices).toStrictEqual([]);
    await accept(
      config().create({
        headers,
        body: { ...channelInput, id: randomUUID() },
      }),
      [404],
    );
  });

  it("attaches and moves a channel without changing its identity or either device's access", async () => {
    const f = await publicInventoryRun();
    const policy = setupApp({ context, routes: remoteDevicesRoutes })(
      remoteDevicesContract,
    );
    const original = { id: randomUUID(), displayName: "Build machine" };
    await accept(policy.create({ headers, body: original }), [404]);
    await accept(policy.listForRun({ headers: f.token() }), [404]);
    await updateFeatureSwitchesForUser(context, f, {
      [FeatureSwitchKey.RemoteDevices]: true,
    });
    authenticate(f);

    const { body: source } = await accept(
      policy.create({ headers, body: original }),
      [201],
    );
    expect(source).toMatchObject({
      ...original,
      accessAllowed: false,
      accessExpiresAt: null,
    });
    await accept(policy.create({ headers, body: original }), [200]);
    const destinationId = randomUUID();
    await accept(
      policy.create({
        headers,
        body: { id: destinationId, displayName: "Other machine" },
      }),
      [201],
    );
    await accept(
      policy.setAccess({
        headers,
        params: { deviceId: source.id },
        body: { mode: "always" },
      }),
      [200],
    );

    const { body: channel } = await accept(
      config().create({
        headers,
        body: {
          id: randomUUID(),
          remoteDeviceId: source.id,
          displayName: "Build login",
          host: "build.example.com",
          credential: inlineSshKey("deploy", "test-private-key"),
        },
      }),
      [201],
    );
    const { body: discovery } = await accept(
      policy.listForRun({ headers: f.token() }),
      [200],
    );
    expect(discovery).toMatchObject({
      chatThreadId: f.threadId,
      devices: [
        {
          id: source.id,
          channels: [
            { id: channel.id, kind: "ssh", displayName: "Build login" },
          ],
        },
      ],
    });
    expect(
      (await accept(inventory().list({ headers: f.token() }), [200])).body
        .hosts,
    ).toMatchObject([{ id: channel.id }]);

    const other = { orgId: f.orgId, userId: `user_ssh_${randomUUID()}` };
    await updateFeatureSwitchesForUser(context, other, {
      [FeatureSwitchKey.RemoteDevices]: true,
    });
    authenticate(other);
    const foreignId = randomUUID();
    await accept(
      policy.create({
        headers,
        body: { id: foreignId, displayName: "Different owner" },
      }),
      [201],
    );
    const move = (deviceId: string) => {
      return policy.moveChannel({
        headers,
        params: { deviceId, channelId: channel.id, kind: "ssh" },
        body: undefined,
      });
    };
    await accept(move(foreignId), [404]);
    authenticate(f);
    await accept(move(foreignId), [404]);
    await accept(move(destinationId), [204]);

    const { body: directory } = await accept(policy.list({ headers }), [200]);
    expect(directory.devices).toMatchObject([
      { id: source.id, accessAllowed: true, channels: [] },
      {
        id: destinationId,
        accessAllowed: false,
        channels: [{ id: channel.id, kind: "ssh" }],
      },
    ]);
    expect(
      (await accept(inventory().list({ headers: f.token() }), [200])).body
        .hosts,
    ).toStrictEqual([]);
    const { body: connections } = await accept(
      config().list({ headers }),
      [200],
    );
    expect(connections.connections).toStrictEqual([channel]);
  });

  it("admits a running SSH client on approval and distinguishes changed configuration from expiry", async () => {
    const f = await publicInventoryRun();
    const host = await createHost();
    await enableChatDefault(host.body.id);
    const policy = setupApp({ context, routes: remoteDevicesRoutes })(
      remoteDevicesContract,
    );
    expect(
      (await accept(policy.list({ headers }), [200])).body.devices,
    ).toStrictEqual([]);

    await updateFeatureSwitchesForUser(context, f, {
      [FeatureSwitchKey.RemoteDevices]: true,
    });
    authenticate(f);
    const [device] = (await accept(policy.list({ headers }), [200])).body
      .devices;
    expect(device).toMatchObject({
      displayName: "Deployment",
      accessAllowed: false,
      accessExpiresAt: null,
    });
    if (!device) {
      throw new Error("Expected one device for the SSH channel");
    }
    const denied = await accept(
      inventory().list({ headers: f.token() }),
      [200],
    );
    expect(denied.body.hosts).toStrictEqual([]);
    const remote = setupApp({ context, routes: chatRemoteAccessRoutes })(
      chatRemoteAccessContract,
    );
    await accept(
      remote.updateHostDefault({
        headers,
        params: { protocol: "ssh", connectionId: host.body.id },
        body: { enabled: true },
      }),
      [404],
    );
    await accept(
      policy.approve({
        headers: f.token(),
        params: { threadId: f.threadId },
        body: { deviceId: device.id },
      }),
      [403],
    );
    await accept(
      policy.approve({
        headers,
        params: { threadId: randomUUID() },
        body: { deviceId: device.id },
      }),
      [404],
    );

    await withMockNowForTest(now(), async () => {
      const approval = {
        headers,
        params: { threadId: f.threadId },
        body: { deviceId: device.id },
      };
      const expiresAt = new Date(now() + 3_600_000).toISOString();
      const approved = await accept(policy.approve(approval), [200]);
      expect(approved.body).toMatchObject({
        accessAllowed: true,
        accessExpiresAt: expiresAt,
      });
      const admitted = await accept(
        inventory().list({ headers: f.token() }),
        [200],
      );
      const [identity] = admitted.body.identities;
      expect(identity?.id).toBe(host.body.id);
      if (!identity) {
        throw new Error(
          "Expected current SSH inventory identity after approval",
        );
      }

      const runner = setupApp({ context, routes: runnerSshRoutes })(
        runnerSshContract,
      );
      const request = {
        headers: { authorization: `Bearer vm0_official_${"c".repeat(64)}` },
        params: { runId: f.runId },
        body: { connectionId: host.body.id, runnerIdentity: f.runnerIdentity },
      };
      expect((await accept(runner.resolve(request), [200])).body.outcome).toBe(
        "unavailable",
      );
      const compatible = {
        ...request,
        headers: { ...request.headers, "X-Okou-Remote-Device-Policy": "1" },
      };
      expect(
        (await accept(runner.resolve(compatible), [200])).body.outcome,
      ).toBe("resolved");
      const check = {
        ...compatible,
        body: {
          ...compatible.body,
          expectedGeneration: identity.generation,
          expectedCreatedAt: identity.createdAt,
        },
      };
      expect((await accept(runner.check(check), [200])).body.outcome).toBe(
        "valid",
      );
      const edited = await accept(
        config().update({
          headers,
          params: { connectionId: host.body.id },
          body: {
            expectedGeneration: identity.generation,
            host: "updated.example.com",
          },
        }),
        [200],
      );
      expect((await accept(runner.check(check), [200])).body.outcome).toBe(
        "configuration_changed",
      );
      const current = {
        ...check,
        body: { ...check.body, expectedGeneration: edited.body.generation },
      };
      expect((await accept(runner.check(current), [200])).body.outcome).toBe(
        "valid",
      );
      mockNow(new Date(expiresAt));
      expect((await accept(runner.check(current), [200])).body.outcome).toBe(
        "unavailable",
      );

      const later = new Date(now() + 7_200_000).toISOString();
      const settings = { headers, params: { deviceId: device.id } };
      await Promise.all([
        accept(policy.approve(approval), [200]),
        accept(
          policy.setAccess({
            ...settings,
            body: { mode: "until", expiresAt: later },
          }),
          [200],
        ),
      ]);
      expect(
        (await accept(policy.approve(approval), [200])).body.accessExpiresAt,
      ).toBe(later);
      await accept(
        policy.setAccess({ ...settings, body: { mode: "always" } }),
        [200],
      );
      expect(
        (await accept(policy.approve(approval), [200])).body.accessExpiresAt,
      ).toBeNull();
      await accept(
        policy.setAccess({ ...settings, body: { mode: "denied" } }),
        [200],
      );
      expect((await accept(runner.check(current), [200])).body.outcome).toBe(
        "unavailable",
      );
    });
    const otherMember = { orgId: f.orgId, userId: `user_ssh_${randomUUID()}` };
    await updateFeatureSwitchesForUser(context, otherMember, {
      [FeatureSwitchKey.RemoteDevices]: true,
    });
    expect(
      (await accept(policy.list({ headers }), [200])).body.devices,
    ).toStrictEqual([]);
    await accept(
      policy.setAccess({
        headers,
        params: { deviceId: device.id },
        body: { mode: "always" },
      }),
      [404],
    );
    await updateFeatureSwitchesForUser(context, f, {
      [FeatureSwitchKey.RemoteDevices]: false,
    });
    expect(
      (await accept(inventory().list({ headers: f.token() }), [200])).body
        .hosts,
    ).toHaveLength(1);
  });

  it("keeps first-host and recreated-host chat access default off", async () => {
    const f = await executionFixture();
    context.mocks.ably.publish.mockClear();
    const first = await createHost();
    expect(context.mocks.ably.publish.mock.calls).toStrictEqual([
      ["ssh:changed", { orgId: f.orgId }],
      [
        "ssh-authority-invalidated",
        { runId: f.runId, connectionId: first.body.id },
      ],
    ]);
    expect(
      (await accept(inventory().list({ headers: f.token() }), [200])).body,
    ).toStrictEqual({ hosts: [], identities: [] });
    await accept(
      config().delete({
        headers,
        params: { connectionId: first.body.id },
        body: { expectedGeneration: first.body.generation },
      }),
      [204],
    );
    await createHost("replacement.example.com");
    expect(
      (await accept(inventory().list({ headers: f.token() }), [200])).body,
    ).toStrictEqual({ hosts: [], identities: [] });
  });

  it("commits concurrent first hosts when best-effort invalidation fails", async () => {
    const f = await publicInventoryRun();
    context.mocks.ably.publish.mockRejectedValue(
      new Error("Synthetic publish failure"),
    );
    await Promise.all([
      createHost("one.example.com"),
      createHost("two.example.com"),
    ]);
    expect(
      (await accept(config().list({ headers }), [200])).body.connections,
    ).toHaveLength(2);
    expect(
      (await accept(inventory().list({ headers: f.token() }), [200])).body
        .hosts,
    ).toStrictEqual([]);
  });

  it("lists both chat-enabled logins at a shared endpoint", async () => {
    const f = await executionFixture();
    const first = await createHost();
    await enableChatDefault(first.body.id);
    const second = await accept(
      config().create({
        headers,
        body: {
          id: randomUUID(),
          displayName: "Maintenance",
          host: "SSH.example.com.",
          credential: inlineSshKey("ubuntu", "maintenance-private-key"),
        },
      }),
      [201],
    );
    await enableChatDefault(second.body.id);
    const listed = await accept(
      inventory().list({ headers: f.token() }),
      [200],
    );
    expect(listed.body.hosts).toStrictEqual([
      {
        id: first.body.id,
        displayName: "Deployment",
        host: "ssh.example.com",
        port: 22,
        username: "deploy",
        learnedHostKey: null,
        availability: { status: "ready" },
      },
      {
        id: second.body.id,
        displayName: "Maintenance",
        host: "ssh.example.com",
        port: 22,
        username: "ubuntu",
        learnedHostKey: null,
        availability: { status: "ready" },
      },
    ]);
    expect(JSON.stringify(listed.body)).not.toContain("private-key");
    await accept(
      config().delete({
        headers,
        params: { connectionId: first.body.id },
        body: { expectedGeneration: first.body.generation },
      }),
      [204],
    );
    expect(
      (await accept(inventory().list({ headers: f.token() }), [200])).body
        .hosts,
    ).toStrictEqual([listed.body.hosts[1]]);
  });

  it("uses only the Run owner's hosts across members of the same workspace", async () => {
    const runnerSecret = "c".repeat(64);
    mockEnv("OFFICIAL_RUNNER_SECRET", runnerSecret);
    const creatorOwner = {
      orgId: `org_ssh_shared_${randomUUID()}`,
      userId: `user_ssh_creator_${randomUUID()}`,
    };
    authenticate(creatorOwner);
    const creator = await ordinary.runtime(creatorOwner, {});
    const creatorHost = await createHost("creator.example.com");
    const runnerIdentity = { runnerId: randomUUID(), heartbeatGeneration: 1 };
    const user = await ordinary.runtime(
      {
        orgId: creator.orgId,
        userId: `user_ssh_member_${randomUUID()}`,
      },
      { runnerIdentity },
    );
    const runner = setupApp({ context, routes: runnerSshRoutes })(
      runnerSshContract,
    );
    const host = await createHost("user.example.com");
    await enableChatDefault(host.body.id);
    expect(
      (
        await accept(inventory().list({ headers: user.token() }), [200])
      ).body.hosts.map((value) => {
        return value.id;
      }),
    ).toStrictEqual([host.body.id]);
    const request = {
      headers: { authorization: `Bearer vm0_official_${runnerSecret}` },
      params: { runId: user.runId },
      body: { runnerIdentity, connectionId: host.body.id },
    };
    expect((await accept(runner.resolve(request), [200])).body.outcome).toBe(
      "resolved",
    );
    const observedHostKey = {
      algorithm: "ssh-ed25519" as const,
      fingerprint: `SHA256:${Buffer.alloc(32).toString("base64").replace(/=+$/u, "")}`,
    };
    const pin = {
      ...request,
      body: { ...request.body, expectedGeneration: 1, observedHostKey },
    };
    expect((await accept(runner.pin(pin), [200])).body.outcome).toBe("pinned");
    const foreignRequest = {
      ...request,
      body: { ...request.body, connectionId: creatorHost.body.id },
    };
    expect(
      (await accept(runner.resolve(foreignRequest), [200])).body,
    ).toStrictEqual({
      outcome: "unavailable",
    });
    expect(
      (
        await accept(
          runner.pin({
            ...pin,
            body: { ...pin.body, connectionId: creatorHost.body.id },
          }),
          [200],
        )
      ).body,
    ).toStrictEqual({ outcome: "unavailable" });
    authenticate(user);
    const ownedHosts = await accept(
      inventory().list({ headers: user.token() }),
      [200],
    );
    expect(
      ownedHosts.body.hosts.map((item) => {
        return item.id;
      }),
    ).toStrictEqual([host.body.id]);
    expect((await accept(runner.resolve(request), [200])).body.outcome).toBe(
      "resolved",
    );
    const verified = await accept(runner.pin(pin), [200]);
    expect(verified.body.outcome).toBe("matched");
  });

  it("keeps the Run inventory Agent-token and capability scoped", async () => {
    // All three credential kinds are rejected before any Run lookup.
    const owner = {
      userId: `user_ssh_capability_${randomUUID()}`,
      orgId: `org_ssh_capability_${randomUUID()}`,
    };
    authenticate(owner);
    const runId = randomUUID();
    const seconds = Math.floor(now() / 1000);
    const f = {
      sandboxToken: generateSandboxToken(owner.userId, runId, owner.orgId),
      token: (capabilities = ["ssh:read"]) => {
        return {
          authorization: `Bearer ${signSandboxJwtForTests({
            scope: "okou",
            userId: owner.userId,
            orgId: owner.orgId,
            runId,
            capabilities,
            iat: seconds,
            exp: seconds + 3600,
          })}`,
        };
      },
    };
    expect((await accept(inventory().list({ headers }), [403])).status).toBe(
      403,
    );
    expect(
      (await accept(inventory().list({ headers: f.token([]) }), [403])).status,
    ).toBe(403);
    expect(
      (
        await accept(
          inventory().list({
            headers: { authorization: `Bearer ${f.sandboxToken}` },
          }),
          [403],
        )
      ).status,
    ).toBe(403);
  });

  it("rejects completed Runs despite an enabled host default", async () => {
    const owner = {
      userId: `user_ssh_completed_${randomUUID()}`,
      orgId: `org_ssh_completed_${randomUUID()}`,
    };
    const secret = "c".repeat(64);
    mockEnv("OFFICIAL_RUNNER_SECRET", secret);
    const run = await publicRuns.start(owner);
    const f = await publicRuns.executionInput(run, {
      authorization: `Bearer vm0_official_${secret}`,
    });
    await publicRuns.finish(f, "completed");
    const chat = createChatFilesBddApi(context);
    // Deleting the terminal Run's Thread preserves its original no-chat premise.
    await chat.deleteThread(f.actor, f.threadId);
    await flushWaitUntilForTest();
    await chat.requestReadThreadMetadata(f.actor, f.threadId, [404]);
    await expect(
      createRunsApi(context).readRun(f.actor, f.runId),
    ).resolves.toMatchObject({
      status: "completed",
    });
    authenticate(f);
    const host = await createHost();
    await enableChatDefault(host.body.id);
    const seconds = Math.floor(now() / 1000);
    const agentHeaders = {
      authorization: `Bearer ${signSandboxJwtForTests({
        scope: "okou",
        userId: f.userId,
        orgId: f.orgId,
        runId: f.runId,
        capabilities: ["ssh:read"],
        iat: seconds,
        exp: seconds + 3600,
      })}`,
    };
    expect(
      (await accept(inventory().list({ headers: agentHeaders }), [404])).status,
    ).toBe(404);
  });
});
