import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { tailscaleContract } from "@okouai/api-contracts/contracts/tailscale";
import { sshConnectionsContract } from "@okouai/api-contracts/contracts/ssh-connections";
import { sshCredentialsContract } from "@okouai/api-contracts/contracts/ssh-credentials";
import { runnerSshContract } from "@okouai/api-contracts/contracts/runner-ssh";
import { chatRemoteAccessContract } from "@okouai/api-contracts/contracts/chat-remote-access";
import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp, setupRawAppRequest } from "../../../__tests__/test-helpers";
import { mockEnv } from "../../../lib/env";
import { nowDate } from "../../../lib/time";
import { tailscaleRoutes } from "../tailscale";
import { sshConnectionsRoutes } from "../ssh-connections";
import { runnerSshRoutes } from "../runner-ssh";
import { chatRemoteAccessRoutes } from "../chat-remote-access";
import { createRouteMocks } from "./helpers/route-test";
import { createClaimedSshRuntimeApi } from "./helpers/claimed-ssh-runtime";
import { useSecretKmsProbe } from "./helpers/secret-kms-probe";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { createDeferredPromise, joinAll } from "../../utils";

const context = testContext();
const mocks = createRouteMocks(context);
const headers = Object.freeze({ authorization: "Bearer clerk-session" });
const secret = "e".repeat(64);
const runnerHeaders = Object.freeze({
  authorization: `Bearer vm0_official_${secret}`,
});
const oauth = Object.freeze({
  clientId: "oauth-id-canary",
  clientSecret: "oauth-secret-canary",
});
const login = Object.freeze({
  name: "Login",
  username: "deploy",
  authentication: {
    method: "password" as const,
    password: " ssh-login-canary ",
  },
});
const key = Object.freeze({
  algorithm: "ssh-ed25519" as const,
  fingerprint: `SHA256:${Buffer.alloc(32, 4).toString("base64").replace(/=+$/u, "")}`,
});
type Owner = { orgId: string; userId: string };
function authenticate(
  owner: Owner,
  role: "org:member" | "org:admin" = "org:member",
) {
  mocks.clerk.session(owner.userId, owner.orgId, role);
  context.mocks.clerk.users.getOrganizationMembershipList.mockResolvedValue({
    data: [
      {
        role,
        organization: { id: owner.orgId },
        publicUserData: { userId: owner.userId },
      },
    ],
  });
}
function owner(
  partial: Partial<Owner> = {},
  role: "org:member" | "org:admin" = "org:member",
) {
  const result = {
    orgId: `org_tailscale_${randomUUID()}`,
    userId: `user_tailscale_${randomUUID()}`,
    ...partial,
  };
  authenticate(result, role);
  return result;
}
const configs = () => {
  return setupApp({ context, routes: tailscaleRoutes })(tailscaleContract);
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
const runner = () => {
  return setupApp({ context, routes: runnerSshRoutes })(runnerSshContract);
};
const remote = () => {
  return setupApp({ context, routes: chatRemoteAccessRoutes })(
    chatRemoteAccessContract,
  );
};
const observations = () => {
  return { list: hosts().observations };
};
async function config(scope: "personal" | "organization" = "personal") {
  return (
    await accept(
      configs().create({
        headers,
        body: {
          id: randomUUID(),
          name: "Private network",
          credentials: oauth,
          tags: ["tag:okou"],
          scope,
        },
      }),
      [201],
    )
  ).body;
}
async function host(configId: string, peer = "peer.tail-test.ts.net") {
  return (
    await accept(
      hosts().create({
        headers,
        body: {
          id: randomUUID(),
          displayName: "Private host",
          host: peer,
          port: 2222,
          credential: { create: login },
          transport: { type: "tailscale", configId },
        },
      }),
      [201],
    )
  ).body;
}
async function resources() {
  return {
    configs: (await accept(configs().list({ headers }), [200])).body.configs,
    hosts: (await accept(hosts().list({ headers }), [200])).body.connections,
    logins: (await accept(credentials().list({ headers }), [200])).body
      .credentials,
  };
}
const ordinary = createClaimedSshRuntimeApi(context, {
  runnerHeaders,
  authenticate,
});
beforeEach(() => {
  mockEnv("OFFICIAL_RUNNER_SECRET", secret);
  useSecretKmsProbe();
});

describe("Tailscale configuration and saved-host authority", () => {
  afterEach(ordinary.cleanup);
  it("keeps OAuth write-only, supports explicit-ID reconciliation and separates metadata/effective generations", async () => {
    owner();
    const body = {
      id: randomUUID(),
      name: "Network",
      credentials: oauth,
      tags: ["tag:okou"],
    };
    const created = (await accept(configs().create({ headers, body }), [201]))
      .body;
    expect(created).toMatchObject({
      revision: 1,
      generation: 1,
      scope: "personal",
      sshHosts: [],
    });
    await accept(
      configs().create({
        headers,
        body: {
          ...body,
          credentials: { ...oauth, clientSecret: "replacement-cannot-replay" },
        },
      }),
      [204],
    );
    const renamed = (
      await accept(
        configs().update({
          headers,
          params: { configId: created.id },
          body: { expectedRevision: 1, name: "Renamed" },
        }),
        [200],
      )
    ).body;
    expect(renamed).toMatchObject({ revision: 2, generation: 1 });
    const replaced = (
      await accept(
        configs().update({
          headers,
          params: { configId: created.id },
          body: { expectedRevision: 2, credentials: oauth },
        }),
        [200],
      )
    ).body;
    expect(replaced).toMatchObject({ revision: 3, generation: 2 });
    await accept(
      configs().update({
        headers,
        params: { configId: created.id },
        body: { expectedRevision: 2, name: "Stale rename" },
      }),
      [409],
    );
    const metadata = await resources();
    expect(JSON.stringify(metadata)).not.toMatch(
      /oauth-id-canary|oauth-secret-canary|encryptedClient|clientSecret|clientId/u,
    );
    expect(metadata.configs).toStrictEqual([replaced]);
    await accept(
      configs().delete({
        headers,
        params: { configId: created.id },
        body: { expectedRevision: 3 },
      }),
      [204],
    );
  });
  it("permits only admin shared management, hides Personal/tenant IDs and other members' host references", async () => {
    const admin = owner({}, "org:admin");
    const shared = await config("organization");
    const personal = await config();
    const member = owner({ orgId: admin.orgId });
    const saved = await host(shared.id);
    expect((await resources()).configs).toMatchObject([
      { id: shared.id, sshHosts: [{ id: saved.id }] },
    ]);
    await accept(
      configs().update({
        headers,
        params: { configId: shared.id },
        body: { expectedRevision: 1, name: "Forbidden rename" },
      }),
      [403],
    );
    await accept(
      configs().create({
        headers,
        body: {
          id: randomUUID(),
          name: "Forbidden",
          scope: "organization",
          credentials: oauth,
          tags: ["tag:okou"],
        },
      }),
      [403],
    );
    expect(
      (await resources()).configs.map((value) => {
        return value.id;
      }),
    ).not.toContain(personal.id);
    await accept(
      hosts().create({
        headers,
        body: {
          id: randomUUID(),
          displayName: "Hidden",
          host: "peer",
          credential: { create: login },
          transport: { type: "tailscale", configId: personal.id },
        },
      }),
      [404],
    );
    expect((await resources()).logins).toHaveLength(1);
    authenticate(admin, "org:admin");
    expect(
      (await resources()).configs.find((value) => {
        return value.id === shared.id;
      })?.sshHosts,
    ).toStrictEqual([]);
    const inUse = await accept(
      configs().delete({
        headers,
        params: { configId: shared.id },
        body: { expectedRevision: 1 },
      }),
      [409],
    );
    expect(JSON.stringify(inUse.body)).not.toContain(saved.id);
    owner();
    expect((await resources()).configs).toStrictEqual([]);
    authenticate(member);
    await accept(
      hosts().delete({ headers, params: { connectionId: saved.id } }),
      [204],
    );
    authenticate(admin, "org:admin");
    await accept(
      configs().delete({
        headers,
        params: { configId: shared.id },
        body: { expectedRevision: 1 },
      }),
      [204],
    );
  });
  it.each(["create", "update"] as const)(
    "%s atomically supports every independent new/reused network and login combination",
    async (operation) => {
      owner();
      const existing = await config();
      let current = await host(existing.id);
      for (const newNetwork of [false, true]) {
        for (const newLogin of [false, true]) {
          const before = await resources();
          const transport = newNetwork
            ? {
                type: "tailscale" as const,
                create: {
                  name: "Inline network",
                  credentials: oauth,
                  tags: ["tag:okou"],
                },
              }
            : { type: "tailscale" as const, configId: existing.id };
          const fields = {
            displayName: "Combined",
            host: "100.64.2.3",
            port: 65_535,
            transport,
            credential: newLogin
              ? { create: login }
              : { id: current.credentialId },
          };
          current =
            operation === "create"
              ? (
                  await accept(
                    hosts().create({
                      headers,
                      body: { id: randomUUID(), ...fields },
                    }),
                    [201],
                  )
                ).body
              : (
                  await accept(
                    hosts().update({
                      headers,
                      params: { connectionId: current.id },
                      body: {
                        expectedGeneration: current.generation,
                        ...fields,
                      },
                    }),
                    [200],
                  )
                ).body;
          const after = await resources();
          expect(current).toMatchObject({
            port: 65_535,
            transport: { type: "tailscale" },
          });
          expect(after.configs).toHaveLength(
            before.configs.length + Number(newNetwork),
          );
          expect(after.logins).toHaveLength(
            before.logins.length + Number(newLogin),
          );
          expect(JSON.stringify(current)).not.toContain(oauth.clientSecret);
        }
      }
      const before = await resources();
      await accept(
        hosts().update({
          headers,
          params: { connectionId: current.id },
          body: {
            expectedGeneration: current.generation + 1,
            credential: { create: login },
            transport: {
              type: "tailscale",
              create: {
                name: "Should rollback",
                credentials: oauth,
                tags: ["tag:okou"],
              },
            },
          },
        }),
        [409],
      );
      await expect(resources()).resolves.toStrictEqual(before);
    },
  );
  it("reconciles a host-create retry without overwriting its inline resources and rolls back conflicts", async () => {
    const first = owner();
    const body = {
      id: randomUUID(),
      displayName: "Atomic",
      host: "peer",
      credential: { create: login },
      transport: {
        type: "tailscale" as const,
        create: {
          name: "Inline",
          credentials: oauth,
          tags: ["tag:okou"],
        },
      },
    };
    await accept(hosts().create({ headers, body }), [201]);
    const before = await resources();
    await accept(hosts().create({ headers, body }), [204]);
    await expect(resources()).resolves.toStrictEqual(before);
    await accept(
      hosts().create({ headers, body: { ...body, id: randomUUID() } }),
      [201],
    );
    expect((await resources()).configs).toHaveLength(before.configs.length + 1);
    owner({ orgId: first.orgId });
    await accept(hosts().create({ headers, body }), [409]);
    await expect(resources()).resolves.toStrictEqual({
      configs: [],
      hosts: [],
      logins: [],
    });
  });
  it.each([
    "10.0.0.1",
    "127.0.0.1",
    "100.63.255.1",
    "100.128.0.1",
    "::1",
    "fd00::1",
    "peer%zone",
    "100.064.0.1",
    "*.tail.net",
    "https://peer",
    "host..tail.net",
    "秘密.tail.net",
    "0x7f000001",
  ])(
    "rejects non-peer target syntax %s without saving resources",
    async (peer) => {
      owner();
      const before = await resources();
      await accept(
        hosts().create({
          headers,
          body: {
            id: randomUUID(),
            displayName: "Invalid",
            host: peer,
            credential: { create: login },
            transport: {
              type: "tailscale",
              create: {
                name: "No side effects",
                credentials: oauth,
                tags: ["tag:okou"],
              },
            },
          },
        }),
        [400],
      );
      await expect(resources()).resolves.toStrictEqual(before);
    },
  );
  it.each([
    "PEER",
    "peer.tail-test.ts.net.",
    "100.64.0.1",
    "fd7a:115c:a1e0::1",
  ])(
    "accepts syntax-only peer target %s and retains its binding on edit",
    async (peer) => {
      owner();
      const c = await config();
      const saved = await host(c.id, peer);
      const updated = (
        await accept(
          hosts().update({
            headers,
            params: { connectionId: saved.id },
            body: {
              expectedGeneration: saved.generation,
              displayName: "Rename",
            },
          }),
          [200],
        )
      ).body;
      expect(updated).toMatchObject({
        transport: { type: "tailscale", configId: c.id },
        port: 2222,
      });
    },
  );
  it("uses current winning process/host/chat/config authority and the shared host generation fence without a backend rollout flag", async () => {
    const o = owner();
    const c = await config();
    const h = await host(c.id);
    const r = await ordinary.runtime(o);
    const params = { runId: r.runId };
    const body = { connectionId: h.id, runnerIdentity: r.runnerIdentity };
    let probe = useSecretKmsProbe();
    expect(
      (
        await accept(
          runner().resolve({ headers: runnerHeaders, params, body }),
          [200],
        )
      ).body,
    ).toStrictEqual({ outcome: "unavailable" });
    expect(probe.decryptCalls).toBe(0);
    await accept(
      remote().updateHostDefault({
        headers,
        params: { protocol: "ssh", connectionId: h.id },
        body: { enabled: true },
      }),
      [200],
    );
    const resolved = (
      await accept(
        runner().resolve({ headers: runnerHeaders, params, body }),
        [200],
      )
    ).body;
    expect(resolved).toMatchObject({
      outcome: "resolved_tailscale",
      host: h.host,
      authentication: login.authentication,
      tailscale: {
        ...oauth,
        configId: c.id,
        generation: 1,
        tags: ["tag:okou"],
      },
    });
    probe = useSecretKmsProbe();
    for (const stale of [
      { ...body, connectionId: randomUUID() },
      {
        ...body,
        runnerIdentity: { ...r.runnerIdentity, runnerId: randomUUID() },
      },
      {
        ...body,
        runnerIdentity: {
          ...r.runnerIdentity,
          heartbeatGeneration: r.runnerIdentity.heartbeatGeneration + 1,
        },
      },
    ]) {
      expect(
        (
          await accept(
            runner().resolve({ headers: runnerHeaders, params, body: stale }),
            [200],
          )
        ).body,
      ).toStrictEqual({ outcome: "unavailable" });
    }
    await accept(runner().resolve({ headers, params, body }), [401]);
    expect(probe.decryptCalls).toBe(0);
    const pinInput = {
      ...body,
      expectedGeneration: h.generation,
      observedHostKey: key,
    };
    for (const expectedGeneration of [h.generation + 1, h.generation + 2]) {
      expect(
        (
          await accept(
            runner().pin({
              headers: runnerHeaders,
              params,
              body: { ...pinInput, expectedGeneration },
            }),
            [200],
          )
        ).body,
      ).toStrictEqual({ outcome: "configuration_changed" });
    }
    expect(probe.decryptCalls).toBe(0);
    expect(
      (
        await accept(
          runner().pin({ headers: runnerHeaders, params, body: pinInput }),
          [200],
        )
      ).body,
    ).toStrictEqual({ outcome: "pinned", generation: h.generation + 1 });
    const obs = {
      ...body,
      expectedGeneration: h.generation + 1,
      observedAt: nowDate().toISOString(),
      failureReason: null,
    };
    expect(
      (
        await accept(
          runner().observe({ headers: runnerHeaders, params, body: obs }),
          [200],
        )
      ).body,
    ).toStrictEqual({ outcome: "recorded" });
    expect(
      (await accept(observations().list({ headers }), [200])).body.observations,
    ).toHaveLength(1);
    const rotated = (
      await accept(
        configs().update({
          headers,
          params: { configId: c.id },
          body: { expectedRevision: 1, tags: ["tag:next"] },
        }),
        [200],
      )
    ).body;
    expect(rotated.generation).toBe(2);
    expect(
      (await accept(hosts().list({ headers }), [200])).body.connections[0],
    ).toMatchObject({ generation: h.generation + 2, learnedHostKey: key });
    expect(
      (await accept(observations().list({ headers }), [200])).body.observations,
    ).toStrictEqual([]);
    expect(
      (
        await accept(
          runner().pin({
            headers: runnerHeaders,
            params,
            body: {
              ...pinInput,
            },
          }),
          [200],
        )
      ).body,
    ).toStrictEqual({ outcome: "configuration_changed" });
    expect(
      (
        await accept(
          runner().observe({ headers: runnerHeaders, params, body: obs }),
          [200],
        )
      ).body,
    ).toStrictEqual({ outcome: "ignored" });
    expect(
      (
        await accept(
          runner().resolve({ headers: runnerHeaders, params, body }),
          [200],
        )
      ).body,
    ).toMatchObject({
      outcome: "resolved_tailscale",
      generation: h.generation + 2,
      learnedHostKey: key,
      tailscale: { configId: c.id, generation: 2, tags: ["tag:next"] },
    });
    await accept(
      remote().setThreadOverride({
        headers,
        params: { threadId: r.threadId, protocol: "ssh", connectionId: h.id },
        body: { enabled: false },
      }),
      [200],
    );
    probe = useSecretKmsProbe();
    expect(
      (
        await accept(
          runner().resolve({ headers: runnerHeaders, params, body }),
          [200],
        )
      ).body.outcome,
    ).toBe("unavailable");
    expect(probe.decryptCalls).toBe(0);
    await accept(
      remote().clearThreadOverride({
        headers,
        params: { threadId: r.threadId, protocol: "ssh", connectionId: h.id },
      }),
      [200],
    );
    expect(
      (
        await accept(
          runner().resolve({ headers: runnerHeaders, params, body }),
          [200],
        )
      ).body,
    ).toMatchObject({
      outcome: "resolved_tailscale",
      tailscale: {
        configId: c.id,
        generation: rotated.generation,
        tags: ["tag:next"],
      },
    });
    await flushWaitUntilForTest();
  });
  it.each(["create", "rebind"] as const)(
    "fences a first credential binding via %s during rotation and keeps the admitted handoff snapshot",
    async (binding) => {
      const o = owner();
      const c = await config();
      const r = await ordinary.runtime(o);
      const existingHost = binding === "rebind" ? await host(c.id) : null;
      const l = (
        await accept(
          credentials().create({
            headers,
            body: { id: randomUUID(), ...login },
          }),
          [201],
        )
      ).body;
      const rotationEntered = createDeferredPromise<void>(context.signal);
      const releaseRotation = createDeferredPromise<void>(context.signal);
      const handoffEntered = createDeferredPromise<void>(context.signal);
      const releaseHandoff = createDeferredPromise<void>(context.signal);
      useSecretKmsProbe(async (request) => {
        rotationEntered.resolve();
        await releaseRotation.promise;
        return {
          keyId: request.keyId,
          plaintext: Buffer.from("0123456789abcdef0123456789abcdef", "utf8"),
          encryptedDataKey: Buffer.from("test-wrapped-key", "utf8"),
        };
      });
      const rotation = accept(
        credentials().update({
          headers,
          params: { credentialId: l.id },
          body: {
            expectedRevision: l.revision,
            username: "rotated-user",
            authentication: { method: "password", password: "rotated-canary" },
          },
        }),
        [200],
      );
      await joinAll([
        (async () => {
          await rotationEntered.promise;
          const h =
            existingHost === null
              ? (
                  await accept(
                    hosts().create({
                      headers,
                      body: {
                        id: randomUUID(),
                        displayName: "First binding during login rotation",
                        host: "peer",
                        credential: { id: l.id },
                        transport: { type: "tailscale", configId: c.id },
                      },
                    }),
                    [201],
                  )
                ).body
              : (
                  await accept(
                    hosts().update({
                      headers,
                      params: { connectionId: existingHost.id },
                      body: {
                        expectedGeneration: existingHost.generation,
                        credential: { id: l.id },
                      },
                    }),
                    [200],
                  )
                ).body;
          await accept(
            remote().updateHostDefault({
              headers,
              params: { protocol: "ssh", connectionId: h.id },
              body: { enabled: true },
            }),
            [200],
          );
          const params = { runId: r.runId };
          const body = { connectionId: h.id, runnerIdentity: r.runnerIdentity };
          const probe = useSecretKmsProbe();
          const initial = await accept(
            runner().resolve({ headers: runnerHeaders, params, body }),
            [200],
          );
          expect(initial.body).toMatchObject({
            outcome: "resolved_tailscale",
            username: login.username,
            authentication: login.authentication,
          });
          const decryptsBeforeHandoff = probe.decryptCalls;
          expect(decryptsBeforeHandoff).toBeGreaterThan(0);
          useSecretKmsProbe(undefined, async (_request, call) => {
            if (call === decryptsBeforeHandoff) {
              handoffEntered.resolve();
              await releaseHandoff.promise;
            }
            return Buffer.from("0123456789abcdef0123456789abcdef", "utf8");
          });
          const handoff = accept(
            runner().resolve({ headers: runnerHeaders, params, body }),
            [200],
          );
          await joinAll([
            (async () => {
              await handoffEntered.promise;
              releaseRotation.resolve();
              await rotation;
            })().finally(() => {
              if (!releaseRotation.settled()) {
                releaseRotation.resolve();
              }
              if (!releaseHandoff.settled()) {
                releaseHandoff.resolve();
              }
            }),
            handoff,
          ]);
          expect((await handoff).body).toMatchObject({
            outcome: "resolved_tailscale",
            generation: h.generation,
            username: l.username,
            authentication: login.authentication,
          });
          expect((await rotation).body).toMatchObject({
            revision: l.revision + 1,
            username: "rotated-user",
            hosts: [{ id: h.id, displayName: h.displayName }],
          });
          expect((await resources()).hosts).toMatchObject([
            {
              id: h.id,
              generation: h.generation + 1,
              username: "rotated-user",
            },
          ]);
          const currentProbe = useSecretKmsProbe();
          expect(
            (
              await accept(
                runner().pin({
                  headers: runnerHeaders,
                  params,
                  body: {
                    ...body,
                    expectedGeneration: h.generation,
                    observedHostKey: key,
                  },
                }),
                [200],
              )
            ).body,
          ).toStrictEqual({ outcome: "configuration_changed" });
          expect(currentProbe.decryptCalls).toBe(0);
          expect(
            (
              await accept(
                runner().resolve({ headers: runnerHeaders, params, body }),
                [200],
              )
            ).body,
          ).toMatchObject({
            outcome: "resolved_tailscale",
            generation: h.generation + 1,
            username: "rotated-user",
            authentication: { method: "password", password: "rotated-canary" },
          });
        })().finally(() => {
          if (!releaseRotation.settled()) {
            releaseRotation.resolve();
          }
          if (!releaseHandoff.settled()) {
            releaseHandoff.resolve();
          }
        }),
        rotation,
      ]);
    },
  );
  it.each([null, " private-passphrase-canary\n"])(
    "protects private-key JIT with passphrase %j using the admitted snapshot, then denies fresh resolution after revocation",
    async (passphrase) => {
      const o = owner();
      const c = await config();
      const authentication = {
        method: "private_key" as const,
        privateKey: "  private-key-canary\n",
        passphrase,
      };
      const h = (
        await accept(
          hosts().create({
            headers,
            body: {
              id: randomUUID(),
              displayName: "Key-authenticated private host",
              host: "peer",
              port: 2222,
              credential: {
                create: {
                  name: "Independent SSH key",
                  username: "key-user",
                  authentication,
                },
              },
              transport: { type: "tailscale", configId: c.id },
            },
          }),
          [201],
        )
      ).body;
      const metadata = JSON.stringify(await resources());
      for (const value of [
        oauth.clientId,
        oauth.clientSecret,
        authentication.privateKey,
        ...(passphrase === null ? [] : [passphrase]),
      ]) {
        expect(metadata).not.toContain(value.trim());
      }
      const r = await ordinary.runtime(o);
      const params = { runId: r.runId };
      const body = { connectionId: h.id, runnerIdentity: r.runnerIdentity };
      await accept(
        remote().updateHostDefault({
          headers,
          params: { protocol: "ssh", connectionId: h.id },
          body: { enabled: true },
        }),
        [200],
      );
      const probe = useSecretKmsProbe();
      const resolved = await accept(
        runner().resolve({ headers: runnerHeaders, params, body }),
        [200],
      );
      expect(resolved.body).toStrictEqual({
        outcome: "resolved_tailscale",
        host: h.host,
        port: h.port,
        username: "key-user",
        generation: h.generation,
        learnedHostKey: null,
        authentication,
        tailscale: {
          ...oauth,
          configId: c.id,
          generation: c.generation,
          tags: c.tags,
        },
      });
      expect(probe.decryptCalls).toBeGreaterThan(0);
      const decryptsBeforeHandoff = probe.decryptCalls;
      const revoked = useSecretKmsProbe(undefined, async (_request, call) => {
        // Revoke at the final external decrypt, including the optional passphrase.
        if (call === decryptsBeforeHandoff) {
          await accept(
            remote().setThreadOverride({
              headers,
              params: {
                threadId: r.threadId,
                protocol: "ssh",
                connectionId: h.id,
              },
              body: { enabled: false },
            }),
            [200],
          );
        }
        return Buffer.from("0123456789abcdef0123456789abcdef", "utf8");
      });
      const denied = await accept(
        runner().resolve({ headers: runnerHeaders, params, body }),
        [200],
      );
      expect(revoked.decryptCalls).toBe(decryptsBeforeHandoff);
      expect(denied.body).toStrictEqual(resolved.body);
      const unauthorized = useSecretKmsProbe();
      expect(
        (
          await accept(
            runner().resolve({ headers: runnerHeaders, params, body }),
            [200],
          )
        ).body,
      ).toStrictEqual({ outcome: "unavailable" });
      expect(unauthorized.decryptCalls).toBe(0);
    },
  );
  it("completes the admitted network snapshot during rotation without holding DB locks across decryption", async () => {
    const o = owner();
    const c = await config();
    const h = await host(c.id);
    const r = await ordinary.runtime(o);
    await accept(
      remote().updateHostDefault({
        headers,
        params: { protocol: "ssh", connectionId: h.id },
        body: { enabled: true },
      }),
      [200],
    );
    const probe = useSecretKmsProbe(undefined, async (_request, call) => {
      if (call === 1) {
        await accept(
          configs().update({
            headers,
            params: { configId: c.id },
            body: { expectedRevision: 1, tags: ["tag:rotated"] },
          }),
          [200],
        );
      }
      return Buffer.from("0123456789abcdef0123456789abcdef", "utf8");
    });
    const result = await accept(
      runner().resolve({
        headers: runnerHeaders,
        params: { runId: r.runId },
        body: { connectionId: h.id, runnerIdentity: r.runnerIdentity },
      }),
      [200],
    );
    expect(probe.decryptCalls).toBeGreaterThan(0);
    expect(result.body).toMatchObject({
      outcome: "resolved_tailscale",
      generation: h.generation,
      tailscale: {
        ...oauth,
        configId: c.id,
        generation: c.generation,
        tags: c.tags,
      },
    });
    useSecretKmsProbe();
    const fresh = await accept(
      runner().resolve({
        headers: runnerHeaders,
        params: { runId: r.runId },
        body: { connectionId: h.id, runnerIdentity: r.runnerIdentity },
      }),
      [200],
    );
    expect(fresh.body).toMatchObject({
      outcome: "resolved_tailscale",
      generation: h.generation + 1,
      tailscale: { generation: c.generation + 1, tags: ["tag:rotated"] },
    });
  });
  it("serializes shared config CAS and host CAS without orphan inline resources", async () => {
    owner();
    const c = await config();
    const h = await host(c.id);
    const configsRace = await Promise.all(
      ["tag:first", "tag:second"].map((tag) => {
        return accept(
          configs().update({
            headers,
            params: { configId: c.id },
            body: { expectedRevision: 1, tags: [tag] },
          }),
          [200, 409],
        );
      }),
    );
    expect(
      configsRace
        .map((result) => {
          return result.status;
        })
        .sort(),
    ).toStrictEqual([200, 409]);
    const before = await resources();
    const [current] = before.hosts;
    if (!current) {
      throw new Error("Owned host is missing after configuration rotation");
    }
    expect(current.generation).toBe(h.generation + 1);
    const hostRace = await Promise.all(
      ["first", "second"].map((name) => {
        return accept(
          hosts().update({
            headers,
            params: { connectionId: h.id },
            body: {
              expectedGeneration: current.generation,
              credential: { create: { ...login, name } },
              transport: {
                type: "tailscale",
                create: {
                  name,
                  credentials: oauth,
                  tags: ["tag:okou"],
                },
              },
            },
          }),
          [200, 409],
        );
      }),
    );
    expect(
      hostRace
        .map((result) => {
          return result.status;
        })
        .sort(),
    ).toStrictEqual([200, 409]);
    const after = await resources();
    expect(after.configs).toHaveLength(before.configs.length + 1);
    expect(after.logins).toHaveLength(before.logins.length + 1);
    expect(after.hosts).toHaveLength(1);
  });
  it("bind/delete races preserve restrictive FK ownership and creation atomicity", async () => {
    owner();
    const c = await config();
    const [binding, deletion] = await Promise.all([
      accept(
        hosts().create({
          headers,
          body: {
            id: randomUUID(),
            displayName: "Racing host",
            host: "peer",
            credential: { create: login },
            transport: { type: "tailscale", configId: c.id },
          },
        }),
        [201, 404],
      ),
      accept(
        configs().delete({
          headers,
          params: { configId: c.id },
          body: { expectedRevision: 1 },
        }),
        [204, 409],
      ),
    ]);
    const saved = await resources();
    if (binding.status === 201) {
      expect(deletion.status).toBe(409);
      expect(saved.configs).toHaveLength(1);
      expect(saved.hosts).toHaveLength(1);
      expect(saved.logins).toHaveLength(1);
    } else {
      expect(deletion.status).toBe(204);
      expect(saved).toStrictEqual({ configs: [], hosts: [], logins: [] });
    }
  });
  it("requires reviewed scope conversion and rejects invalid tags/credentials through real request validation", async () => {
    owner();
    const c = await config();
    const request = setupRawAppRequest({ context, routes: tailscaleRoutes });
    for (const fields of [
      { scope: "organization" },
      { tags: [] },
      { tags: ["tag:okou", "tag:okou"] },
      { credentials: { clientId: "id", clientSecret: "\nunsafe" } },
    ]) {
      const response = await request(`/api/tailscale/configs/${c.id}`, {
        method: "PATCH",
        headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify({ expectedRevision: 1, ...fields }),
      });
      expect(response.status).toBe(400);
    }
    expect((await resources()).configs[0]).toMatchObject({
      revision: 1,
      generation: 1,
    });
  });
});
