import { inlineSshKey } from "./helpers/ssh-credential";
import { randomUUID } from "node:crypto";
import {
  agentsByIdContract,
  agentsMainContract,
} from "@okouai/api-contracts/contracts/agents";
import {
  agentSshAccessContract,
  sshHostsContract,
} from "@okouai/api-contracts/contracts/ssh-access";
import { sshConnectionsContract } from "@okouai/api-contracts/contracts/ssh-connections";
import {
  testSshConnectionStateContract,
  type TestSshConnectionStateActionBody,
} from "@okouai/api-contracts/contracts/test-ssh-connection-state";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { runnerSshContract } from "@okouai/api-contracts/contracts/runner-ssh";
import { describe, expect, it } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { now } from "../../../lib/time";
import { mockEnv } from "../../../lib/env";
import { signSandboxJwtForTests } from "../../auth/tokens";
import { sshAccessRoutes } from "../ssh-access";
import { agentsRoutes } from "../agents";
import { sshConnectionsRoutes } from "../ssh-connections";
import { runnerSshRoutes } from "../runner-ssh";
import { testSshConnectionStateRoutes } from "../test-ssh-connection-state";
import { createRouteMocks } from "./helpers/route-test";
import { updateFeatureSwitchesForUser } from "./helpers/feature-switches";

const context = testContext();
const mocks = createRouteMocks(context);
const headers = Object.freeze({ authorization: "Bearer clerk-session" });
const grant = () => {
  return setupApp({ context, routes: sshAccessRoutes })(agentSshAccessContract);
};
const inventory = () => {
  return setupApp({ context, routes: sshAccessRoutes })(sshHostsContract);
};
const config = () => {
  return setupApp({ context, routes: sshConnectionsRoutes })(
    sshConnectionsContract,
  );
};
type RuntimeBody = Extract<
  TestSshConnectionStateActionBody,
  { action: "create-runtime" }
>;

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

async function fixture(overrides: Partial<RuntimeBody> = {}) {
  const owner = {
    userId: `user_ssh_consumers_${randomUUID()}`,
    orgId: `org_ssh_consumers_${randomUUID()}`,
    ...overrides,
  };
  await updateFeatureSwitchesForUser(context, owner, {
    [FeatureSwitchKey.SshAccess]: true,
  });
  authenticate(owner);
  // Infrastructure-only fixture supplies a claimed running sandbox. Grants and
  // connections below go through the production owner endpoints.
  const state = setupApp({ context, routes: testSshConnectionStateRoutes })(
    testSshConnectionStateContract,
  );
  const response = await accept(
    state.action({
      body: {
        action: "create-runtime",
        runnerId: owner.runnerId ?? randomUUID(),
        heartbeatGeneration: 1,
        triggerSource: "web",
        status: "running",
        chat: false,
        access: false,
        runnerGroup: `ssh-consumers-${randomUUID()}`,
        ...owner,
      },
    }),
    [200],
  );
  if (
    !response.body.runId ||
    !response.body.agentId ||
    !response.body.sandboxToken
  ) {
    throw new Error("Missing runtime fixture");
  }
  const params = { agentId: response.body.agentId };
  const runId = response.body.runId;
  const seconds = Math.floor(now() / 1000);
  const token = (capabilities = ["ssh:read"]) => {
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
  };
  return { ...owner, ...response.body, params, token, runId };
}

