import { deletePublicWorkspace } from "./helpers/public-workspace-cleanup";
import { createClaimedSshRuntimeApi } from "./helpers/claimed-ssh-runtime";
import { inlineSshKey } from "./helpers/ssh-credential";
import { randomUUID } from "node:crypto";

import { chatRemoteAccessContract } from "@okouai/api-contracts/contracts/chat-remote-access";
import {
  runnerSshContract,
  type RunnerSshResolveRequest,
  type RunnerSshObservationRequest,
} from "@okouai/api-contracts/contracts/runner-ssh";
import { sshConnectionsContract } from "@okouai/api-contracts/contracts/ssh-connections";
import { sshCredentialsContract } from "@okouai/api-contracts/contracts/ssh-credentials";
import { runnersJobClaimContract } from "@okouai/api-contracts/contracts/runners";
import { afterEach, beforeEach, describe, expect, it, test } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp, setupRawAppRequest } from "../../../__tests__/test-helpers";
import { mockEnv } from "../../../lib/env";
import { now, nowDate } from "../../../lib/time";
import { createDeferredPromise, joinAll, onRejection } from "../../utils";
import { runnerSshRoutes } from "../runner-ssh";
import { runnersRoutes } from "../runners";
import { chatRemoteAccessRoutes } from "../chat-remote-access";
import { sshConnectionsRoutes } from "../ssh-connections";
import { useSecretKmsProbe } from "./helpers/secret-kms-probe";
import { createAuthOrgAgentsBddApi } from "./helpers/api-bdd-auth-org";
import { createRouteMocks } from "./helpers/route-test";
import { createBddApi } from "./helpers/api-bdd";
import { createRunsApi } from "./helpers/api-bdd-runs";
import { createPublicRemoteAccessRunApi } from "./helpers/public-remote-access-run";
import { flushWaitUntilForTest } from "../../context/wait-until";

const context = testContext();
const mocks = createRouteMocks(context);
const sessionHeaders = Object.freeze({ authorization: "Bearer clerk-session" });
const runnerSecret = "a".repeat(64);
const runnerHeaders = Object.freeze({
  authorization: `Bearer vm0_official_${runnerSecret}`,
});
const hostKey = Object.freeze({
  algorithm: "ssh-ed25519" as const,
  fingerprint: `SHA256:${Buffer.alloc(32, 1).toString("base64url").replaceAll("-", "+").replaceAll("_", "/")}`,
});
const otherHostKey = Object.freeze({
  ...hostKey,
  fingerprint: `SHA256:${Buffer.alloc(32, 2).toString("base64").replace(/=+$/u, "")}`,
});
const privateKey = "  private-key-canary\n";
const passphrase = " passphrase-canary ";
interface Owner {
  readonly userId: string;
  readonly orgId: string;
}

function client() {
  return setupApp({ context, routes: runnerSshRoutes })(runnerSshContract);
}
function config() {
  return setupApp({ context, routes: sshConnectionsRoutes })(
    sshConnectionsContract,
  );
}
function authenticate(owner: Owner) {
  mocks.clerk.session(owner.userId, owner.orgId);
}

async function enableHostDefault(owner: Owner, connectionId: string) {
  authenticate(owner);
  const remote = setupApp({ context, routes: chatRemoteAccessRoutes })(
    chatRemoteAccessContract,
  );
  await accept(
    remote.updateHostDefault({
      headers: sessionHeaders,
      params: { protocol: "ssh", connectionId },
      body: { enabled: true },
    }),
    [200],
  );
}

async function setThreadHostOverride(f: Fixture, enabled: boolean | null) {
  if (!f.threadId) {
    throw new Error("Missing fixture chat thread");
  }
  authenticate(f);
  const remote = setupApp({ context, routes: chatRemoteAccessRoutes })(
    chatRemoteAccessContract,
  );
  const params = {
    threadId: f.threadId,
    protocol: "ssh" as const,
    connectionId: f.connectionId,
  };
  if (enabled === null) {
    await accept(
      remote.clearThreadOverride({ headers: sessionHeaders, params }),
      [200],
    );
  } else {
    await accept(
      remote.setThreadOverride({
        headers: sessionHeaders,
        params,
        body: { enabled },
      }),
      [200],
    );
  }
}
interface Fixture extends Owner {
  readonly runId: string;
  readonly agentId: string;
  readonly threadId?: string;
  readonly sandboxToken: string;
  readonly runnerIdentity: {
    runnerId: ReturnType<typeof randomUUID>;
    heartbeatGeneration: number;
  };
  readonly connectionId: string;
  readonly credentialId: string;
}

const ordinary = createClaimedSshRuntimeApi(context, {
  runnerHeaders,
  authenticate,
});

async function ordinaryFixture(group?: string) {
  const owner = {
    orgId: `org_ssh_claimed_${randomUUID()}`,
    userId: `user_ssh_claimed_${randomUUID()}`,
  };
  authenticate(owner);
  const connection = await accept(
    config().create({
      headers: sessionHeaders,
      body: {
        id: randomUUID(),
        displayName: "SSH fixture",
        host: "ssh.example.com",
        credential: inlineSshKey("deploy", privateKey, passphrase),
      },
    }),
    [201],
  );
  await enableHostDefault(owner, connection.body.id);
  const runtime = await ordinary.runtime(
    owner,
    group === undefined ? {} : { group },
  );
  return {
    ...runtime,
    connectionId: connection.body.id,
    credentialId: connection.body.credentialId,
  };
}

