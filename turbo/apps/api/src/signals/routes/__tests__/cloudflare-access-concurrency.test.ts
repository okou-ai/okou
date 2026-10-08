import { randomUUID } from "node:crypto";

import { cloudflareAccessContract } from "@okouai/api-contracts/contracts/cloudflare-access";
import { sshConnectionsContract } from "@okouai/api-contracts/contracts/ssh-connections";
import { sshCredentialsContract } from "@okouai/api-contracts/contracts/ssh-credentials";
import { chatRemoteAccessContract } from "@okouai/api-contracts/contracts/chat-remote-access";
import { runnerSshContract } from "@okouai/api-contracts/contracts/runner-ssh";
import { createStore, state } from "ccstate";
import { afterEach, beforeEach, describe, expect, it, test } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { mockEnv } from "../../../lib/env";
import { nowDate } from "../../../lib/time";
import { cloudflareAccessRoutes } from "../cloudflare-access";
import { chatRemoteAccessRoutes } from "../chat-remote-access";
import { runnerSshRoutes } from "../runner-ssh";
import { createClaimedSshRuntimeApi } from "./helpers/claimed-ssh-runtime";
import { sshConnectionsRoutes } from "../ssh-connections";
import { seedOrgMembership$ } from "./helpers/org-membership";
import { useSecretKmsProbe } from "./helpers/secret-kms-probe";

const context = testContext();
const store = createStore();
const query = Object.freeze({ view: "scoped" as const });
const identities$ = state<
  ReadonlyMap<
    string,
    { userId: string; orgId: string; orgRole: "org:admin" | "org:member" }
  >
>(new Map());
const configs = () => {
  return setupApp({ context, routes: cloudflareAccessRoutes })(
    cloudflareAccessContract,
  );
};
const hosts = () => {
  return setupApp({ context, routes: sshConnectionsRoutes })(
    sshConnectionsContract,
  );
};
const credentials = () => {
  return setupApp({ context, routes: sshConnectionsRoutes })(
    sshCredentialsContract,
  );
};
const login = Object.freeze({
  name: "Concurrent login",
  username: "deploy",
  authentication: {
    method: "password" as const,
    password: "synthetic-password",
  },
});

function authenticateSessions() {
  context.mocks.clerk.authenticateRequest.mockImplementation(
    (request: unknown) => {
      if (!(request instanceof Request)) {
        throw new Error("Expected a Clerk authentication request");
      }
      const identity = store
        .get(identities$)
        .get(request.headers.get("authorization") ?? "");
      if (!identity) {
        throw new Error("Unknown case-owned session");
      }
      return Promise.resolve({
        isAuthenticated: true,
        toAuth: () => {
          return identity;
        },
      });
    },
  );
}

const runnerSecret = "e".repeat(64);
const runnerHeaders = Object.freeze({
  authorization: `Bearer vm0_official_${runnerSecret}`,
});
const hostKey = Object.freeze({
  algorithm: "ssh-ed25519" as const,
  fingerprint: `SHA256:${Buffer.alloc(32, 3).toString("base64").replace(/=+$/u, "")}`,
});
const ordinary = createClaimedSshRuntimeApi(context, {
  runnerHeaders,
  authenticate: authenticateSessions,
});

beforeEach(() => {
  store.set(identities$, new Map());
  useSecretKmsProbe();
  authenticateSessions();
  mockEnv("OFFICIAL_RUNNER_SECRET", runnerSecret);
  context.mocks.s3.send.mockResolvedValue({ Contents: [] });
});

async function actor(
  orgId = `org_access_concurrency_${randomUUID()}`,
  role: "admin" | "member" = "admin",
) {
  const identity = { orgId, userId: `user_access_concurrency_${randomUUID()}` };
  const headers = { authorization: `Bearer clerk-session-${identity.userId}` };
  const identities = new Map(store.get(identities$));
  identities.set(headers.authorization, {
    ...identity,
    orgRole: `org:${role}`,
  });
  store.set(identities$, identities);
  await store.set(seedOrgMembership$, { ...identity, role }, context.signal);
  return { ...identity, headers };
}

