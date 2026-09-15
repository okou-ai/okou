import { inlineSshKey } from "./helpers/ssh-credential";
import { randomUUID } from "node:crypto";

import { triggerSourceSchema } from "@okouai/api-contracts/contracts/logs";
import {
  runnerSshContract,
  type RunnerSshResolveRequest,
  type RunnerSshObservationRequest,
} from "@okouai/api-contracts/contracts/runner-ssh";
import { sshConnectionsContract } from "@okouai/api-contracts/contracts/ssh-connections";
import { sshCredentialsContract } from "@okouai/api-contracts/contracts/ssh-credentials";
import {
  testSshConnectionStateContract,
  type TestSshConnectionStateActionBody,
} from "@okouai/api-contracts/contracts/test-ssh-connection-state";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { beforeEach, describe, expect, it } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp, setupRawAppRequest } from "../../../__tests__/test-helpers";
import { mockEnv } from "../../../lib/env";
import { now, nowDate } from "../../../lib/time";
import { createDeferredPromise, onRejection } from "../../utils";
import { runnerSshRoutes } from "../runner-ssh";
import { sshConnectionsRoutes } from "../ssh-connections";
import { testSshConnectionStateRoutes } from "../test-ssh-connection-state";
import { updateFeatureSwitchesForUser } from "./helpers/feature-switches";
import { useSecretKmsProbe } from "./helpers/secret-kms-probe";
import { createAuthOrgAgentsBddApi } from "./helpers/api-bdd-auth-org";
import { createRouteMocks } from "./helpers/route-test";

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
type RuntimeBody = Extract<
  TestSshConnectionStateActionBody,
  { action: "create-runtime" }
>;
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
function stateClient() {
  return setupApp({ context, routes: testSshConnectionStateRoutes })(
    testSshConnectionStateContract,
  );
}
function authenticate(owner: Owner) {
  mocks.clerk.session(owner.userId, owner.orgId);
}

async function createRuntime(
  owner: Owner,
  overrides: Partial<RuntimeBody> = {},
) {
  // Process generation is a bigint, independent of the connection's int generation.
  const runnerIdentity = {
    runnerId: randomUUID(),
    heartbeatGeneration: 5_000_000_000,
  };
  const r = await accept(
    stateClient().action({
      body: {
        action: "create-runtime",
        orgId: owner.orgId,
        userId: owner.userId,
        ...runnerIdentity,
        triggerSource: "web",
        status: "running",
        chat: true,
        access: true,
        ...overrides,
      },
    }),
    [200],
  );
  if (!r.body.runId || !r.body.agentId || !r.body.sandboxToken) {
    throw new Error("Missing runtime fixture identity");
  }
  return {
    runId: r.body.runId,
    agentId: r.body.agentId,
    sandboxToken: r.body.sandboxToken,
    runnerIdentity,
  };
}