function useClaimedFixture() {
  const claimedRunCleanups: (() => Promise<void>)[] = [];
  // Finish owned Run cancellation before the parent context tears down its signal/mocks.
  afterEach(async () => {
    const cleanups = claimedRunCleanups.splice(0);
    if (cleanups.length === 0) {
      await flushWaitUntilForTest();
      return;
    }
    // The notification-failure case owns its fault only until the assertion completes.
    context.mocks.ably.publish.mockResolvedValue(undefined);
    for (const cleanup of cleanups) {
      await cleanup();
      await flushWaitUntilForTest();
    }
  });

  /** A currently claimed chat Run and owner-configured host, through production routes. */
  async function claimedFixture(): Promise<Fixture> {
    const bdd = createBddApi(context);
    const runs = createRunsApi(context);
    const actor = bdd.user();
    if (!actor.orgId) {
      throw new Error("Expected an SSH owner organization");
    }
    const owner = { orgId: actor.orgId, userId: actor.userId };
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
    authenticate(owner);
    const connection = await accept(
      config().create({
        headers: sessionHeaders,
        body: {
          id: randomUUID(),
          displayName: "SSH claimed Run",
          host: "ssh.example.com",
          credential: inlineSshKey("deploy", privateKey, passphrase),
        },
      }),
      [201],
    );
    await enableHostDefault(owner, connection.body.id);
    const { runId, threadId } = await runs.createThreadRun(actor, {
      agentId,
      prompt: "Use my configured SSH host",
    });
    claimedRunCleanups.push(async () => {
      await runs.requestCancelRun(actor, runId, [200]);
    });
    // Preserve the process-generation bigint boundary with a real heartbeat and claim.
    const runnerIdentity = {
      runnerId: randomUUID(),
      heartbeatGeneration: 5_000_000_000,
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
    const sandboxToken = claim.body.sandboxToken;
    if (!sandboxToken) {
      throw new Error("Expected the Runner claim to issue its sandbox token");
    }
    await expect(runs.readRun(actor, runId)).resolves.toMatchObject({
      status: "running",
    });
    authenticate(owner);
    return {
      ...owner,
      agentId,
      runId,
      threadId,
      runnerIdentity,
      sandboxToken,
      connectionId: connection.body.id,
      credentialId: connection.body.credentialId,
    };
  }

  return claimedFixture;
}

describe("SSH authority invalidation", () => {
  afterEach(ordinary.cleanup);
  const claimedFixture = useClaimedFixture();

  it("notifies all active owner Runs after committed edits, rotations, reset and deletion", async () => {
    const group = `vm0/bdd-${randomUUID().slice(0, 8)}`;
    const f = await ordinaryFixture(group);
    const secondRun = await ordinary.runtime(f, { group });
    const completed = await ordinary.runtime(f, { group });
    await ordinary.complete(completed);
    await ordinaryFixture();
    authenticate(f);
    const expected = [f.runId, secondRun.runId].map((runId) => {
      return [
        "ssh-authority-invalidated",
        { runId, connectionId: f.connectionId },
      ];
    });
    const updates = [
      { host: "changed.example.com" },
      {
        credential: inlineSshKey(
          "deploy",
          "rotated-private-key",
          "rotated-passphrase",
        ),
      },
    ];
    let generation = 1;
    for (const update of updates) {
      context.mocks.ably.publish.mockClear();
      context.mocks.ably.channelGet.mockClear();
      const changed = await accept(
        config().update({
          headers: sessionHeaders,
          params: { connectionId: f.connectionId },
          body: {
            expectedGeneration: generation,
            ...update,
          },
        }),
        [200],
      );
      generation = changed.body.generation;
      expect(context.mocks.ably.publish.mock.calls).toHaveLength(3);
      expect(context.mocks.ably.publish.mock.calls).toStrictEqual(
        expect.arrayContaining([
          ["ssh:changed", { orgId: f.orgId }],
          ...expected,
        ]),
      );
      expect(context.mocks.ably.channelGet.mock.calls).toStrictEqual([
        [`user:${f.userId}`],
        [`runner-group:${group}`],
        [`runner-group:${group}`],
      ]);
    }
    context.mocks.ably.publish.mockClear();
    await accept(
      config().resetHostKey({
        headers: sessionHeaders,
        params: { connectionId: f.connectionId },
        body: { expectedGeneration: generation },
      }),
      [200],
    );
    expect(context.mocks.ably.publish.mock.calls).toHaveLength(3);
    expect(context.mocks.ably.publish.mock.calls).toStrictEqual(
      expect.arrayContaining([
        ["ssh:changed", { orgId: f.orgId }],
        ...expected,
      ]),
    );
    context.mocks.ably.publish.mockClear();
    await accept(
      config().delete({
        headers: sessionHeaders,
        params: { connectionId: f.connectionId },
      }),
      [204],
    );
    expect(context.mocks.ably.publish.mock.calls).toHaveLength(3);
    expect(context.mocks.ably.publish.mock.calls).toStrictEqual(
      expect.arrayContaining([
        ["ssh:changed", { orgId: f.orgId }],
        ...expected,
      ]),
    );
    const listed = await accept(
      config().list({ headers: sessionHeaders }),
      [200],
    );
    expect(listed.body.connections).toStrictEqual([]);
  });

  it("keeps committed mutations successful when notification delivery fails", async () => {
    const f = await claimedFixture();
    context.mocks.ably.publish.mockClear();
    context.mocks.ably.publish.mockRejectedValue(
      new Error("Synthetic Ably publish failure"),
    );
    const changed = await accept(
      config().update({
        headers: sessionHeaders,
        params: { connectionId: f.connectionId },
        body: {
          expectedGeneration: 1,
          credential: inlineSshKey("new-login", privateKey, passphrase),
        },
      }),
      [200],
    );
    expect(changed.body.generation).toBe(2);
    const listed = await accept(
      config().list({ headers: sessionHeaders }),
      [200],
    );
    expect(listed.body.connections).toStrictEqual([
      expect.objectContaining({
        id: f.connectionId,
        generation: 2,
        username: "new-login",
      }),
    ]);
    expect(context.mocks.ably.publish.mock.calls).toStrictEqual([
      ["ssh:changed", { orgId: f.orgId }],
      [
        "ssh-authority-invalidated",
        { runId: f.runId, connectionId: f.connectionId },
      ],
    ]);
  });

  it("resolves the current host credentials after overlapping low-frequency edits", async () => {
    const f = await claimedFixture();
    context.mocks.ably.publish.mockClear();
    const outcomes = await Promise.all(
      ["first-login", "second-login"].map(async (username) => {
        return await accept(
          config().update({
            headers: sessionHeaders,
            params: { connectionId: f.connectionId },
            body: {
              expectedGeneration: 1,
              credential: inlineSshKey(username, privateKey, passphrase),
            },
          }),
          [200, 409],
        );
      }),
    );
    expect(
      outcomes.some((result) => {
        return result.status === 200;
      }),
    ).toBeTruthy();
    const current = (await list(f)).find((host) => {
      return host.id === f.connectionId;
    });
    if (!current) {
      throw new Error("Expected the edited host to remain configured");
    }
    expect(current.username).toBeOneOf(["first-login", "second-login"]);
    await expect(resolve(f)).resolves.toMatchObject({
      outcome: "resolved",
      username: current.username,
      generation: current.generation,
    });
  });
});

async function resolve(
  f: Fixture,
  override: Partial<RunnerSshResolveRequest> = {},
) {
  const r = await accept(
    client().resolve({
      params: { runId: f.runId },
      headers: runnerHeaders,
      body: {
        connectionId: f.connectionId,
        runnerIdentity: f.runnerIdentity,
        ...override,
      },
    }),
    [200],
  );
  return r.body;
}
async function pin(
  f: Fixture,
  expectedGeneration = 1,
  observedHostKey = hostKey,
) {
  const r = await accept(
    client().pin({
      params: { runId: f.runId },
      headers: runnerHeaders,
      body: {
        connectionId: f.connectionId,
        runnerIdentity: f.runnerIdentity,
        expectedGeneration,
        observedHostKey,
      },
    }),
    [200],
  );
  return r.body;
}
async function list(f: Fixture) {
  authenticate(f);
  return (await accept(config().list({ headers: sessionHeaders }), [200])).body
    .connections;
}

beforeEach(() => {
  mockEnv("OFFICIAL_RUNNER_SECRET", runnerSecret);
  useSecretKmsProbe();
});

function createPublicHostApi() {
  const selectedRuns = createPublicRemoteAccessRunApi(context);
  const selectedOwners = new Map<string, Owner>();
  async function cleanupSelectedRuns() {
    await selectedRuns.cleanup();
    for (const owner of selectedOwners.values()) {
      await deletePublicWorkspace(context, createBddApi(context).user(owner));
    }
    selectedOwners.clear();
  }
  async function publicHostRun(defaultEnabled = true) {
    const owner = {
      orgId: `org_ssh_public_${randomUUID()}`,
      userId: `user_ssh_public_${randomUUID()}`,
    };
    selectedOwners.set(owner.orgId, owner);
    const run = await selectedRuns.start(owner);
    const claimed = await selectedRuns.claim(run, runnerHeaders);
    authenticate(owner);
    const connection = await accept(
      config().create({
        headers: sessionHeaders,
        body: {
          id: randomUUID(),
          displayName: "SSH owner host",
          host: "ssh.example.com",
          credential: inlineSshKey("deploy", privateKey, passphrase),
        },
      }),
      [201],
    );
    if (defaultEnabled) {
      await enableHostDefault(owner, connection.body.id);
    }
    return {
      ...claimed,
      connectionId: connection.body.id,
      credentialId: connection.body.credentialId,
    };
  }

  return {
    runtime: publicHostRun,
    cleanup: cleanupSelectedRuns,
    runs: selectedRuns,
    trackOwner(owner: Owner) {
      selectedOwners.set(owner.orgId, owner);
    },
  };
}
const selected = createPublicHostApi();

describe("chat thread SSH authority", () => {
  afterEach(selected.cleanup);
  it("uses current per-host defaults and overrides for a claimed chat Run", async () => {
    const f = await selected.runtime(false);
    if (!f.threadId) {
      throw new Error("Missing fixture chat thread");
    }
    const threadId = f.threadId;
    authenticate(f);
    const remote = setupApp({ context, routes: chatRemoteAccessRoutes })(
      chatRemoteAccessContract,
    );
    const host = { protocol: "ssh" as const, connectionId: f.connectionId };
    await expect(resolve(f)).resolves.toStrictEqual({ outcome: "unavailable" });
    await accept(
      remote.updateHostDefault({
        headers: sessionHeaders,
        params: host,
        body: { enabled: true },
      }),
      [200],
    );
    await expect(resolve(f)).resolves.toMatchObject({ outcome: "resolved" });
    const params = { threadId, ...host };
    context.mocks.ably.publish.mockClear();
    await accept(
      remote.setThreadOverride({
        headers: sessionHeaders,
        params,
        body: { enabled: false },
      }),
      [200],
    );
    expect(context.mocks.ably.publish.mock.calls).toStrictEqual(
      expect.arrayContaining([
        ["ssh:changed", { orgId: f.orgId }],
        [
          "ssh-authority-invalidated",
          { runId: f.runId, connectionId: f.connectionId },
        ],
      ]),
    );
    await expect(resolve(f)).resolves.toStrictEqual({ outcome: "unavailable" });
    await expect(pin(f)).resolves.toStrictEqual({ outcome: "unavailable" });
    await accept(
      remote.setThreadOverride({
        headers: sessionHeaders,
        params,
        body: { enabled: true },
      }),
      [200],
    );
    await accept(
      remote.updateHostDefault({
        headers: sessionHeaders,
        params: host,
        body: { enabled: false },
      }),
      [200],
    );
    await expect(resolve(f)).resolves.toMatchObject({ outcome: "resolved" });
    await accept(
      remote.clearThreadOverride({ headers: sessionHeaders, params }),
      [200],
    );
    await expect(resolve(f)).resolves.toStrictEqual({ outcome: "unavailable" });
  });
});

describe("shared credential runtime authority", () => {
  const claimedFixture = useClaimedFixture();

  it("rotates every referencing host, preserves pins, invalidates the Run, and rebinds only one host", async () => {
    const f = await claimedFixture();
    const credentials = setupApp({ context, routes: sshConnectionsRoutes })(
      sshCredentialsContract,
    );
    const params = { credentialId: f.credentialId };
    const shared = await accept(
      config().create({
        headers: sessionHeaders,
        body: {
          id: randomUUID(),
          displayName: "Shared host",
          host: "shared.example.com",
          credential: { id: f.credentialId },
        },
      }),
      [201],
    );
    await enableHostDefault(f, shared.body.id);
    const unrelated = await accept(
      config().create({
        headers: sessionHeaders,
        body: {
          id: randomUUID(),
          displayName: "Unrelated",
          host: "unrelated.example.com",
          credential: inlineSshKey("other", "unrelated-key"),
        },
      }),
      [201],
    );
    await enableHostDefault(f, unrelated.body.id);
    await pin(f);
    const before = await list(f);
    context.mocks.ably.publish.mockClear();
    await accept(
      credentials.update({
        headers: sessionHeaders,
        params,
        body: { expectedRevision: 1, name: "Renamed login" },
      }),
      [200],
    );
    const renamed = await list(f);
    expect(
      renamed.map(({ generation }) => {
        return generation;
      }),
    ).toStrictEqual(
      before.map(({ generation }) => {
        return generation;
      }),
    );
    expect(context.mocks.ably.publish.mock.calls).toStrictEqual([
      ["ssh:changed", { orgId: f.orgId }],
    ]);

    context.mocks.ably.publish.mockClear();
    const password = "  password-canary\n";
    await accept(
      credentials.update({
        headers: sessionHeaders,
        params,
        body: {
          expectedRevision: 2,
          username: "operator",
          authentication: { method: "password", password },
        },
      }),
      [200],
    );
    expect(context.mocks.ably.publish.mock.calls).toStrictEqual([
      ["ssh:changed", { orgId: f.orgId }],
      ["ssh-authority-invalidated", { runId: f.runId, connectionId: null }],
    ]);
    const rotated = await list(f);
    for (const host of rotated) {
      const previous = before.find(({ id }) => {
        return id === host.id;
      });
      expect(host.generation).toBe(
        (previous?.generation ?? 0) +
          (host.credentialId === f.credentialId ? 1 : 0),
      );
      expect(host.learnedHostKey).toStrictEqual(previous?.learnedHostKey);
    }
    for (const connectionId of [f.connectionId, shared.body.id]) {
      const resolved = await resolve(f, { connectionId });
      expect(resolved).toMatchObject({
        outcome: "resolved_password",
        username: "operator",
        password,
      });
      expect(resolved).not.toHaveProperty("privateKey");
      expect(resolved).not.toHaveProperty("passphrase");
    }
    await expect(
      resolve(f, { connectionId: unrelated.body.id }),
    ).resolves.toMatchObject({
      outcome: "resolved",
      username: "other",
      privateKey: "unrelated-key",
    });
    const stalePin = await pin({ ...f, connectionId: shared.body.id }, 1);
    expect(stalePin.outcome).toBe("configuration_changed");
    const staleObservation = await accept(
      client().observe({
        params: { runId: f.runId },
        headers: runnerHeaders,
        body: {
          connectionId: shared.body.id,
          runnerIdentity: f.runnerIdentity,
          expectedGeneration: 1,
          observedAt: nowDate().toISOString(),
          failureReason: "authentication_failed",
        },
      }),
      [200],
    );
    expect(staleObservation.body.outcome).toBe("ignored");

    await accept(
      config().update({
        headers: sessionHeaders,
        params: { connectionId: shared.body.id },
        body: {
          expectedGeneration: 2,
          credential: { id: unrelated.body.credentialId },
        },
      }),
      [200],
    );
    await expect(
      resolve(f, { connectionId: shared.body.id }),
    ).resolves.toMatchObject({
      outcome: "resolved",
      generation: 3,
      username: "other",
      privateKey: "unrelated-key",
    });
    await expect(resolve(f)).resolves.toMatchObject({
      outcome: "resolved_password",
      password,
    });
    await accept(
      credentials.update({
        headers: sessionHeaders,
        params,
        body: {
          expectedRevision: 3,
          authentication: {
            method: "private_key",
            privateKey: "new-key",
            passphrase: null,
          },
        },
      }),
      [200],
    );
    const restored = await resolve(f);
    expect(restored).toMatchObject({
      outcome: "resolved",
      username: "operator",
      privateKey: "new-key",
      passphrase: null,
    });
    expect(restored).not.toHaveProperty("password");
    await expect(
      resolve(f, { connectionId: shared.body.id }),
    ).resolves.toMatchObject({
      outcome: "resolved",
      generation: 3,
      privateKey: "unrelated-key",
    });
  });
});

describe("SSH connection observations", () => {
  afterEach(ordinary.cleanup);
  const claimedFixture = useClaimedFixture();

  async function observe(
    f: Fixture,
    overrides: Partial<RunnerSshObservationRequest> = {},
  ) {
    return (
      await accept(
        client().observe({
          params: { runId: f.runId },
          headers: runnerHeaders,
          body: {
            connectionId: f.connectionId,
            runnerIdentity: f.runnerIdentity,
            expectedGeneration: 1,
            observedAt: nowDate().toISOString(),
            failureReason: "authentication_failed",
            ...overrides,
          },
        }),
        [200],
      )
    ).body;
  }

  async function observations(f: Owner) {
    authenticate(f);
    return (
      await accept(config().observations({ headers: sessionHeaders }), [200])
    ).body.observations;
  }

  it.each(["deploy", "ubuntu"])(
    "isolates credentials, trust and observations for a shared endpoint with sibling username %s",
    async (username) => {
      const f = await claimedFixture();
      const additional = await accept(
        config().create({
          headers: sessionHeaders,
          body: {
            id: randomUUID(),
            displayName: "Independent login",
            host: "SSH.example.com.",
            credential: inlineSshKey(
              username,
              "sibling-private-key",
              "sibling-passphrase",
            ),
          },
        }),
        [201],
      );
      await enableHostDefault(f, additional.body.id);
      const sibling = { ...f, connectionId: additional.body.id };
      expect(sibling.connectionId).not.toBe(f.connectionId);
      const siblingCredential = await resolve(sibling);
      expect(siblingCredential).toMatchObject({
        outcome: "resolved",
        host: "ssh.example.com",
        port: 22,
        username,
        privateKey: "sibling-private-key",
        passphrase: "sibling-passphrase",
        generation: 1,
        learnedHostKey: null,
      });
      await expect(resolve(f)).resolves.toMatchObject({
        outcome: "resolved",
        username: "deploy",
        privateKey,
        passphrase,
      });

      const observedAt = nowDate().toISOString();
      await expect(observe(f, { observedAt })).resolves.toStrictEqual({
        outcome: "recorded",
      });
      await expect(observe(sibling, { observedAt })).resolves.toStrictEqual({
        outcome: "recorded",
      });
      await expect(observations(f)).resolves.toHaveLength(2);
      await expect(pin(f)).resolves.toStrictEqual({
        outcome: "pinned",
        generation: 2,
      });
      await expect(resolve(sibling)).resolves.toStrictEqual(siblingCredential);
      const siblingObservations = [
        {
          connectionId: sibling.connectionId,
          generation: 1,
          observedAt,
          failureReason: "authentication_failed",
        },
      ];
      await expect(observations(f)).resolves.toStrictEqual(siblingObservations);

      await accept(
        config().update({
          headers: sessionHeaders,
          params: { connectionId: f.connectionId },
          body: {
            expectedGeneration: 2,
            credential: inlineSshKey(
              "rotated-login",
              "rotated-private-key",
              "rotated-passphrase",
            ),
          },
        }),
        [200],
      );
      await expect(resolve(f)).resolves.toMatchObject({
        outcome: "resolved",
        username: "rotated-login",
        privateKey: "rotated-private-key",
        passphrase: "rotated-passphrase",
        learnedHostKey: hostKey,
        generation: 3,
      });
      await expect(resolve(sibling)).resolves.toStrictEqual(siblingCredential);
      await expect(observations(f)).resolves.toStrictEqual(siblingObservations);

      await accept(
        config().resetHostKey({
          headers: sessionHeaders,
          params: { connectionId: f.connectionId },
          body: { expectedGeneration: 3 },
        }),
        [200],
      );
      await expect(resolve(f)).resolves.toMatchObject({
        outcome: "resolved",
        learnedHostKey: null,
        generation: 4,
      });
      await expect(resolve(sibling)).resolves.toStrictEqual(siblingCredential);

      await accept(
        config().delete({
          headers: sessionHeaders,
          params: { connectionId: f.connectionId },
        }),
        [204],
      );
      await expect(resolve(f)).resolves.toStrictEqual({
        outcome: "unavailable",
      });
      await expect(resolve(sibling)).resolves.toStrictEqual(siblingCredential);
      await expect(observations(f)).resolves.toStrictEqual(siblingObservations);
      await expect(list(f)).resolves.toMatchObject([
        { id: additional.body.id },
      ]);
    },
  );

  it("records bounded owner-only failures and recovery without changing configuration or invalidating credentials", async () => {
    const f = await claimedFixture();
    const original = await list(f);
    const kms = useSecretKmsProbe();
    context.mocks.ably.publish.mockClear();
    const failedAt = new Date(now() - 1000).toISOString();
    await expect(observe(f, { observedAt: failedAt })).resolves.toStrictEqual({
      outcome: "recorded",
    });
    await expect(observations(f)).resolves.toStrictEqual([
      {
        connectionId: f.connectionId,
        generation: 1,
        observedAt: failedAt,
        failureReason: "authentication_failed",
      },
    ]);
    await expect(list(f)).resolves.toStrictEqual(original);
    expect(kms.decryptCalls).toBe(0);
    expect(context.mocks.ably.publish.mock.calls).toStrictEqual([
      ["ssh:changed", { orgId: f.orgId }],
    ]);
    const other = await claimedFixture();
    await expect(observations(other)).resolves.toStrictEqual([]);
    const recoveredAt = nowDate().toISOString();
    await expect(
      observe(f, { observedAt: recoveredAt, failureReason: null }),
    ).resolves.toStrictEqual({ outcome: "recorded" });
    await expect(observations(f)).resolves.toStrictEqual([
      {
        connectionId: f.connectionId,
        generation: 1,
        observedAt: recoveredAt,
        failureReason: null,
      },
    ]);
    await expect(observe(f, { observedAt: failedAt })).resolves.toStrictEqual({
      outcome: "ignored",
    });
    await expect(
      observe(f, { observedAt: recoveredAt }),
    ).resolves.toStrictEqual({
      outcome: "ignored",
    });
    await expect(
      observe(f, {
        observedAt: new Date(now() + 120_000).toISOString(),
      }),
    ).resolves.toStrictEqual({ outcome: "ignored" });
    expect((await observations(f))[0]?.failureReason).toBeNull();
    context.mocks.ably.publish.mockClear();
    await expect(
      observe(f, {
        observedAt: new Date(now() + 1000).toISOString(),
        failureReason: null,
      }),
    ).resolves.toStrictEqual({ outcome: "recorded" });
    expect(context.mocks.ably.publish).not.toHaveBeenCalled();
  });

  it("fences configuration changes and uses the post-TOFU generation", async () => {
    const f = await claimedFixture();
    await observe(f);
    await expect(pin(f)).resolves.toStrictEqual({
      outcome: "pinned",
      generation: 2,
    });
    await expect(observations(f)).resolves.toStrictEqual([]);
    await expect(observe(f)).resolves.toStrictEqual({ outcome: "ignored" });
    await expect(observe(f, { expectedGeneration: 2 })).resolves.toStrictEqual({
      outcome: "recorded",
    });
    expect((await observations(f))[0]?.generation).toBe(2);
    await accept(
      config().update({
        headers: sessionHeaders,
        params: { connectionId: f.connectionId },
        body: {
          expectedGeneration: 2,
          credential: inlineSshKey("deploy", "replacement"),
        },
      }),
      [200],
    );
    await expect(observations(f)).resolves.toStrictEqual([]);
    await expect(observe(f, { expectedGeneration: 2 })).resolves.toStrictEqual({
      outcome: "ignored",
    });
    await expect(observe(f, { expectedGeneration: 3 })).resolves.toStrictEqual({
      outcome: "recorded",
    });
    await accept(
      config().delete({
        headers: sessionHeaders,
        params: { connectionId: f.connectionId },
      }),
      [204],
    );
    await expect(observations(f)).resolves.toStrictEqual([]);
    await expect(observe(f, { expectedGeneration: 3 })).resolves.toStrictEqual({
      outcome: "unavailable",
    });
  });

  it("requires official authentication and current winning-runner, owner, Run and chat authority", async () => {
    const f = await ordinaryFixture();
    const body = {
      connectionId: f.connectionId,
      runnerIdentity: f.runnerIdentity,
      expectedGeneration: 1,
      observedAt: nowDate().toISOString(),
      failureReason: null,
    };
    for (const headers of [
      sessionHeaders,
      { authorization: `Bearer ${f.sandboxToken}` },
      { authorization: "Bearer vm0_official_wrong" },
    ]) {
      expect(
        (await client().observe({ params: { runId: f.runId }, headers, body }))
          .status,
      ).toBe(401);
    }
    await expect(
      observe(f, {
        runnerIdentity: { ...f.runnerIdentity, runnerId: randomUUID() },
      }),
    ).resolves.toStrictEqual({ outcome: "unavailable" });
    await expect(
      observe(f, {
        runnerIdentity: { ...f.runnerIdentity, heartbeatGeneration: 1 },
      }),
    ).resolves.toStrictEqual({ outcome: "unavailable" });
    const other = await ordinaryFixture();
    await expect(
      observe(f, { connectionId: other.connectionId }),
    ).resolves.toStrictEqual({ outcome: "unavailable" });
    const completed = await ordinaryFixture();
    await ordinary.complete(completed);
    await expect(observe(completed)).resolves.toStrictEqual({
      outcome: "unavailable",
    });
    await setThreadHostOverride(f, false);
    await expect(observe(f)).resolves.toStrictEqual({ outcome: "unavailable" });
    await setThreadHostOverride(f, null);
    await expect(observe(f)).resolves.toStrictEqual({ outcome: "recorded" });
    authenticate(f);
    expect(
      (await config().observations({ headers: sessionHeaders })).status,
    ).toBe(200);
  });

  it("rejects diagnostic text and command outcomes instead of storing them as connection failures", async () => {
    const f = await claimedFixture();
    const raw = setupRawAppRequest({ context, routes: runnerSshRoutes });
    const body = {
      connectionId: f.connectionId,
      runnerIdentity: f.runnerIdentity,
      expectedGeneration: 1,
      observedAt: nowDate().toISOString(),
      failureReason: null,
    };
    for (const extra of [
      { error: privateKey },
      { command: "id" },
      { failureReason: "exec_rejected" },
      { failureReason: "cancelled" },
      { observedAt: "invalid" },
      { expectedGeneration: 0 },
    ]) {
      const response = await raw(
        `/api/runners/runs/${f.runId}/ssh/observations`,
        {
          method: "POST",
          headers: { ...runnerHeaders, "content-type": "application/json" },
          body: JSON.stringify({ ...body, ...extra }),
        },
      );
      expect(response.status).toBe(400);
    }
    await expect(observations(f)).resolves.toStrictEqual([]);
  });
});

describe("official Runner SSH authority", () => {
  const claimedFixture = useClaimedFixture();
  const publicRuns = createPublicRemoteAccessRunApi(context);
  afterEach(async () => {
    await publicRuns.cleanup();
    await selected.cleanup();
  });

  it("allows an ordinary owner and preserves a pinned connection", async () => {
    const f = await claimedFixture();
    await expect(resolve(f)).resolves.toMatchObject({ outcome: "resolved" });
    await expect(pin(f)).resolves.toMatchObject({ outcome: "pinned" });
    expect((await list(f))[0]?.learnedHostKey).toStrictEqual(hostKey);
    const kms = useSecretKmsProbe();
    await expect(resolve(f)).resolves.toMatchObject({ outcome: "resolved" });
    expect(kms.decryptCalls).toBe(2);
  });

  it("only delivers the exact current credential to the winning official process", async () => {
    const f = await claimedFixture();
    const kms = useSecretKmsProbe();
    await expect(resolve(f)).resolves.toStrictEqual({
      outcome: "resolved",
      host: "ssh.example.com",
      port: 22,
      username: "deploy",
      generation: 1,
      learnedHostKey: null,
      privateKey,
      passphrase,
    });
    expect(kms.decryptCalls).toBe(2);
    const response = await client().resolve({
      params: { runId: f.runId },
      headers: runnerHeaders,
      body: { connectionId: f.connectionId, runnerIdentity: f.runnerIdentity },
    });
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(JSON.stringify(await list(f))).not.toContain("canary");
  });

  it("rejects unauthenticated, session, guest and local Runner credentials before decryption", async () => {
    const f = await claimedFixture();
    const kms = useSecretKmsProbe();
    for (const authorization of [
      undefined,
      "Bearer vm0_official_wrong",
      "Bearer clerk-session",
      `Bearer ${f.sandboxToken}`,
    ]) {
      const r = await client().resolve({
        params: { runId: f.runId },
        headers: { authorization },
        body: {
          connectionId: f.connectionId,
          runnerIdentity: f.runnerIdentity,
        },
      });
      expect(r.status).toBe(401);
    }
    const authApi = createAuthOrgAgentsBddApi(context);
    const actor = authApi.user();
    authApi.mockClerkOrg(actor);
    const pat = await authApi.createCliToken(actor);
    const rejected = await client().pin({
      params: { runId: f.runId },
      headers: { authorization: `Bearer ${pat.token}` },
      body: {
        connectionId: f.connectionId,
        runnerIdentity: f.runnerIdentity,
        expectedGeneration: 1,
        observedHostKey: hostKey,
      },
    });
    expect(rejected.status).toBe(403);
    expect(kms.decryptCalls).toBe(0);
    expect((await list(f))[0]?.learnedHostKey).toBeNull();
  });

  it("returns indistinguishable unavailable for wrong claims and hidden or missing connections", async () => {
    const f = await selected.runtime();
    const foreign = await selected.runtime();
    const kms = useSecretKmsProbe();
    for (const override of [
      { connectionId: randomUUID() },
      { connectionId: foreign.connectionId },
      { runnerIdentity: { ...f.runnerIdentity, runnerId: randomUUID() } },
      { runnerIdentity: { ...f.runnerIdentity, heartbeatGeneration: 8 } },
    ]) {
      await expect(resolve(f, override)).resolves.toStrictEqual({
        outcome: "unavailable",
      });
    }
    await expect(resolve({ ...f, runId: randomUUID() })).resolves.toStrictEqual(
      {
        outcome: "unavailable",
      },
    );
    expect(kms.decryptCalls).toBe(0);
    await expect(
      pin({ ...f, connectionId: foreign.connectionId }),
    ).resolves.toStrictEqual({ outcome: "unavailable" });
    expect((await list(foreign))[0]?.learnedHostKey).toBeNull();
    // Same user, different organization must not grant access.
    const hiddenOwner = { ...f, orgId: `org_hidden_${randomUUID()}` };
    selected.trackOwner(hiddenOwner);
    authenticate(hiddenOwner);
    const hidden = await accept(
      config().create({
        headers: sessionHeaders,
        body: {
          id: randomUUID(),
          displayName: "Hidden host",
          host: "hidden.example.com",
          credential: inlineSshKey("deploy", privateKey),
        },
      }),
      [201],
    );
    await expect(
      resolve(f, { connectionId: hidden.body.id }),
    ).resolves.toStrictEqual({ outcome: "unavailable" });
    await expect(
      pin({ ...f, connectionId: hidden.body.id }),
    ).resolves.toStrictEqual({ outcome: "unavailable" });
    expect(kms.decryptCalls).toBe(0);
  });

  it("denies a pending Run and each real terminal state without decrypting credentials", async () => {
    const f = await selected.runtime();
    const pending = await selected.runs.start(f);
    let kms = useSecretKmsProbe();
    await expect(
      resolve({ ...f, runId: pending.runId }),
    ).resolves.toStrictEqual({ outcome: "unavailable" });
    await expect(pin({ ...f, runId: pending.runId })).resolves.toStrictEqual({
      outcome: "unavailable",
    });
    expect(kms.decryptCalls).toBe(0);
    for (const status of ["completed", "cancelled", "failed"] as const) {
      const run = await selected.runs.start(f);
      const claimed = await selected.runs.claim(run, runnerHeaders);
      await selected.runs.finish(claimed, status);
      kms = useSecretKmsProbe();
      await expect(resolve({ ...f, ...claimed })).resolves.toStrictEqual({
        outcome: "unavailable",
      });
      await expect(pin({ ...f, ...claimed })).resolves.toStrictEqual({
        outcome: "unavailable",
      });
      expect(kms.decryptCalls).toBe(0);
    }
  });

  it("checks current chat access and credential existence on every call", async () => {
    const owner = {
      orgId: `org_ssh_event_${randomUUID()}`,
      userId: `user_ssh_event_${randomUUID()}`,
    };
    authenticate(owner);
    const connection = await accept(
      config().create({
        headers: sessionHeaders,
        body: {
          id: randomUUID(),
          displayName: "SSH fixture",
          host: "ssh.example.com",
          credential: inlineSshKey("deploy", privateKey, passphrase),
        },
      }),
      [201],
    );
    await enableHostDefault(owner, connection.body.id);
    const run = await publicRuns.start(owner, "automation-event");
    const runtime = await publicRuns.claim(run, runnerHeaders);
    const f = {
      ...runtime,
      connectionId: connection.body.id,
      credentialId: connection.body.credentialId,
    };
    const kms = useSecretKmsProbe();
    authenticate(f);
    const remote = setupApp({ context, routes: chatRemoteAccessRoutes })(
      chatRemoteAccessContract,
    );
    const params = { protocol: "ssh" as const, connectionId: f.connectionId };
    await accept(
      remote.updateHostDefault({
        headers: sessionHeaders,
        params,
        body: { enabled: false },
      }),
      [200],
    );
    await expect(resolve(f)).resolves.toStrictEqual({ outcome: "unavailable" });
    await expect(pin(f)).resolves.toStrictEqual({ outcome: "unavailable" });
    await accept(
      remote.updateHostDefault({
        headers: sessionHeaders,
        params,
        body: { enabled: true },
      }),
      [200],
    );
    authenticate(f);
    await accept(
      config().delete({
        headers: sessionHeaders,
        params: { connectionId: f.connectionId },
      }),
      [204],
    );
    await expect(resolve(f)).resolves.toStrictEqual({ outcome: "unavailable" });
    await expect(pin(f)).resolves.toStrictEqual({ outcome: "unavailable" });
    expect(kms.decryptCalls).toBe(0);
  });

  it("reflects credential rotation and deletion without a cached admission", async () => {
    const f = await claimedFixture();
    await expect(pin(f)).resolves.toStrictEqual({
      outcome: "pinned",
      generation: 2,
    });
    authenticate(f);
    await accept(
      config().update({
        params: { connectionId: f.connectionId },
        headers: sessionHeaders,
        body: {
          expectedGeneration: 2,
          credential: inlineSshKey("new-user", "rotated-key"),
        },
      }),
      [200],
    );
    await expect(resolve(f)).resolves.toMatchObject({
      outcome: "resolved",
      generation: 3,
      username: "new-user",
      privateKey: "rotated-key",
      passphrase: null,
      learnedHostKey: hostKey,
    });
    await expect(pin(f)).resolves.toStrictEqual({
      outcome: "configuration_changed",
    });
    authenticate(f);
    await accept(
      config().delete({
        params: { connectionId: f.connectionId },
        headers: sessionHeaders,
      }),
      [204],
    );
    const kms = useSecretKmsProbe();
    await expect(resolve(f)).resolves.toStrictEqual({ outcome: "unavailable" });
    await expect(pin(f)).resolves.toStrictEqual({ outcome: "unavailable" });
    expect(kms.decryptCalls).toBe(0);
  });

  it("pins exactly once for concurrent equal observations and only accepts expected plus one", async () => {
    const f = await claimedFixture();
    const kms = useSecretKmsProbe();
    context.mocks.ably.publish.mockClear();
    const outcomes = await Promise.all([pin(f), pin(f), pin(f)]);
    expect(context.mocks.ably.publish.mock.calls).toStrictEqual([
      ["ssh:changed", { orgId: f.orgId }],
    ]);
    expect(
      outcomes.filter((r) => {
        return r.outcome === "pinned";
      }),
    ).toHaveLength(1);
    expect(
      outcomes.filter((r) => {
        return r.outcome === "matched";
      }),
    ).toHaveLength(2);
    await expect(pin(f, 2)).resolves.toStrictEqual({
      outcome: "configuration_changed",
    });
    await expect(pin(f, 3)).resolves.toStrictEqual({
      outcome: "configuration_changed",
    });
    expect(kms.decryptCalls).toBe(0);
    expect((await list(f))[0]).toMatchObject({
      generation: 2,
      learnedHostKey: hostKey,
    });
  });

  it("never overwrites trust when concurrent first observations disagree", async () => {
    const f = await claimedFixture();
    const result = await Promise.all([pin(f), pin(f, 1, otherHostKey)]);
    expect(
      result
        .map((r) => {
          return r.outcome;
        })
        .sort(),
    ).toStrictEqual(["host_key_mismatch", "pinned"]);
    const winner = result[0]?.outcome === "pinned" ? hostKey : otherHostKey;
    expect((await list(f))[0]).toMatchObject({
      generation: 2,
      learnedHostKey: winner,
    });
    const loser = winner === hostKey ? otherHostKey : hostKey;
    await expect(pin(f, 999, loser)).resolves.toStrictEqual({
      outcome: "host_key_mismatch",
    });
  });

  it("rejects stale endpoint edits and resets instead of silently repinning", async () => {
    const f = await claimedFixture();
    authenticate(f);
    await accept(
      config().update({
        params: { connectionId: f.connectionId },
        headers: sessionHeaders,
        body: {
          expectedGeneration: 1,
          host: "new.example.com",
        },
      }),
      [200],
    );
    await expect(pin(f, 1)).resolves.toStrictEqual({
      outcome: "configuration_changed",
    });
    await expect(pin(f, 2)).resolves.toStrictEqual({
      outcome: "pinned",
      generation: 3,
    });
    authenticate(f);
    await accept(
      config().resetHostKey({
        params: { connectionId: f.connectionId },
        headers: sessionHeaders,
        body: { expectedGeneration: 3 },
      }),
      [200],
    );
    await expect(pin(f, 2)).resolves.toStrictEqual({
      outcome: "configuration_changed",
    });
    await expect(pin(f, 4)).resolves.toStrictEqual({
      outcome: "pinned",
      generation: 5,
    });
    await expect(pin(f, 2)).resolves.toStrictEqual({
      outcome: "configuration_changed",
    });
    expect((await list(f))[0]).toMatchObject({
      generation: 5,
      learnedHostKey: hostKey,
    });
  });

  it("rejects malformed or extra authority fields before sensitive work", async () => {
    const f = await claimedFixture();
    const kms = useSecretKmsProbe();
    const raw = setupRawAppRequest({ context, routes: runnerSshRoutes });
    const base = {
      connectionId: f.connectionId,
      runnerIdentity: f.runnerIdentity,
    };
    for (const body of [
      { ...base, host: "attacker.example" },
      { ...base, command: "id" },
      { ...base, userId: f.userId },
      { ...base, connectionId: "not-a-uuid" },
      {
        ...base,
        runnerIdentity: { ...f.runnerIdentity, heartbeatGeneration: 0 },
      },
    ]) {
      const result = await raw(`/api/runners/runs/${f.runId}/ssh/resolve`, {
        method: "POST",
        headers: { ...runnerHeaders, "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      expect(result.status).toBe(400);
    }
    const invalidPin = await raw(`/api/runners/runs/${f.runId}/ssh/pin`, {
      method: "POST",
      headers: { ...runnerHeaders, "content-type": "application/json" },
      body: JSON.stringify({
        ...base,
        expectedGeneration: 1,
        observedHostKey: { algorithm: "ssh-dss", fingerprint: "bad" },
      }),
    });
    expect(invalidPin.status).toBe(400);
    expect(kms.decryptCalls).toBe(0);
    expect((await list(f))[0]?.learnedHostKey).toBeNull();
  });

  it("surfaces KMS failure and does not pin as a side effect of resolving", async () => {
    const f = await claimedFixture();
    useSecretKmsProbe(undefined, () => {
      return Promise.reject(new Error("KMS unavailable"));
    });
    const result = await client().resolve({
      params: { runId: f.runId },
      headers: runnerHeaders,
      body: { connectionId: f.connectionId, runnerIdentity: f.runnerIdentity },
    });
    expect(result.status).toBe(500);
    expect((await list(f))[0]?.learnedHostKey).toBeNull();
  });

  it("does not hold authorization locks across KMS or pretend to claw back an in-flight handoff", async () => {
    const f = await claimedFixture();
    const entered = createDeferredPromise<void>(context.signal);
    const release = createDeferredPromise<Uint8Array>(context.signal);
    useSecretKmsProbe(undefined, (_request, call) => {
      if (call === 1) {
        entered.resolve(undefined);
        return release.promise;
      }
      return undefined;
    });
    const pending = resolve(f);
    await entered.promise;
    const finishHandoff = async () => {
      release.resolve(Buffer.from("0123456789abcdef0123456789abcdef"));
      await pending;
    };
    await onRejection(
      (async () => {
        await setThreadHostOverride(f, false);
        await expect(resolve(f)).resolves.toStrictEqual({
          outcome: "unavailable",
        });
      })(),
      finishHandoff,
    );
    await finishHandoff();
    await expect(pending).resolves.toMatchObject({
      outcome: "resolved",
      privateKey,
    });
    await expect(pin(f)).resolves.toStrictEqual({ outcome: "unavailable" });
  });
});

const mutationClaimedFixture = useClaimedFixture();

test("concurrent winning-Runner pins publish exactly one trust generation", async () => {
  const f = await mutationClaimedFixture();
  const [before] = await list(f);
  if (!before) {
    throw new Error("Expected the claimed SSH Host");
  }
  const results = await joinAll([pin(f), pin(f)]);
  expect(
    results
      .map((result) => {
        return result.outcome;
      })
      .sort(),
  ).toStrictEqual(["matched", "pinned"]);
  for (const result of results) {
    expect(result).toStrictEqual({ outcome: result.outcome, generation: 2 });
  }
  const [after] = await list(f);
  if (!after) {
    throw new Error("Expected the pinned SSH Host");
  }
  expect(after).toStrictEqual({
    ...before,
    generation: 2,
    learnedHostKey: hostKey,
    updatedAt: after.updatedAt,
  });
});

test("overlapping winning-Runner observations retain the newest clock without changing Host metadata", async () => {
  const f = await mutationClaimedFixture();
  const before = await list(f);
  const newer = nowDate().toISOString();
  const older = new Date(now() - 1000).toISOString();
  const observe = async (
    observedAt: string,
    failureReason: "authentication_failed" | null,
  ) => {
    return (
      await accept(
        client().observe({
          params: { runId: f.runId },
          headers: runnerHeaders,
          body: {
            connectionId: f.connectionId,
            runnerIdentity: f.runnerIdentity,
            expectedGeneration: 1,
            observedAt,
            failureReason,
          },
        }),
        [200],
      )
    ).body;
  };
  const [oldResult, newResult] = await joinAll([
    observe(older, "authentication_failed"),
    observe(newer, null),
  ]);
  expect(["recorded", "ignored"]).toContain(oldResult.outcome);
  expect(newResult).toStrictEqual({ outcome: "recorded" });
  authenticate(f);
  const result = await accept(
    config().observations({ headers: sessionHeaders }),
    [200],
  );
  expect(result.body.observations).toStrictEqual([
    {
      connectionId: f.connectionId,
      generation: 1,
      observedAt: newer,
      failureReason: null,
    },
  ]);
  await expect(list(f)).resolves.toStrictEqual(before);
});

test.each(["insert", "replace", "remove"] as const)(
  "ssh override %s revocation preserves metadata and refuses the winning Runner",
  async (operation) => {
    const f = await mutationClaimedFixture();
    if (operation !== "insert") {
      authenticate(f);
      const remote = setupApp({ context, routes: chatRemoteAccessRoutes })(
        chatRemoteAccessContract,
      );
      await accept(
        remote.updateHostDefault({
          headers: sessionHeaders,
          params: { protocol: "ssh", connectionId: f.connectionId },
          body: { enabled: false },
        }),
        [200],
      );
      await setThreadHostOverride(f, true);
    }
    const before = await list(f);
    await setThreadHostOverride(f, operation === "remove" ? null : false);
    const kms = useSecretKmsProbe();
    await expect(resolve(f)).resolves.toStrictEqual({ outcome: "unavailable" });
    await expect(pin(f)).resolves.toStrictEqual({ outcome: "unavailable" });
    const observed = await accept(
      client().observe({
        params: { runId: f.runId },
        headers: runnerHeaders,
        body: {
          connectionId: f.connectionId,
          runnerIdentity: f.runnerIdentity,
          expectedGeneration: 1,
          observedAt: nowDate().toISOString(),
          failureReason: "authentication_failed",
        },
      }),
      [200],
    );
    expect(observed.body).toStrictEqual({ outcome: "unavailable" });
    expect(kms.decryptCalls).toBe(0);
    await expect(list(f)).resolves.toStrictEqual(before);
  },
);