async function sharedConfig(owner: Awaited<ReturnType<typeof actor>>) {
  return (
    await accept(
      configs().create({
        headers: owner.headers,
        query,
        body: {
          id: randomUUID(),
          scope: "organization",
          name: "Concurrent gateway",
          credentials: {
            clientId: "synthetic-id",
            clientSecret: "synthetic-secret",
          },
        },
      }),
      [201],
    )
  ).body;
}

function createHost(
  owner: Awaited<ReturnType<typeof actor>>,
  configId?: string,
) {
  return hosts().create({
    headers: owner.headers,
    body: {
      id: randomUUID(),
      displayName: "Concurrent host",
      host: "ssh.example.com",
      port: configId ? 443 : 22,
      credential: { create: login },
      ...(configId
        ? { transport: { type: "cloudflare_access" as const, configId } }
        : {}),
    },
  });
}

test.each(["create", "update"] as const)(
  "rejects selected %s after scope conversion during external login preparation without an orphan login",
  async (operation) => {
    const admin = await actor();
    const shared = await sharedConfig(admin);
    const member = await actor(admin.orgId, "member");
    const existing = (await accept(createHost(member), [201])).body;
    const beforeHosts = (
      await accept(hosts().list({ headers: member.headers }), [200])
    ).body;
    const beforeLogins = (
      await accept(credentials().list({ headers: member.headers }), [200])
    ).body;
    const preview = (
      await accept(
        configs().impactPreview({
          headers: admin.headers,
          params: { configId: shared.id },
          query: { operation: "convert" },
        }),
        [200],
      )
    ).body;

    useSecretKmsProbe(async (request, callNumber) => {
      if (callNumber === 1) {
        await accept(
          configs().convertToPersonal({
            headers: admin.headers,
            params: { configId: shared.id },
            body: {
              expectedRevision: preview.expectedRevision,
              impactSnapshot: preview.impactSnapshot,
            },
          }),
          [200],
        );
      }
      return {
        keyId: request.keyId,
        plaintext: Buffer.from("0123456789abcdef0123456789abcdef", "utf8"),
        encryptedDataKey: Buffer.from(
          `encrypted-data-key:${request.keyId}`,
          "utf8",
        ),
      };
    });
    const selected =
      operation === "create"
        ? accept(createHost(member, shared.id), [404])
        : accept(
            hosts().update({
              headers: member.headers,
              params: { connectionId: existing.id },
              body: {
                expectedGeneration: existing.generation,
                port: 443,
                credential: { create: login },
                transport: { type: "cloudflare_access", configId: shared.id },
              },
            }),
            [404],
          );
    expect((await selected).body.error.code).toBe(
      "CLOUDFLARE_ACCESS_NOT_FOUND",
    );
    expect(
      (await accept(hosts().list({ headers: member.headers }), [200])).body,
    ).toStrictEqual(beforeHosts);
    expect(
      (await accept(credentials().list({ headers: member.headers }), [200]))
        .body,
    ).toStrictEqual(beforeLogins);
    expect(
      (await accept(configs().list({ headers: member.headers, query }), [200]))
        .body.configs,
    ).toStrictEqual([]);
    expect(
      (await accept(configs().list({ headers: admin.headers, query }), [200]))
        .body.configs,
    ).toContainEqual(
      expect.objectContaining({
        id: shared.id,
        scope: "personal",
        revision: 2,
        generation: 2,
      }),
    );
  },
);