async function fixture(runtimeOverrides: Partial<RuntimeBody> = {}) {
  const owner = {
    orgId: `org_ssh_jit_${randomUUID()}`,
    userId: `user_ssh_jit_${randomUUID()}`,
  };
  await updateFeatureSwitchesForUser(context, owner, {
    [FeatureSwitchKey.SshAccess]: true,
  });
  authenticate(owner);
  const connection = await accept(
    config().create({
      headers: sessionHeaders,
      body: {
        displayName: "SSH fixture",
        host: "ssh.example.com",
        credential: inlineSshKey("deploy", privateKey, passphrase),
      },
    }),
    [201],
  );
  const runtime = await createRuntime(owner, runtimeOverrides);
  return {
    ...owner,
    ...runtime,
    connectionId: connection.body.id,
    credentialId: connection.body.credentialId,
  };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

describe("SSH authority invalidation", () => {
  it("notifies all active owner Runs after committed edits, rotations, reset and deletion", async () => {
    const group = `ssh-cache-${randomUUID()}`;
    const f = await fixture({ runnerGroup: group });
    const withoutGrant = await createRuntime(f, {
      runnerGroup: group,
      access: false,
    });
    await createRuntime(f, { runnerGroup: group, status: "completed" });
    await fixture({ runnerGroup: `other-${randomUUID()}` });
    authenticate(f);
    const expected = [f.runId, withoutGrant.runId].map((runId) => {
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
          body: { expectedGeneration: generation, ...update },
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
    const f = await fixture({ runnerGroup: `ssh-cache-${randomUUID()}` });
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

  it("publishes only the successful generation when concurrent updates conflict", async () => {
    const f = await fixture({ runnerGroup: `ssh-cache-${randomUUID()}` });
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
      outcomes
        .map((result) => {
          return result.status;
        })
        .sort(),
    ).toStrictEqual([200, 409]);
    expect(context.mocks.ably.publish.mock.calls).toStrictEqual([
      ["ssh:changed", { orgId: f.orgId }],
      [
        "ssh-authority-invalidated",
        { runId: f.runId, connectionId: f.connectionId },
      ],
    ]);
  });

  it("invalidates the affected Agent's whole Run even after its grant is deleted", async () => {
    const f = await fixture({ runnerGroup: `ssh-cache-${randomUUID()}` });
    await createRuntime(f, { runnerGroup: `other-agent-${randomUUID()}` });
    context.mocks.ably.publish.mockClear();
    await accept(
      stateClient().action({
        body: {
          action: "set-agent-access",
          orgId: f.orgId,
          userId: f.userId,
          agentId: f.agentId,
          enabled: false,
        },
      }),
      [200],
    );
    expect(context.mocks.ably.publish.mock.calls).toStrictEqual([
      ["ssh:changed", { orgId: f.orgId }],
      ["ssh-authority-invalidated", { runId: f.runId, connectionId: null }],
    ]);
    await expect(resolve(f)).resolves.toStrictEqual({ outcome: "unavailable" });
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
async function access(f: Fixture, enabled: boolean) {
  await accept(
    stateClient().action({
      body: {
        action: "set-agent-access",
        orgId: f.orgId,
        userId: f.userId,
        agentId: f.agentId,
        enabled,
      },
    }),
    [200],
  );
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

describe("shared credential runtime authority", () => {
  it("rotates every referencing host, preserves pins, invalidates the Run, and rebinds only one host", async () => {
    const f = await fixture({ runnerGroup: `ssh-shared-${randomUUID()}` });
    const credentials = setupApp({ context, routes: sshConnectionsRoutes })(
      sshCredentialsContract,
    );
    const params = { credentialId: f.credentialId };
    const shared = await accept(
      config().create({
        headers: sessionHeaders,
        body: {
          displayName: "Shared host",
          host: "shared.example.com",
          credential: { id: f.credentialId },
        },
      }),
      [201],
    );
    const unrelated = await accept(
      config().create({
        headers: sessionHeaders,
        body: {
          displayName: "Unrelated",
          host: "unrelated.example.com",
          credential: inlineSshKey("other", "unrelated-key"),
        },
      }),
      [201],
    );
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
      const f = await fixture();
      const additional = await accept(
        config().create({
          headers: sessionHeaders,
          body: {
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
      await expect(list(f)).resolves.toStrictEqual([additional.body]);
    },
  );

  it("records bounded owner-only failures and recovery without changing configuration or invalidating credentials", async () => {
    const f = await fixture();
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
    const other = await fixture();
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
    const f = await fixture();
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

  it("requires official authentication and current winning-runner, owner, Run and grant authority", async () => {
    const f = await fixture();
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
    const other = await fixture();
    await expect(
      observe(f, { connectionId: other.connectionId }),
    ).resolves.toStrictEqual({ outcome: "unavailable" });
    const completed = await fixture({ status: "completed" });
    await expect(observe(completed)).resolves.toStrictEqual({
      outcome: "unavailable",
    });
    await access(f, false);
    await expect(observe(f)).resolves.toStrictEqual({ outcome: "unavailable" });
    await access(f, true);
    await updateFeatureSwitchesForUser(context, f, {
      [FeatureSwitchKey.SshAccess]: false,
    });
    await expect(observe(f)).resolves.toStrictEqual({ outcome: "unavailable" });
    authenticate(f);
    expect(
      (await config().observations({ headers: sessionHeaders })).status,
    ).toBe(404);
  });

  it("rejects diagnostic text and command outcomes instead of storing them as connection failures", async () => {
    const f = await fixture();
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
  it("allows an enabled ordinary owner and rechecks the switch on resolve and pin", async () => {
    const f = await fixture();
    await expect(resolve(f)).resolves.toMatchObject({ outcome: "resolved" });
    await expect(pin(f)).resolves.toMatchObject({ outcome: "pinned" });
    expect((await list(f))[0]?.learnedHostKey).toStrictEqual(hostKey);
    await updateFeatureSwitchesForUser(context, f, {
      [FeatureSwitchKey.SshAccess]: false,
    });
    const kms = useSecretKmsProbe();
    await expect(resolve(f)).resolves.toStrictEqual({
      outcome: "unavailable",
    });
    await expect(pin(f)).resolves.toStrictEqual({
      outcome: "unavailable",
    });
    expect(kms.decryptCalls).toBe(0);
  });

  it("rechecks authority after waiting for an owner connection lock", async () => {
    for (const change of ["revoke", "disable"] as const) {
      const f = await fixture({
        triggerSource: "automation-schedule",
        chat: false,
      });
      const scope = {
        orgId: f.orgId,
        userId: f.userId,
        connectionId: f.connectionId,
      };
      const lock = (
        action:
          | "hold-connection-lock"
          | "read-connection-lock"
          | "release-connection-lock",
      ) => {
        return accept(
          stateClient().action({ body: { action, ...scope } }),
          [200],
        );
      };
      const held = lock("hold-connection-lock");
      await expect
        .poll(async () => {
          return (await lock("read-connection-lock")).body.held;
        })
        .toBe(true);
      const pending = pin(f);
      const releaseLock = async () => {
        await lock("release-connection-lock");
        await Promise.all([held, pending]);
      };
      await onRejection(
        (async () => {
          await expect
            .poll(async () => {
              return (await lock("read-connection-lock")).body.waiting;
            })
            .toBe(true);
          if (change === "revoke") {
            await access(f, false);
          } else {
            await updateFeatureSwitchesForUser(context, f, {
              [FeatureSwitchKey.SshAccess]: false,
            });
          }
        })(),
        releaseLock,
      );
      await releaseLock();
      await expect(pending).resolves.toStrictEqual({ outcome: "unavailable" });
      await updateFeatureSwitchesForUser(context, f, {
        [FeatureSwitchKey.SshAccess]: true,
      });
      expect((await list(f))[0]).toMatchObject({
        generation: 1,
        learnedHostKey: null,
      });
    }
  });

  it("does not turn a malformed stored host identity into unavailable or decrypt credentials", async () => {
    const f = await fixture();
    await accept(
      stateClient().action({
        body: {
          action: "set-learned-host-key",
          orgId: f.orgId,
          userId: f.userId,
          connectionId: f.connectionId,
          algorithm: "ssh-dss",
          fingerprint: "invalid",
        },
      }),
      [200],
    );
    const kms = useSecretKmsProbe();
    const result = await client().resolve({
      params: { runId: f.runId },
      headers: runnerHeaders,
      body: { connectionId: f.connectionId, runnerIdentity: f.runnerIdentity },
    });
    expect(result.status).toBe(500);
    expect(kms.decryptCalls).toBe(0);
  });
  it("only delivers the exact current credential to the winning official process", async () => {
    const f = await fixture();
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
    const f = await fixture();
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
    const f = await fixture({ triggerSource: "webhook", chat: false });
    const foreign = await fixture();
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
    await updateFeatureSwitchesForUser(context, hiddenOwner, {
      [FeatureSwitchKey.SshAccess]: true,
    });
    authenticate(hiddenOwner);
    const hidden = await accept(
      config().create({
        headers: sessionHeaders,
        body: {
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

  it("treats every chat channel equally", async () => {
    const f = await fixture();
    for (const triggerSource of [
      "web",
      "slack",
      "teams",
      "feishu",
      "email",
      "telegram",
      "agentphone",
      "github",
    ] as const) {
      const runtime = await createRuntime(f, { triggerSource });
      await expect(resolve({ ...f, ...runtime })).resolves.toMatchObject({
        outcome: "resolved",
        privateKey,
      });
    }
  });

  it.each([...triggerSourceSchema.options, null])(
    "resolves and pins an authorized %s Run without a chat thread",
    async (triggerSource) => {
      const f = await fixture({ triggerSource, chat: false });
      await expect(resolve(f)).resolves.toMatchObject({
        outcome: "resolved",
        privateKey,
        learnedHostKey: null,
      });
      await expect(pin(f)).resolves.toStrictEqual({
        outcome: "pinned",
        generation: 2,
      });
      await expect(resolve(f)).resolves.toMatchObject({
        outcome: "resolved",
        learnedHostKey: hostKey,
        generation: 2,
      });
    },
  );

  it("denies inactive, unclaimed or ungranted Runs without a chat thread", async () => {
    const f = await fixture({ triggerSource: "automation-event", chat: false });
    const kms = useSecretKmsProbe();
    const denied: Partial<RuntimeBody>[] = [
      { access: false },
      { runnerId: null, heartbeatGeneration: null },
      { status: "pending" },
      { status: "completed" },
      { status: "cancelled" },
      { status: "failed" },
    ];
    for (const override of denied) {
      const runtime = await createRuntime(f, {
        triggerSource: "automation-event",
        chat: false,
        ...override,
      });
      await expect(resolve({ ...f, ...runtime })).resolves.toStrictEqual({
        outcome: "unavailable",
      });
      await expect(pin({ ...f, ...runtime })).resolves.toStrictEqual({
        outcome: "unavailable",
      });
    }
    expect(kms.decryptCalls).toBe(0);
  });

  it("checks current access, feature state and credential existence on every call", async () => {
    const f = await fixture({ triggerSource: "automation-event", chat: false });
    const kms = useSecretKmsProbe();
    await access(f, false);
    await expect(resolve(f)).resolves.toStrictEqual({ outcome: "unavailable" });
    await expect(pin(f)).resolves.toStrictEqual({ outcome: "unavailable" });
    await access(f, true);
    await updateFeatureSwitchesForUser(context, f, {
      [FeatureSwitchKey.SshAccess]: false,
    });
    await expect(resolve(f)).resolves.toStrictEqual({ outcome: "unavailable" });
    await expect(pin(f)).resolves.toStrictEqual({ outcome: "unavailable" });
    await updateFeatureSwitchesForUser(context, f, {
      [FeatureSwitchKey.SshAccess]: true,
    });
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
    const f = await fixture();
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
    const f = await fixture();
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
    const f = await fixture();
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
    const f = await fixture();
    authenticate(f);
    await accept(
      config().update({
        params: { connectionId: f.connectionId },
        headers: sessionHeaders,
        body: { expectedGeneration: 1, host: "new.example.com" },
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
    const f = await fixture();
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
    const f = await fixture();
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
    const f = await fixture();
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
        await access(f, false);
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
