import { createClaimedSshRuntimeApi } from "./helpers/claimed-ssh-runtime";
import { inlineSshKey } from "./helpers/ssh-credential";
import { randomUUID } from "node:crypto";
import {
  agentsByIdContract,
  agentsMainContract,
} from "@okouai/api-contracts/contracts/agents";
import { sshHostsContract } from "@okouai/api-contracts/contracts/ssh-access";
import { sshConnectionsContract } from "@okouai/api-contracts/contracts/ssh-connections";
import { chatRemoteAccessContract } from "@okouai/api-contracts/contracts/chat-remote-access";
import {
  testSshConnectionStateContract,
  type TestSshConnectionStateActionBody,
} from "@okouai/api-contracts/contracts/test-ssh-connection-state";
import { runnerSshContract } from "@okouai/api-contracts/contracts/runner-ssh";
import { runnersJobClaimContract } from "@okouai/api-contracts/contracts/runners";
import { afterEach, describe, expect, it } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { now } from "../../../lib/time";
import { mockEnv } from "../../../lib/env";
import {
  generateSandboxToken,
  signSandboxJwtForTests,
} from "../../auth/tokens";
import { sshAccessRoutes } from "../ssh-access";
import { agentsRoutes } from "../agents";
import { sshConnectionsRoutes } from "../ssh-connections";
import { runnerSshRoutes } from "../runner-ssh";
import { runnersRoutes } from "../runners";
import { chatRemoteAccessRoutes } from "../chat-remote-access";
import { testSshConnectionStateRoutes } from "../test-ssh-connection-state";
import { createRouteMocks } from "./helpers/route-test";
import { createBddApi } from "./helpers/api-bdd";
import { createChatFilesBddApi } from "./helpers/api-bdd-chat-files";
import { createRunsApi } from "./helpers/api-bdd-runs";
import { createPublicRemoteAccessRunApi } from "./helpers/public-remote-access-run";
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
  authenticate(owner);
  // Infrastructure-only fixture supplies a claimed running sandbox. Host
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
  return { ...owner, ...response.body, token, runId };
}