test.each(["create", "update"] as const)(
  "fences a concurrent selected %s against conversion and requires fresh impact before detaching it",
  async (operation) => {
    const admin = await actor();
    const shared = await sharedConfig(admin);
    const member = await actor(admin.orgId, "member");
    const direct = (await accept(createHost(member), [201])).body;
    const preview = (
      await accept(
        configs().impactPreview({
          headers: admin.headers,
          params: { configId: shared.id },
          query: { operation: "convert" },
        }),
        [200],
      )
    ).body;
    const selected =
      operation === "create"
        ? accept(createHost(member, shared.id), [201, 404])
        : accept(
            hosts().update({
              headers: member.headers,
              params: { connectionId: direct.id },
              body: {
                expectedGeneration: direct.generation,
                port: 443,
                credential: { create: login },
                transport: { type: "cloudflare_access", configId: shared.id },
              },
            }),
            [200, 404],
          );
    const [bound, converted] = await Promise.all([
      selected,
      accept(
        configs().convertToPersonal({
          headers: admin.headers,
          params: { configId: shared.id },
          body: {
            expectedRevision: preview.expectedRevision,
            impactSnapshot: preview.impactSnapshot,
          },
        }),
        [200, 409],
      ),
    ]);
    if (converted.status === 200) {
      expect(bound.status).toBe(404);
      expect(
        (await accept(hosts().list({ headers: member.headers }), [200])).body
          .connections,
      ).toStrictEqual([direct]);
      expect(
        (await accept(credentials().list({ headers: member.headers }), [200]))
          .body.credentials,
      ).toHaveLength(1);
    } else {
      expect(converted.body.error.code).toBe(
        "CLOUDFLARE_ACCESS_IMPACT_CONFLICT",
      );
      expect(bound.status).toBe(operation === "create" ? 201 : 200);
      if (bound.status === 404) {
        throw new Error("Expected a binding that changed the reviewed impact");
      }
      const saved = bound;
      const latest = (
        await accept(
          configs().impactPreview({
            headers: admin.headers,
            params: { configId: shared.id },
            query: { operation: "convert" },
          }),
          [200],
        )
      ).body;
      expect(latest.otherHostCount).toBe(1);
      await accept(
        configs().convertToPersonal({
          headers: admin.headers,
          params: { configId: shared.id },
          body: {
            expectedRevision: latest.expectedRevision,
            impactSnapshot: latest.impactSnapshot,
          },
        }),
        [200],
      );
      expect(
        (await accept(hosts().list({ headers: member.headers }), [200])).body
          .connections,
      ).toContainEqual(
        expect.objectContaining({
          id: saved.body.id,
          credentialId: saved.body.credentialId,
          host: saved.body.host,
          port: 443,
          generation: saved.body.generation + 1,
          transport: { type: "cloudflare_access", needsRebind: true },
        }),
      );
    }
    expect(
      (await accept(configs().list({ headers: member.headers, query }), [200]))
        .body.configs,
    ).toStrictEqual([]);
  },
);

test("requires a fresh deletion preview for a first concurrent member binding", async () => {
  const admin = await actor();
  const shared = await sharedConfig(admin);
  const member = await actor(admin.orgId, "member");
  const preview = (
    await accept(
      configs().impactPreview({
        headers: admin.headers,
        params: { configId: shared.id },
        query: { operation: "delete" },
      }),
      [200],
    )
  ).body;
  const [bound, deleted] = await Promise.all([
    accept(createHost(member, shared.id), [201, 404]),
    accept(
      configs().delete({
        headers: admin.headers,
        params: { configId: shared.id },
        body: {
          expectedRevision: preview.expectedRevision,
          impactSnapshot: preview.impactSnapshot,
        },
      }),
      [204, 409],
    ),
  ]);
  if (deleted.status === 204) {
    expect(bound.status).toBe(404);
    expect(
      (await accept(hosts().list({ headers: member.headers }), [200])).body
        .connections,
    ).toStrictEqual([]);
    expect(
      (await accept(credentials().list({ headers: member.headers }), [200]))
        .body.credentials,
    ).toStrictEqual([]);
  } else {
    expect(deleted.body.error.code).toBe("CLOUDFLARE_ACCESS_IMPACT_CONFLICT");
    const saved = await accept(Promise.resolve(bound), [201]);
    const latest = (
      await accept(
        configs().impactPreview({
          headers: admin.headers,
          params: { configId: shared.id },
          query: { operation: "delete" },
        }),
        [200],
      )
    ).body;
    expect(latest.otherHostCount).toBe(1);
    await accept(
      configs().delete({
        headers: admin.headers,
        params: { configId: shared.id },
        body: {
          expectedRevision: latest.expectedRevision,
          impactSnapshot: latest.impactSnapshot,
        },
      }),
      [204],
    );
    expect(
      (await accept(hosts().list({ headers: member.headers }), [200])).body
        .connections,
    ).toContainEqual(
      expect.objectContaining({
        id: saved.body.id,
        credentialId: saved.body.credentialId,
        generation: saved.body.generation + 1,
        port: 443,
        transport: { type: "cloudflare_access", needsRebind: true },
      }),
    );
  }
  expect(
    (await accept(configs().list({ headers: member.headers, query }), [200]))
      .body.configs,
  ).toStrictEqual([]);
});