describe("owner SSH grants and live Run inventory", () => {
  async function createAgent(visibility: "public" | "private") {
    context.mocks.s3.send.mockResolvedValue({});
    const result = await accept(
      setupApp({ context, routes: agentsRoutes })(agentsMainContract).create({
        headers,
        body: { displayName: "SSH authorization test", visibility },
      }),
      [201],
    );
    return { agentId: result.body.agentId };
  }

  async function createHost(host = "ssh.example.com") {
    return await accept(
      config().create({
        headers,
        body: {
          displayName: "Deployment",
          host,
          credential: inlineSshKey("deploy", "test-private-key"),
        },
      }),
      [201],
    );
  }

  it("automatically grants all visible Agents only on a zero-to-one host transition", async () => {
    const f = await fixture();
    const ownPrivate = await createAgent("private");
    const other = await fixture({ orgId: f.orgId });
    const otherPrivate = await createAgent("private");
    const foreign = await fixture();
    authenticate(f);
    context.mocks.ably.publish.mockClear();
    const first = await createHost();
    expect(context.mocks.ably.publish.mock.calls).toStrictEqual([
      ["ssh:changed", { orgId: f.orgId }],
      ["ssh-authority-invalidated", { runId: f.runId, connectionId: null }],
    ]);
    for (const params of [f.params, ownPrivate, other.params]) {
      expect(
        (await accept(grant().get({ headers, params }), [200])).body,
      ).toStrictEqual({
        enabled: true,
      });
    }
    for (const params of [otherPrivate, foreign.params]) {
      await accept(grant().get({ headers, params }), [404]);
      await accept(
        grant().update({ headers, params, body: { enabled: true } }),
        [404],
      );
    }
    // Granting a shared Agent never authorizes its creator's Run or hosts.
    await accept(inventory().list({ headers: other.token() }), [404]);
    await accept(
      grant().update({ headers, params: f.params, body: { enabled: false } }),
      [200],
    );
    const laterAgent = await createAgent("private");
    const second = await createHost("second.example.com");
    expect(
      (await accept(grant().get({ headers, params: laterAgent }), [200])).body,
    ).toStrictEqual({ enabled: false });
    expect(
      (await accept(grant().get({ headers, params: f.params }), [200])).body,
    ).toStrictEqual({ enabled: false });
    for (const connection of [first, second]) {
      await accept(
        config().delete({
          headers,
          params: { connectionId: connection.body.id },
        }),
        [204],
      );
    }
    // Hiding an empty inventory must not erase the other existing grants.
    expect(
      (await accept(grant().get({ headers, params: ownPrivate }), [200])).body,
    ).toStrictEqual({ enabled: true });
    await createHost();
    expect(
      (await accept(grant().get({ headers, params: f.params }), [200])).body,
    ).toStrictEqual({ enabled: true });
  });

  it("serializes concurrent first hosts and preserves successful creation when invalidation fails", async () => {
    const f = await fixture();
    context.mocks.ably.publish.mockRejectedValue(
      new Error("Synthetic publish failure"),
    );
    await Promise.all([
      createHost("one.example.com"),
      createHost("two.example.com"),
    ]);
    expect(
      (await accept(grant().get({ headers, params: f.params }), [200])).body,
    ).toStrictEqual({ enabled: true });
    expect(
      (await accept(inventory().list({ headers: f.token() }), [200])).body
        .hosts,
    ).toHaveLength(2);
  });

  it("lists both logins at a shared endpoint without restoring a revoked grant", async () => {
    const f = await fixture();
    const first = await createHost();
    await accept(
      grant().update({ headers, params: f.params, body: { enabled: false } }),
      [200],
    );
    const second = await accept(
      config().create({
        headers,
        body: {
          displayName: "Maintenance",
          host: "SSH.example.com.",
          credential: inlineSshKey("ubuntu", "maintenance-private-key"),
        },
      }),
      [201],
    );
    await accept(inventory().list({ headers: f.token() }), [404]);
    await accept(
      grant().update({ headers, params: f.params, body: { enabled: true } }),
      [200],
    );
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
      },
      {
        id: second.body.id,
        displayName: "Maintenance",
        host: "ssh.example.com",
        port: 22,
        username: "ubuntu",
        learnedHostKey: null,
      },
    ]);
    expect(JSON.stringify(listed.body)).not.toContain("private-key");
    await accept(
      config().delete({ headers, params: { connectionId: first.body.id } }),
      [204],
    );
    expect(
      (await accept(inventory().list({ headers: f.token() }), [200])).body
        .hosts,
    ).toStrictEqual([listed.body.hosts[1]]);
  });

  it("uses only the Run user's hosts for shared Agents and rejects current visibility loss", async () => {
    const creator = await fixture();
    const shared = await createAgent("public");
    const creatorHost = await createHost("creator.example.com");
    const runnerIdentity = { runnerId: randomUUID(), heartbeatGeneration: 1 };
    const user = await fixture({
      orgId: creator.orgId,
      agentId: shared.agentId,
      ...runnerIdentity,
    });
    const runnerSecret = "c".repeat(64);
    mockEnv("OFFICIAL_RUNNER_SECRET", runnerSecret);
    const runner = setupApp({ context, routes: runnerSshRoutes })(
      runnerSshContract,
    );
    const host = await createHost("user.example.com");
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
    authenticate(creator);
    await accept(
      setupApp({ context, routes: agentsRoutes })(agentsByIdContract).update({
        headers,
        params: { id: shared.agentId },
        body: { visibility: "private" },
      }),
      [200],
    );
    authenticate(user);
    await accept(grant().get({ headers, params: shared }), [404]);
    await accept(inventory().list({ headers: user.token() }), [404]);
    expect((await accept(runner.resolve(request), [200])).body).toStrictEqual({
      outcome: "unavailable",
    });
    expect((await accept(runner.pin(pin), [200])).body).toStrictEqual({
      outcome: "unavailable",
    });
  });

  it("production grant revocation denies Runner resolution and first-use pinning", async () => {
    const runnerIdentity = { runnerId: randomUUID(), heartbeatGeneration: 1 };
    const f = await fixture(runnerIdentity);
    const secret = "b".repeat(64);
    mockEnv("OFFICIAL_RUNNER_SECRET", secret);
    const runnerHeaders = { authorization: `Bearer vm0_official_${secret}` };
    const client = setupApp({ context, routes: runnerSshRoutes })(
      runnerSshContract,
    );
    const host = await accept(
      config().create({
        headers,
        body: {
          displayName: "Deployment",
          host: "ssh.example.com",
          credential: inlineSshKey("deploy", "test-private-key"),
        },
      }),
      [201],
    );
    const request = {
      headers: runnerHeaders,
      params: { runId: f.runId },
      body: { connectionId: host.body.id, runnerIdentity },
    };
    // The first host automatically grants access to this visible Agent.
    expect((await accept(client.resolve(request), [200])).body.outcome).toBe(
      "resolved",
    );
    await accept(
      grant().update({ headers, params: f.params, body: { enabled: false } }),
      [200],
    );
    expect((await accept(client.resolve(request), [200])).body).toStrictEqual({
      outcome: "unavailable",
    });
    const pin = await accept(
      client.pin({
        ...request,
        body: {
          ...request.body,
          expectedGeneration: 1,
          observedHostKey: {
            algorithm: "ssh-ed25519",
            fingerprint: `SHA256:${Buffer.alloc(32).toString("base64").replace(/=+$/u, "")}`,
          },
        },
      }),
      [200],
    );
    expect(pin.body).toStrictEqual({ outcome: "unavailable" });
    expect(
      (await accept(config().list({ headers }), [200])).body.connections[0]
        ?.learnedHostKey,
    ).toBeNull();
  });
  it.each(["web", "automation-schedule", "slack"] as const)(
    "uses current grants and hosts for %s Runs without a chat thread",
    async (triggerSource) => {
      const f = await fixture({ triggerSource });
      expect(
        (await accept(grant().get({ headers, params: f.params }), [200])).body,
      ).toStrictEqual({ enabled: false });
      await accept(inventory().list({ headers: f.token() }), [404]);
      await accept(
        grant().update({ headers, params: f.params, body: { enabled: true } }),
        [200],
      );
      expect(
        (await accept(inventory().list({ headers: f.token() }), [200])).body,
      ).toStrictEqual({ hosts: [] });
      const connection = await accept(
        config().create({
          headers,
          body: {
            displayName: "Deployment",
            host: "ssh.example.com",
            credential: inlineSshKey(
              "deploy",
              " secret-canary\n",
              " passphrase-canary ",
            ),
          },
        }),
        [201],
      );
      const listed = await accept(
        inventory().list({ headers: f.token() }),
        [200],
      );
      expect(listed.body).toStrictEqual({
        hosts: [
          {
            id: connection.body.id,
            displayName: "Deployment",
            host: "ssh.example.com",
            username: "deploy",
            port: 22,
            learnedHostKey: null,
          },
        ],
      });
      expect(JSON.stringify(listed)).not.toContain("canary");
      await accept(
        config().update({
          headers,
          params: { connectionId: connection.body.id },
          body: { expectedGeneration: 1, displayName: "Renamed" },
        }),
        [200],
      );
      expect(
        (await accept(inventory().list({ headers: f.token() }), [200])).body
          .hosts[0]?.displayName,
      ).toBe("Renamed");
      await accept(
        config().delete({
          headers,
          params: { connectionId: connection.body.id },
        }),
        [204],
      );
      expect(
        (await accept(inventory().list({ headers: f.token() }), [200])).body
          .hosts,
      ).toStrictEqual([]);
      context.mocks.ably.publish.mockClear();
      await accept(
        grant().update({ headers, params: f.params, body: { enabled: false } }),
        [200],
      );
      expect(context.mocks.ably.publish.mock.calls).toStrictEqual([
        ["ssh:changed", { orgId: f.orgId }],
        ["ssh-authority-invalidated", { runId: f.runId, connectionId: null }],
      ]);
      await accept(inventory().list({ headers: f.token() }), [404]);
      expect(
        (await accept(grant().get({ headers, params: f.params }), [200])).body
          .enabled,
      ).toBeFalsy();
    },
  );

  it("does not let Agent or sandbox tokens read/write owner grants or sessions list Run hosts", async () => {
    const f = await fixture();
    for (const denied of [
      f.token(["ssh:read", "ssh:write"]),
      { authorization: `Bearer ${f.sandboxToken}` },
    ]) {
      await accept(grant().get({ headers: denied, params: f.params }), [403]);
      await accept(
        grant().update({
          headers: denied,
          params: f.params,
          body: { enabled: true },
        }),
        [403],
      );
    }
    await accept(inventory().list({ headers }), [403]);
    await accept(inventory().list({ headers: f.token([]) }), [403]);
    expect(
      (await accept(grant().get({ headers, params: f.params }), [200])).body
        .enabled,
    ).toBeFalsy();
  });

  it("hides another owner's private Agent identically to an absent Agent and isolates invalidations", async () => {
    const f = await fixture();
    await accept(
      setupApp({ context, routes: agentsRoutes })(agentsByIdContract).update({
        headers,
        params: { id: f.params.agentId },
        body: { visibility: "private" },
      }),
      [200],
    );
    const other = await fixture({ orgId: f.orgId });
    for (const params of [f.params, { agentId: randomUUID() }]) {
      await accept(grant().get({ headers, params }), [404]);
      await accept(
        grant().update({ headers, params, body: { enabled: true } }),
        [404],
      );
    }
    context.mocks.ably.publish.mockClear();
    await accept(
      grant().update({
        headers,
        params: other.params,
        body: { enabled: true },
      }),
      [200],
    );
    expect(context.mocks.ably.publish.mock.calls).toStrictEqual([
      ["ssh:changed", { orgId: other.orgId }],
      ["ssh-authority-invalidated", { runId: other.runId, connectionId: null }],
    ]);
    await accept(inventory().list({ headers: f.token() }), [404]);
  });

  it("keeps committed grants successful when Ably fails", async () => {
    const f = await fixture();
    context.mocks.ably.publish.mockRejectedValue(
      new Error("Synthetic publish failure"),
    );
    await accept(
      grant().update({ headers, params: f.params, body: { enabled: true } }),
      [200],
    );
    expect(
      (await accept(grant().get({ headers, params: f.params }), [200])).body
        .enabled,
    ).toBeTruthy();
    await accept(inventory().list({ headers: f.token() }), [200]);
  });

  it("requires the feature flag even with an existing grant in an ordinary organization", async () => {
    const f = await fixture();
    await accept(
      grant().update({ headers, params: f.params, body: { enabled: true } }),
      [200],
    );
    await updateFeatureSwitchesForUser(context, f, {
      [FeatureSwitchKey.SshAccess]: false,
    });
    await accept(grant().get({ headers, params: f.params }), [404]);
    await accept(
      grant().update({ headers, params: f.params, body: { enabled: false } }),
      [404],
    );
    await accept(inventory().list({ headers: f.token() }), [404]);
    await updateFeatureSwitchesForUser(context, f, {
      [FeatureSwitchKey.SshAccess]: true,
    });
    expect(
      (await accept(grant().get({ headers, params: f.params }), [200])).body,
    ).toStrictEqual({ enabled: true });
    expect(
      (await accept(inventory().list({ headers: f.token() }), [200])).body,
    ).toStrictEqual({ hosts: [] });
    await accept(
      grant().update({
        headers,
        params: f.params,
        body: { enabled: false },
      }),
      [200],
    );
    const denied = await accept(
      inventory().list({ headers: f.token() }),
      [404],
    );
    expect(denied.body.error.message).toBe("SSH access is not available");
  });

  it("rejects completed Runs despite a current grant", async () => {
    const f = await fixture({ status: "completed" });
    await accept(
      grant().update({ headers, params: f.params, body: { enabled: true } }),
      [200],
    );
    await accept(inventory().list({ headers: f.token() }), [404]);
    expect(
      (await accept(grant().get({ headers, params: f.params }), [200])).body
        .enabled,
    ).toBeTruthy();
  });
});