describe("live chat SSH Run inventory", () => {
  const publicRuns = createPublicRemoteAccessRunApi(context);
  const ordinary = createClaimedSshRuntimeApi(context, {
    runnerHeaders: { authorization: `Bearer vm0_official_${"c".repeat(64)}` },
    authenticate,
  });
  const claimedRunCleanups: (() => Promise<void>)[] = [];

  afterEach(async () => {
    await publicRuns.cleanup();
    await ordinary.cleanup();
    for (const cleanup of claimedRunCleanups.splice(0)) {
      await cleanup();
      await flushWaitUntilForTest();
    }
  });

  async function claimedFixture() {
    const bdd = createBddApi(context);
    const runs = createRunsApi(context);
    const actor = bdd.user();
    if (!actor.orgId) {
      throw new Error("Expected an SSH inventory owner organization");
    }
    const owner = { userId: actor.userId, orgId: actor.orgId };
    bdd.acceptAgentStorageWrites();
    runs.acceptStorageDownloads();
    runs.acceptTelemetryIngest();
    const group = runs.configureRunnerGroup();
    await runs.grantProEntitlement(actor);
    await runs.ensurePersonalSubscriptionModel(actor, {
      model: "claude-fable-5-1",
    });
    const { defaultAgentId: agentId } = await bdd.readOnboardingStatus(actor);
    if (!agentId) {
      throw new Error("Expected onboarding to provide the default Agent");
    }
    // Keep this owner host-free so first-host defaults remain the behavior under test.
    const { runId, threadId } = await runs.createThreadRun(actor, {
      agentId,
      prompt: "List my enabled SSH hosts",
    });
    claimedRunCleanups.push(async () => {
      await runs.requestCancelRun(actor, runId, [200]);
    });
    const runnerIdentity = {
      runnerId: randomUUID(),
      heartbeatGeneration: 5_000_000_000,
    };
    const secret = "d".repeat(64);
    mockEnv("OFFICIAL_RUNNER_SECRET", secret);
    const runnerHeaders = {
      authorization: `Bearer vm0_official_${secret}`,
    };
    await runs.requestHeartbeatRunnerAs(runnerHeaders.authorization, [200], {
      group,
      runnerId: runnerIdentity.runnerId,
      snapshotGeneration: runnerIdentity.heartbeatGeneration,
    });
    const claim = await accept(
      setupApp({ context, routes: runnersRoutes })(
        runnersJobClaimContract,
      ).claim({
        headers: runnerHeaders,
        params: { id: runId },
        body: {
          runnerIdentity,
          capabilities: { piModelConfigGenerations: [1, 2, 3] },
        },
      }),
      [200],
    );
    const agentToken = claim.body.platformEnvironment.OKOU_TOKEN;
    if (!agentToken) {
      throw new Error("Expected the Runner claim to issue its Agent token");
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
    const f = await fixture({ chat: true });
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
    await expect(
      accept(inventory().list({ headers: f.token() }), [200]),
    ).resolves.toMatchObject({ body: { hosts: [] } });
    await accept(
      remote.updateHostDefault({
        headers,
        params: { protocol: "ssh", connectionId: second.body.id },
        body: { enabled: true },
      }),
      [200],
    );
    await expect(listIds()).resolves.toStrictEqual([second.body.id]);
    const otherThread = await fixture({
      userId: f.userId,
      orgId: f.orgId,
      chat: true,
    });
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
    const withoutChat = await fixture({
      userId: f.userId,
      orgId: f.orgId,
      chat: false,
    });
    await accept(inventory().list({ headers: withoutChat.token() }), [404]);
  });

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

  it("keeps first-host and recreated-host chat access default off", async () => {
    const f = await claimedFixture();
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
    ).toStrictEqual({ hosts: [] });
    await accept(
      config().delete({ headers, params: { connectionId: first.body.id } }),
      [204],
    );
    await createHost("replacement.example.com");
    expect(
      (await accept(inventory().list({ headers: f.token() }), [200])).body,
    ).toStrictEqual({ hosts: [] });
  });

  it("commits concurrent first hosts when best-effort invalidation fails", async () => {
    const f = await fixture();
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
    await accept(inventory().list({ headers: f.token() }), [404]);
  });

  it("lists both chat-enabled logins at a shared endpoint", async () => {
    const f = await claimedFixture();
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
      config().delete({ headers, params: { connectionId: first.body.id } }),
      [204],
    );
    expect(
      (await accept(inventory().list({ headers: f.token() }), [200])).body
        .hosts,
    ).toStrictEqual([listed.body.hosts[1]]);
  });

  it("uses only the Run user's hosts for shared Agents and rejects current visibility loss", async () => {
    const runnerSecret = "c".repeat(64);
    mockEnv("OFFICIAL_RUNNER_SECRET", runnerSecret);
    const creatorOwner = {
      orgId: `org_ssh_shared_${randomUUID()}`,
      userId: `user_ssh_creator_${randomUUID()}`,
    };
    authenticate(creatorOwner);
    const shared = await createAgent("public");
    const creator = await ordinary.runtime(creatorOwner, {
      agentId: shared.agentId,
    });
    const creatorHost = await createHost("creator.example.com");
    const runnerIdentity = { runnerId: randomUUID(), heartbeatGeneration: 1 };
    const user = await ordinary.runtime(
      {
        orgId: creator.orgId,
        userId: `user_ssh_member_${randomUUID()}`,
      },
      { agentId: shared.agentId, runnerIdentity },
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
    await accept(inventory().list({ headers: user.token() }), [404]);
    expect((await accept(runner.resolve(request), [200])).body).toStrictEqual({
      outcome: "unavailable",
    });
    expect((await accept(runner.pin(pin), [200])).body).toStrictEqual({
      outcome: "unavailable",
    });
  });

  it.each(["web", "automation-schedule", "slack"] as const)(
    "denies %s Runs without a chat thread despite an enabled host default",
    async (triggerSource) => {
      const f = await fixture({ triggerSource });
      const host = await createHost();
      await enableChatDefault(host.body.id);
      expect(
        (await accept(inventory().list({ headers: f.token() }), [404])).status,
      ).toBe(404);
    },
  );

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
    const f = await publicRuns.claim(run, {
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