test.each(["first", "late"] as const)(
  "includes %s concurrent bindings in current rotation authority without losing existing hosts",
  async (timing) => {
    const owner = await actor();
    const shared = await sharedConfig(owner);
    const existing =
      timing === "late"
        ? (await accept(createHost(owner, shared.id), [201])).body
        : undefined;
    const [rotated, first, second] = await Promise.all([
      accept(
        configs().update({
          headers: owner.headers,
          query,
          params: { configId: shared.id },
          body: {
            expectedRevision: shared.revision,
            credentials: {
              clientId: "rotated-id",
              clientSecret: "rotated-secret",
            },
          },
        }),
        [200, 409],
      ),
      accept(createHost(owner, shared.id), [201]),
      accept(createHost(owner, shared.id), [201]),
    ]);
    if (rotated.status === 409) {
      // Two separate arriving bindings may expand both attempts. That bounded
      // conflict must leave authority untouched, not silently replay a write.
      expect(rotated.body.error.code).toBe(
        "CLOUDFLARE_ACCESS_REVISION_CONFLICT",
      );
      const unchanged = (
        await accept(configs().list({ headers: owner.headers, query }), [200])
      ).body.configs;
      expect(unchanged).toContainEqual(
        expect.objectContaining({ id: shared.id, revision: 1, generation: 1 }),
      );
      const unchangedHosts = (
        await accept(hosts().list({ headers: owner.headers }), [200])
      ).body.connections;
      for (const saved of unchangedHosts) {
        expect(saved.generation).toBe(1);
        expect(saved).toMatchObject({
          transport: { type: "cloudflare_access", configId: shared.id },
        });
      }
      // The caller reviews the unchanged configuration after both saves finish
      // and explicitly makes a new request; this is not an automatic retry.
      await accept(
        configs().update({
          headers: owner.headers,
          query,
          params: { configId: shared.id },
          body: {
            expectedRevision: shared.revision,
            credentials: {
              clientId: "rotated-id",
              clientSecret: "rotated-secret",
            },
          },
        }),
        [200],
      );
    } else {
      expect(rotated.body).toMatchObject({ revision: 2, generation: 2 });
    }
    const listed = (
      await accept(hosts().list({ headers: owner.headers }), [200])
    ).body.connections;
    for (const created of [first.body, second.body]) {
      const saved = listed.find(({ id }) => {
        return id === created.id;
      });
      expect(saved).toMatchObject({
        credentialId: created.credentialId,
        host: created.host,
        port: 443,
        transport: { type: "cloudflare_access", configId: shared.id },
      });
      expect([created.generation, created.generation + 1]).toContain(
        saved?.generation,
      );
    }
    if (existing) {
      expect(listed).toContainEqual(
        expect.objectContaining({
          id: existing.id,
          generation: existing.generation + 1,
        }),
      );
    }
    const current = (
      await accept(configs().list({ headers: owner.headers, query }), [200])
    ).body.configs;
    expect(current).toContainEqual(
      expect.objectContaining({
        id: shared.id,
        revision: 2,
        generation: 2,
        sshHosts: expect.arrayContaining([
          expect.objectContaining({ id: first.body.id }),
          expect.objectContaining({ id: second.body.id }),
        ]),
      }),
    );
  },
);

test("serializes configuration rotation with independent-login deletion without losing the binding", async () => {
  const owner = await actor();
  const shared = await sharedConfig(owner);
  const host = (await accept(createHost(owner, shared.id), [201])).body;
  const [rotated, deleted] = await Promise.all([
    accept(
      configs().update({
        headers: owner.headers,
        query,
        params: { configId: shared.id },
        body: {
          expectedRevision: 1,
          credentials: {
            clientId: "rotated-id",
            clientSecret: "rotated-secret",
          },
        },
      }),
      [200],
    ),
    accept(
      credentials().delete({
        headers: owner.headers,
        params: { credentialId: host.credentialId },
        body: { expectedRevision: 1 },
      }),
      [409],
    ),
  ]);
  expect(rotated.body.generation).toBe(2);
  expect(deleted.body.error.code).toBe("SSH_CREDENTIAL_IN_USE");
  expect(
    (await accept(hosts().list({ headers: owner.headers }), [200])).body
      .connections,
  ).toContainEqual(
    expect.objectContaining({
      id: host.id,
      credentialId: host.credentialId,
      generation: host.generation + 1,
      transport: { type: "cloudflare_access", configId: shared.id },
    }),
  );
  expect(
    (await accept(credentials().list({ headers: owner.headers }), [200])).body
      .credentials,
  ).toContainEqual(
    expect.objectContaining({
      id: host.credentialId,
      revision: 1,
      username: "deploy",
    }),
  );
});

describe("protected host writes with authorized Runner authority", () => {
  afterEach(ordinary.cleanup);

  async function claimedHost() {
    const owner = await actor();
    const runtime = await ordinary.runtime(owner);
    const shared = await sharedConfig(owner);
    const host = (await accept(createHost(owner, shared.id), [201])).body;
    await accept(
      setupApp({ context, routes: chatRemoteAccessRoutes })(
        chatRemoteAccessContract,
      ).updateHostDefault({
        headers: owner.headers,
        params: { protocol: "ssh", connectionId: host.id },
        body: { enabled: true },
      }),
      [200],
    );
    const runner = setupApp({ context, routes: runnerSshRoutes })(
      runnerSshContract,
    );
    const request = {
      headers: runnerHeaders,
      params: { runId: runtime.runId },
      body: { connectionId: host.id, runnerIdentity: runtime.runnerIdentity },
    };
    return { owner, shared, host, runner, request };
  }

  it("rejects an edit delayed at KMS after Runner learns trust, without replacing the pin or leaving an inline login", async () => {
    const { owner, shared, host, runner, request } = await claimedHost();
    const beforeLogins = (
      await accept(credentials().list({ headers: owner.headers }), [200])
    ).body;
    useSecretKmsProbe(async (kmsRequest, callNumber) => {
      if (callNumber === 1) {
        expect(
          (
            await accept(
              runner.pin({
                ...request,
                body: {
                  ...request.body,
                  expectedGeneration: host.generation,
                  observedHostKey: hostKey,
                },
              }),
              [200],
            )
          ).body,
        ).toMatchObject({ outcome: "pinned", generation: host.generation + 1 });
      }
      return {
        keyId: kmsRequest.keyId,
        plaintext: Buffer.from("0123456789abcdef0123456789abcdef", "utf8"),
        encryptedDataKey: Buffer.from(
          `encrypted-data-key:${kmsRequest.keyId}`,
          "utf8",
        ),
      };
    });
    const edited = await accept(
      hosts().update({
        headers: owner.headers,
        params: { connectionId: host.id },
        body: {
          expectedGeneration: host.generation,
          credential: {
            create: {
              ...login,
              authentication: {
                method: "password",
                password: "never-committed-password",
              },
            },
          },
          transport: { type: "cloudflare_access", configId: shared.id },
        },
      }),
      [409],
    );
    expect(edited.body.error.code).toBe("SSH_GENERATION_CONFLICT");
    expect(
      (await accept(credentials().list({ headers: owner.headers }), [200]))
        .body,
    ).toStrictEqual(beforeLogins);
    expect(
      (await accept(hosts().list({ headers: owner.headers }), [200])).body
        .connections,
    ).toContainEqual(
      expect.objectContaining({
        id: host.id,
        host: host.host,
        port: host.port,
        credentialId: host.credentialId,
        generation: host.generation + 1,
        learnedHostKey: hostKey,
        transport: { type: "cloudflare_access", configId: shared.id },
      }),
    );
    expect((await accept(runner.resolve(request), [200])).body).toMatchObject({
      outcome: "resolved_access",
      generation: host.generation + 1,
      learnedHostKey: hostKey,
      authentication: {
        method: "password",
        password: login.authentication.password,
      },
      access: { configId: shared.id, generation: shared.generation },
    });
  });

  it("serializes rotation with pin and observation, retaining learned trust and independent login", async () => {
    const { owner, shared, host, runner, request } = await claimedHost();
    const [rotated, pinned, observed] = await Promise.all([
      accept(
        configs().update({
          headers: owner.headers,
          query,
          params: { configId: shared.id },
          body: {
            expectedRevision: shared.revision,
            credentials: {
              clientId: "rotated-id",
              clientSecret: "rotated-secret",
            },
          },
        }),
        [200],
      ),
      accept(
        runner.pin({
          ...request,
          body: {
            ...request.body,
            expectedGeneration: host.generation,
            observedHostKey: hostKey,
          },
        }),
        [200],
      ),
      accept(
        runner.observe({
          ...request,
          body: {
            ...request.body,
            expectedGeneration: host.generation,
            observedAt: nowDate().toISOString(),
            failureReason: null,
          },
        }),
        [200],
      ),
    ]);
    expect(rotated.body).toMatchObject({ revision: 2, generation: 2 });
    expect(["pinned", "configuration_changed"]).toContain(pinned.body.outcome);
    expect(["recorded", "ignored"]).toContain(observed.body.outcome);
    const saved = (
      await accept(hosts().list({ headers: owner.headers }), [200])
    ).body.connections.find(({ id }) => {
      return id === host.id;
    });
    if (!saved) {
      throw new Error("Expected the retained protected SSH host");
    }
    expect(saved).toMatchObject({
      credentialId: host.credentialId,
      host: host.host,
      port: host.port,
      transport: { type: "cloudflare_access", configId: shared.id },
    });
    expect(saved.generation).toBe(
      host.generation + 1 + Number(pinned.body.outcome === "pinned"),
    );
    if (pinned.body.outcome === "pinned") {
      expect(saved.learnedHostKey).toStrictEqual(hostKey);
    } else {
      expect(saved.learnedHostKey).toBeNull();
      expect(
        (
          await accept(
            runner.pin({
              ...request,
              body: {
                ...request.body,
                expectedGeneration: saved.generation,
                observedHostKey: hostKey,
              },
            }),
            [200],
          )
        ).body,
      ).toMatchObject({ outcome: "pinned", generation: saved.generation + 1 });
    }
    expect((await accept(runner.resolve(request), [200])).body).toMatchObject({
      outcome: "resolved_access",
      username: login.username,
      authentication: {
        method: "password",
        password: login.authentication.password,
      },
      learnedHostKey: hostKey,
      access: {
        configId: shared.id,
        generation: 2,
        clientId: "rotated-id",
        clientSecret: "rotated-secret",
      },
    });
    expect(
      (await accept(hosts().observations({ headers: owner.headers }), [200]))
        .body.observations,
    ).toStrictEqual([]);
    expect(
      (await accept(credentials().list({ headers: owner.headers }), [200])).body
        .credentials,
    ).toContainEqual(
      expect.objectContaining({
        id: host.credentialId,
        revision: 1,
        username: login.username,
      }),
    );
  });
});
