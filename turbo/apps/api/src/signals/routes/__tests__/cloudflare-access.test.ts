import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { cloudflareAccessContract } from "@okouai/api-contracts/contracts/cloudflare-access";
import {
  sshConnectionsContract,
  sshConnectionResponseSchema,
} from "@okouai/api-contracts/contracts/ssh-connections";
import { runnerSshContract } from "@okouai/api-contracts/contracts/runner-ssh";
import {
  agentsMainContract,
  agentsByIdContract,
} from "@okouai/api-contracts/contracts/agents";
import {
  agentSshAccessContract,
  sshHostsContract,
} from "@okouai/api-contracts/contracts/ssh-access";
import {
  testSshConnectionStateContract,
  type TestSshConnectionStateActionBody,
} from "@okouai/api-contracts/contracts/test-ssh-connection-state";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp, setupRawAppRequest } from "../../../__tests__/test-helpers";
import { mockEnv } from "../../../lib/env";
import { now, nowDate } from "../../../lib/time";
import { signSandboxJwtForTests } from "../../auth/tokens";
import { cloudflareAccessRoutes } from "../cloudflare-access";
import { agentsRoutes } from "../agents";
import { runnerSshRoutes } from "../runner-ssh";
import { sshConnectionsRoutes } from "../ssh-connections";
import { sshAccessRoutes } from "../ssh-access";
import { testSshConnectionStateRoutes } from "../test-ssh-connection-state";
import { createRouteMocks } from "./helpers/route-test";
import { updateFeatureSwitchesForUser } from "./helpers/feature-switches";
import { useSecretKmsProbe } from "./helpers/secret-kms-probe";

const context = testContext();
const mocks = createRouteMocks(context);
const headers = Object.freeze({ authorization: "Bearer clerk-session" });
const runnerSecret = "b".repeat(64);
const runnerHeaders = Object.freeze({
  authorization: `Bearer vm0_official_${runnerSecret}`,
});
const token = Object.freeze({
  clientId: "client-id-canary.access",
  clientSecret: "client-secret-canary",
});
const hostKey = Object.freeze({
  algorithm: "ssh-ed25519" as const,
  fingerprint: `SHA256:${Buffer.alloc(32, 1).toString("base64").replace(/=+$/u, "")}`,
});
type Owner = { orgId: string; userId: string };
type RuntimeBody = Extract<
  TestSshConnectionStateActionBody,
  { action: "create-runtime" }
>;
const configs = () => {
  return setupApp({ context, routes: cloudflareAccessRoutes })(
    cloudflareAccessContract,
  );
};
const sshGrants = () => {
  return setupApp({ context, routes: sshAccessRoutes })(agentSshAccessContract);
};
const connections = () => {
  return setupApp({ context, routes: sshConnectionsRoutes })(
    sshConnectionsContract,
  );
};
const runner = () => {
  return setupApp({ context, routes: runnerSshRoutes })(runnerSshContract);
};
const state = () => {
  return setupApp({ context, routes: testSshConnectionStateRoutes })(
    testSshConnectionStateContract,
  );
};
function authenticate(owner: Owner) {
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
async function owner(overrides: Partial<Owner> = {}) {
  const result = {
    orgId: `org_access_${randomUUID()}`,
    userId: `user_access_${randomUUID()}`,
    ...overrides,
  };
  await updateFeatureSwitchesForUser(context, result, {
    [FeatureSwitchKey.SshAccess]: true,
    [FeatureSwitchKey.CloudflareAccess]: true,
  });
  authenticate(result);
  return result;
}
async function runtime(owner: Owner, overrides: Partial<RuntimeBody> = {}) {
  // The owned infrastructure fixture supplies Run assignment/heartbeat states
  // unavailable through owner APIs; configuration and authority use real routes.
  const runnerIdentity = {
    runnerId: randomUUID(),
    heartbeatGeneration: 5_000_000_000,
  };
  const result = await accept(
    state().action({
      body: {
        action: "create-runtime",
        orgId: owner.orgId,
        userId: owner.userId,
        ...runnerIdentity,
        triggerSource: "web",
        status: "running",
        chat: false,
        access: false,
        ...overrides,
      },
    }),
    [200],
  );
  const { runId, agentId } = result.body;
  if (!runId || !agentId) {
    throw new Error("Missing runtime fixture");
  }
  const seconds = Math.floor(now() / 1000);
  const guestHeaders = {
    authorization: `Bearer ${signSandboxJwtForTests({ scope: "okou", orgId: owner.orgId, userId: owner.userId, runId, capabilities: ["ssh:read"], iat: seconds, exp: seconds + 3600 })}`,
  };
  return { runId, agentId, runnerIdentity, guestHeaders };
}
async function config(name = "Service token") {
  return (
    await accept(
      configs().create({ headers, body: { name, credentials: token } }),
      [201],
    )
  ).body;
}
async function host(configId?: string) {
  return (
    await accept(
      connections().create({
        headers,
        body: {
          displayName: configId ? "Protected host" : "Direct host",
          host: "ssh.example.com",
          port: configId ? 443 : 22,
          credential: {
            create: {
              name: "Login",
              username: "deploy",
              authentication: {
                method: "password",
                password: "ssh-password-canary",
              },
            },
          },
          ...(configId
            ? { transport: { type: "cloudflare_access" as const, configId } }
            : {}),
        },
      }),
      [201],
    )
  ).body;
}
async function fixture() {
  const o = await owner();
  const r = await runtime(o, { runnerGroup: `access-${randomUUID()}` });
  const c = await config();
  const h = await host(c.id);
  return {
    ...o,
    ...r,
    config: c,
    host: h,
    body: { connectionId: h.id, runnerIdentity: r.runnerIdentity },
    params: { runId: r.runId },
  };
}
async function resolve(f: Awaited<ReturnType<typeof fixture>>) {
  return (
    await accept(
      runner().resolve({
        headers: runnerHeaders,
        params: f.params,
        body: f.body,
      }),
      [200],
    )
  ).body;
}
beforeEach(() => {
  mockEnv("OFFICIAL_RUNNER_SECRET", runnerSecret);
  useSecretKmsProbe();
});

describe("Cloudflare Access owner configuration", () => {
  it("refreshes SSH metadata for unreferenced config changes without runtime invalidation", async () => {
    const o = await owner();
    await runtime(o, { runnerGroup: "config-only" });
    const assertNotice = () => {
      expect(context.mocks.ably.publish.mock.calls).toStrictEqual([
        ["ssh:changed", { orgId: o.orgId }],
      ]);
      expect(context.mocks.ably.channelGet.mock.calls).toStrictEqual([
        [`user:${o.userId}`],
      ]);
    };
    context.mocks.ably.publish.mockClear();
    context.mocks.ably.channelGet.mockClear();
    const c = await config();
    assertNotice();
    context.mocks.ably.publish.mockClear();
    context.mocks.ably.channelGet.mockClear();
    await accept(
      configs().update({
        headers,
        params: { configId: c.id },
        body: { expectedRevision: 1, name: "Renamed" },
      }),
      [200],
    );
    assertNotice();
    context.mocks.ably.publish.mockClear();
    context.mocks.ably.channelGet.mockClear();
    await accept(
      configs().delete({
        headers,
        params: { configId: c.id },
        body: { expectedRevision: 2 },
      }),
      [204],
    );
    assertNotice();
  });

  it("is default-off and session-only, and rejects unsafe token headers before encryption", async () => {
    await accept(configs().list({ headers: {} }), [401]);
    mocks.clerk.session(`user_off_${randomUUID()}`, `org_off_${randomUUID()}`);
    await accept(
      configs().create({ headers, body: { name: "Off", credentials: token } }),
      [404],
    );
    await owner();
    const request = setupRawAppRequest({
      context,
      routes: cloudflareAccessRoutes,
    });
    for (const value of [
      "",
      "a\r\nHost: evil.example",
      " contains-space",
      "é",
      "x".repeat(4097),
    ]) {
      const result = await request("/api/ssh/cloudflare-access/configs", {
        method: "POST",
        headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify({
          name: "Unsafe",
          credentials: { ...token, clientSecret: value },
        }),
      });
      expect(result.status).toBe(400);
    }
    expect(
      (await accept(configs().list({ headers }), [200])).body.configs,
    ).toStrictEqual([]);
  });

  it("shares one configuration across hosts without public secret readback and rejects stale/dependent deletion", async () => {
    const f = await fixture();
    const second = await host(f.config.id);
    const listed = (await accept(configs().list({ headers }), [200])).body;
    expect(listed.configs[0]?.hosts).toStrictEqual(
      expect.arrayContaining([
        { id: f.host.id, displayName: f.host.displayName },
        { id: second.id, displayName: second.displayName },
      ]),
    );
    for (const body of [listed, f.host, f.config]) {
      const text = JSON.stringify(body);
      for (const secret of [
        token.clientId,
        token.clientSecret,
        "ssh-password-canary",
        "encrypted",
        "vm0secret:",
      ]) {
        expect(text).not.toContain(secret);
      }
    }
    const params = { configId: f.config.id };
    expect(
      (
        await accept(
          configs().delete({ headers, params, body: { expectedRevision: 1 } }),
          [409],
        )
      ).body.error.code,
    ).toBe("CLOUDFLARE_ACCESS_IN_USE");
    const renamed = await accept(
      configs().update({
        headers,
        params,
        body: { expectedRevision: 1, name: "Renamed" },
      }),
      [200],
    );
    expect(renamed.body).toMatchObject({
      name: "Renamed",
      revision: 2,
      generation: 1,
    });
    await accept(
      configs().update({
        headers,
        params,
        body: { expectedRevision: 1, name: "Stale rename" },
      }),
      [409],
    );
    for (const connection of [f.host, second]) {
      await accept(
        connections().delete({
          headers,
          params: { connectionId: connection.id },
        }),
        [204],
      );
    }
    await accept(
      configs().delete({ headers, params, body: { expectedRevision: 1 } }),
      [409],
    );
    await accept(
      configs().delete({ headers, params, body: { expectedRevision: 2 } }),
      [204],
    );
    expect(
      (await accept(configs().list({ headers }), [200])).body.configs,
    ).toStrictEqual([]);
  });

  it.each(["user", "org"] as const)(
    "isolates foreign %s configuration IDs and metadata",
    async (dimension) => {
      const first = await owner();
      const c = await config();
      await owner(
        dimension === "user"
          ? { orgId: first.orgId }
          : { userId: first.userId },
      );
      expect(
        (await accept(configs().list({ headers }), [200])).body.configs,
      ).toStrictEqual([]);
      await accept(
        configs().update({
          headers,
          params: { configId: c.id },
          body: { expectedRevision: 1, name: "Foreign" },
        }),
        [404],
      );
      await accept(
        configs().delete({
          headers,
          params: { configId: c.id },
          body: { expectedRevision: 1 },
        }),
        [404],
      );
      const result = await connections().create({
        headers,
        body: {
          displayName: "Foreign binding",
          host: "ssh.example.com",
          port: 443,
          credential: {
            create: {
              name: "Login",
              username: "user",
              authentication: { method: "password", password: "secret" },
            },
          },
          transport: { type: "cloudflare_access", configId: c.id },
        },
      });
      await accept(Promise.resolve(result), [404]);
    },
  );

  it("does not configure SSH or grant it when only Access configs are created", async () => {
    const o = await owner();
    const r = await runtime(o);
    await config();
    const params = { agentId: r.agentId };
    expect(
      (await accept(sshGrants().get({ headers, params }), [200])).body,
    ).toStrictEqual({ enabled: false });
    const later = await runtime(o);
    await config("Second");
    for (const agentId of [r.agentId, later.agentId]) {
      expect(
        (await accept(sshGrants().get({ headers, params: { agentId } }), [200]))
          .body,
      ).toStrictEqual({ enabled: false });
    }
    expect(
      (await accept(connections().list({ headers }), [200])).body.connections,
    ).toStrictEqual([]);
  });

  it("preserves SSH first-host onboarding and manual denials through Access config changes", async () => {
    const f = await fixture();
    const params = { agentId: f.agentId };
    expect(
      (await accept(sshGrants().get({ headers, params }), [200])).body,
    ).toStrictEqual({ enabled: true });
    await accept(
      sshGrants().update({ headers, params, body: { enabled: false } }),
      [200],
    );
    const second = await config("Second");
    await host(second.id);
    let revision = f.config.revision;
    for (const body of [
      { name: "Renamed" },
      { credentials: { ...token, clientSecret: "rotated-canary" } },
    ]) {
      const updated = await accept(
        configs().update({
          headers,
          params: { configId: f.config.id },
          body: { expectedRevision: revision, ...body },
        }),
        [200],
      );
      revision = updated.body.revision;
      expect(
        (await accept(sshGrants().get({ headers, params }), [200])).body,
      ).toStrictEqual({ enabled: false });
      await expect(resolve(f)).resolves.toStrictEqual({
        outcome: "unavailable",
      });
    }
  });
});

describe("protected SSH authority", () => {
  it("uses existing protected hosts after a later Agent receives SSH permission", async () => {
    const f = await fixture();
    const later = await runtime(f);
    const params = { agentId: later.agentId };
    expect(
      (await accept(sshGrants().get({ headers, params }), [200])).body,
    ).toStrictEqual({ enabled: false });
    await accept(
      sshGrants().update({ headers, params, body: { enabled: true } }),
      [200],
    );
    expect(
      (
        await accept(
          runner().resolve({
            headers: runnerHeaders,
            params: { runId: later.runId },
            body: {
              connectionId: f.host.id,
              runnerIdentity: later.runnerIdentity,
            },
          }),
          [200],
        )
      ).body,
    ).toMatchObject({
      outcome: "resolved_access",
      access: { configId: f.config.id },
    });
    expect(
      (
        await accept(
          setupApp({ context, routes: sshAccessRoutes })(sshHostsContract).list(
            { headers: later.guestHeaders },
          ),
          [200],
        )
      ).body.hosts.map((h) => {
        return h.id;
      }),
    ).toStrictEqual([f.host.id]);
  });

  it("uses only the Run owner's protected hosts for a shared Agent and rejects lost visibility", async () => {
    const creator = await owner();
    const shared = await accept(
      setupApp({ context, routes: agentsRoutes })(agentsMainContract).create({
        headers,
        body: { displayName: "Shared SSH Agent", visibility: "public" },
      }),
      [201],
    );
    const creatorConfig = await config();
    const creatorHost = await host(creatorConfig.id);
    const user = await owner({ orgId: creator.orgId });
    const r = await runtime(user, { agentId: shared.body.agentId });
    const ownConfig = await config();
    const ownHost = await host(ownConfig.id);
    const request = {
      headers: runnerHeaders,
      params: { runId: r.runId },
      body: { connectionId: ownHost.id, runnerIdentity: r.runnerIdentity },
    };
    expect((await accept(runner().resolve(request), [200])).body).toMatchObject(
      {
        outcome: "resolved_access",
        access: { configId: ownConfig.id },
      },
    );
    expect(
      (
        await accept(
          runner().resolve({
            ...request,
            body: { ...request.body, connectionId: creatorHost.id },
          }),
          [200],
        )
      ).body,
    ).toStrictEqual({ outcome: "unavailable" });
    const inventory = setupApp({ context, routes: sshAccessRoutes })(
      sshHostsContract,
    );
    expect(
      (
        await accept(inventory.list({ headers: r.guestHeaders }), [200])
      ).body.hosts.map((h) => {
        return h.id;
      }),
    ).toStrictEqual([ownHost.id]);
    authenticate(creator);
    await accept(
      setupApp({ context, routes: agentsRoutes })(agentsByIdContract).update({
        headers,
        params: { id: shared.body.agentId },
        body: { visibility: "private" },
      }),
      [200],
    );
    authenticate(user);
    expect((await accept(runner().resolve(request), [200])).body).toStrictEqual(
      { outcome: "unavailable" },
    );
    await accept(inventory.list({ headers: r.guestHeaders }), [404]);
    expect(
      (
        await accept(
          runner().pin({
            ...request,
            body: {
              ...request.body,
              expectedGeneration: 1,
              observedHostKey: hostKey,
            },
          }),
          [200],
        )
      ).body,
    ).toStrictEqual({ outcome: "unavailable" });
  });

  it("preserves key authentication separately from the Access token", async () => {
    const f = await fixture();
    await accept(
      connections().update({
        headers,
        params: { connectionId: f.host.id },
        body: {
          expectedGeneration: 1,
          credential: {
            create: {
              name: "Key",
              username: "deploy",
              authentication: {
                method: "private_key",
                privateKey: "private-key-canary",
                passphrase: " passphrase-canary\n",
              },
            },
          },
        },
      }),
      [200],
    );
    await expect(resolve(f)).resolves.toMatchObject({
      outcome: "resolved_access",
      authentication: {
        method: "private_key",
        privateKey: "private-key-canary",
        passphrase: " passphrase-canary\n",
      },
      access: token,
    });
  });

  it("keeps KMS failure an error instead of returning unavailable or Direct authority", async () => {
    const f = await fixture();
    useSecretKmsProbe(undefined, () => {
      return Promise.reject(new Error("KMS unavailable"));
    });
    const result = await accept(
      runner().resolve({
        headers: runnerHeaders,
        params: f.params,
        body: f.body,
      }),
      [500],
    );
    for (const secret of [
      token.clientId,
      token.clientSecret,
      "ssh-password-canary",
    ]) {
      expect(JSON.stringify(result.body)).not.toContain(secret);
    }
  });

  it("invalidates only protected host IDs and preserves recipients after grant revocation", async () => {
    const f = await fixture();
    const second = await host(f.config.id);
    const direct = await host();
    const otherAgent = await runtime(f, { runnerGroup: "other-agent" });
    const otherOwner = await owner({ orgId: f.orgId });
    await runtime(otherOwner, { runnerGroup: "other-owner" });
    authenticate(f);
    const notices = () => {
      return context.mocks.ably.publish.mock.calls.filter(([event]) => {
        return event === "ssh-authority-invalidated";
      });
    };
    context.mocks.ably.publish.mockClear();
    await accept(
      configs().update({
        headers,
        params: { configId: f.config.id },
        body: { expectedRevision: 1, name: "Renamed" },
      }),
      [200],
    );
    expect(notices()).toStrictEqual([]);
    expect(context.mocks.ably.publish.mock.calls).toContainEqual([
      "ssh:changed",
      { orgId: f.orgId },
    ]);
    context.mocks.ably.publish.mockClear();
    await accept(
      configs().update({
        headers,
        params: { configId: f.config.id },
        body: {
          expectedRevision: 2,
          credentials: { ...token, clientSecret: "rotated-canary" },
        },
      }),
      [200],
    );
    expect(notices()).toHaveLength(4);
    expect(
      context.mocks.ably.publish.mock.calls.filter(([event]) => {
        return event === "ssh:changed";
      }),
    ).toStrictEqual([["ssh:changed", { orgId: f.orgId }]]);
    expect(notices()).toStrictEqual(
      expect.arrayContaining(
        [f.runId, otherAgent.runId].flatMap((runId) => {
          return [f.host.id, second.id].map((connectionId) => {
            return ["ssh-authority-invalidated", { runId, connectionId }];
          });
        }),
      ),
    );
    context.mocks.ably.publish.mockClear();
    await accept(
      sshGrants().update({
        headers,
        params: { agentId: f.agentId },
        body: { enabled: false },
      }),
      [200],
    );
    expect(notices()).toStrictEqual([
      ["ssh-authority-invalidated", { runId: f.runId, connectionId: null }],
    ]);
    await expect(resolve(f)).resolves.toStrictEqual({ outcome: "unavailable" });
    expect(
      (
        await accept(
          runner().resolve({
            headers: runnerHeaders,
            params: f.params,
            body: { ...f.body, connectionId: direct.id },
          }),
          [200],
        )
      ).body,
    ).toStrictEqual({ outcome: "unavailable" });
  });

  it("commits token replacement even when realtime publication fails", async () => {
    const f = await fixture();
    context.mocks.ably.publish.mockRejectedValue(
      new Error("Realtime unavailable"),
    );
    const result = await accept(
      configs().update({
        headers,
        params: { configId: f.config.id },
        body: {
          expectedRevision: 1,
          credentials: { ...token, clientSecret: "rotated-canary" },
        },
      }),
      [200],
    );
    expect(result.body).toMatchObject({
      revision: 2,
      generation: 2,
    });
    await expect(resolve(f)).resolves.toMatchObject({
      outcome: "resolved_access",
      generation: 2,
      access: { generation: 2, clientSecret: "rotated-canary" },
    });
  });

  it("serializes concurrent token replacements and deletion against host binding", async () => {
    const f = await fixture();
    const revisions = await Promise.all(
      ["one", "two"].map((clientSecret) => {
        return accept(
          configs().update({
            headers,
            params: { configId: f.config.id },
            body: {
              expectedRevision: 1,
              credentials: { ...token, clientSecret },
            },
          }),
          [200, 409],
        );
      }),
    );
    expect(
      revisions
        .map((result) => {
          return result.status;
        })
        .sort(),
    ).toStrictEqual([200, 409]);
    await expect(resolve(f)).resolves.toMatchObject({
      outcome: "resolved_access",
      generation: 2,
      access: { generation: 2 },
    });
    const target = await config("New binding");
    const [rebound, deleted] = await Promise.all([
      accept(
        connections().update({
          headers,
          params: { connectionId: f.host.id },
          body: {
            expectedGeneration: 2,
            transport: { type: "cloudflare_access", configId: target.id },
          },
        }),
        [200, 404],
      ),
      accept(
        configs().delete({
          headers,
          params: { configId: target.id },
          body: { expectedRevision: 1 },
        }),
        [204, 409],
      ),
    ]);
    expect([rebound.status, deleted.status]).toSatisfy((statuses: number[]) => {
      return (
        (statuses[0] === 200 && statuses[1] === 409) ||
        (statuses[0] === 404 && statuses[1] === 204)
      );
    });
    await expect(resolve(f)).resolves.toMatchObject({
      outcome: "resolved_access",
    });
  });

  it("rejects foreign Run owners before decrypting protected credentials", async () => {
    const f = await fixture();
    const foreign = await owner({ orgId: f.orgId });
    const r = await runtime(foreign, { agentId: f.agentId, access: true });
    const kms = useSecretKmsProbe();
    const result = await accept(
      runner().resolve({
        headers: runnerHeaders,
        params: { runId: r.runId },
        body: { connectionId: f.host.id, runnerIdentity: r.runnerIdentity },
      }),
      [200],
    );
    expect(result.body).toStrictEqual({ outcome: "unavailable" });
    expect(kms.decryptCalls).toBe(0);
  });

  it("hands off two independent credentials only to the winning Runner", async () => {
    const f = await fixture();
    await expect(resolve(f)).resolves.toMatchObject({
      outcome: "resolved_access",
      port: 443,
      generation: 1,
      authentication: { method: "password", password: "ssh-password-canary" },
      access: { ...token, configId: f.config.id, generation: 1 },
    });
    for (const runnerIdentity of [
      { ...f.runnerIdentity, runnerId: randomUUID() },
      {
        ...f.runnerIdentity,
        heartbeatGeneration: f.runnerIdentity.heartbeatGeneration - 1,
      },
    ]) {
      expect(
        (
          await accept(
            runner().resolve({
              headers: runnerHeaders,
              params: f.params,
              body: { ...f.body, runnerIdentity },
            }),
            [200],
          )
        ).body,
      ).toStrictEqual({ outcome: "unavailable" });
    }
    await accept(
      runner().resolve({ headers, params: f.params, body: f.body }),
      [401],
    );
    await accept(
      runner().resolve({
        headers: f.guestHeaders,
        params: f.params,
        body: f.body,
      }),
      [401],
    );
    const inventory = await accept(
      setupApp({ context, routes: sshAccessRoutes })(sshHostsContract).list({
        headers: f.guestHeaders,
      }),
      [200],
    );
    expect(inventory.body.hosts).toStrictEqual([
      {
        id: f.host.id,
        displayName: f.host.displayName,
        host: f.host.host,
        port: 443,
        username: "deploy",
        learnedHostKey: null,
      },
    ]);
  });

  it("preserves an omitted transport binding and rejects a stale editor without affecting Direct hosts", async () => {
    const f = await fixture();
    const direct = await host();
    expect(sshConnectionResponseSchema.parse(direct)).toStrictEqual(direct);
    const params = { connectionId: f.host.id };
    const renamed = await accept(
      connections().update({
        headers,
        params,
        body: { expectedGeneration: 1, displayName: "Renamed host" },
      }),
      [200],
    );
    expect(renamed.body).toMatchObject({
      generation: 2,
      transport: { type: "cloudflare_access", configId: f.config.id },
    });
    await accept(
      connections().update({
        headers,
        params,
        body: {
          expectedGeneration: 1,
          transport: { type: "direct" },
          port: 22,
        },
      }),
      [409],
    );
    await expect(resolve(f)).resolves.toMatchObject({
      outcome: "resolved_access",
      generation: 2,
    });
    const resolved = (
      await accept(
        runner().resolve({
          headers: runnerHeaders,
          params: f.params,
          body: { ...f.body, connectionId: direct.id },
        }),
        [200],
      )
    ).body;
    expect(resolved).toMatchObject({ outcome: "resolved_password", port: 22 });
  });

  it.each([false, true])(
    "uses the SSH grant alone when enabled=%s",
    async (enabled) => {
      const f = await fixture();
      const params = { agentId: f.agentId };
      await accept(
        sshGrants().update({ headers, params, body: { enabled } }),
        [200],
      );
      expect((await resolve(f)).outcome).toBe(
        enabled ? "resolved_access" : "unavailable",
      );
      const inventory = setupApp({ context, routes: sshAccessRoutes })(
        sshHostsContract,
      );
      const listed = await accept(
        inventory.list({ headers: f.guestHeaders }),
        enabled ? [200] : [404],
      );
      if (listed.status === 200) {
        expect(listed.body.hosts).toHaveLength(1);
      }
      expect(
        (
          await accept(
            runner().observe({
              headers: runnerHeaders,
              params: f.params,
              body: {
                ...f.body,
                expectedGeneration: 1,
                observedAt: nowDate().toISOString(),
                failureReason: "access_rejected",
              },
            }),
            [200],
          )
        ).body.outcome,
      ).toBe(enabled ? "recorded" : "unavailable");
      expect(
        (
          await accept(
            runner().pin({
              headers: runnerHeaders,
              params: f.params,
              body: {
                ...f.body,
                expectedGeneration: 1,
                observedHostKey: hostKey,
              },
            }),
            [200],
          )
        ).body.outcome,
      ).toBe(enabled ? "pinned" : "unavailable");
    },
  );

  it("keeps Direct management and execution available when the Access feature is disabled", async () => {
    const f = await fixture();
    const direct = await host();
    const inventory = setupApp({ context, routes: sshAccessRoutes })(
      sshHostsContract,
    );
    await expect(resolve(f)).resolves.toMatchObject({
      outcome: "resolved_access",
    });
    await updateFeatureSwitchesForUser(context, f, {
      [FeatureSwitchKey.SshAccess]: true,
      [FeatureSwitchKey.CloudflareAccess]: false,
    });
    authenticate(f);
    await expect(resolve(f)).resolves.toStrictEqual({ outcome: "unavailable" });
    expect(
      (
        await accept(inventory.list({ headers: f.guestHeaders }), [200])
      ).body.hosts.map((h) => {
        return h.id;
      }),
    ).toStrictEqual([direct.id]);
    await accept(configs().list({ headers }), [404]);
    await accept(
      connections().update({
        headers,
        params: { connectionId: direct.id },
        body: {
          expectedGeneration: direct.generation,
          displayName: "Still direct",
        },
      }),
      [200],
    );
    expect(
      (
        await accept(
          runner().resolve({
            headers: runnerHeaders,
            params: f.params,
            body: { ...f.body, connectionId: direct.id },
          }),
          [200],
        )
      ).body.outcome,
    ).toBe("resolved_password");
    await accept(connections().list({ headers }), [200]);
    await accept(
      connections().delete({ headers, params: { connectionId: f.host.id } }),
      [404],
    );
  });

  it("preserves host trust across rotation, protected edits and Access transitions; rejects stale evidence", async () => {
    const f = await fixture();
    const second = await host(f.config.id);
    const direct = await host();
    await accept(
      runner().pin({
        headers: runnerHeaders,
        params: f.params,
        body: { ...f.body, expectedGeneration: 1, observedHostKey: hostKey },
      }),
      [200],
    );
    const rotated = await accept(
      configs().update({
        headers,
        params: { configId: f.config.id },
        body: {
          expectedRevision: 1,
          credentials: { ...token, clientSecret: "rotated-canary" },
        },
      }),
      [200],
    );
    expect(rotated.body).toMatchObject({ revision: 2, generation: 2 });
    const listed = (await accept(connections().list({ headers }), [200])).body
      .connections;
    expect(
      listed.find((h) => {
        return h.id === f.host.id;
      }),
    ).toMatchObject({ generation: 3, learnedHostKey: hostKey });
    expect(
      listed.find((h) => {
        return h.id === second.id;
      }),
    ).toMatchObject({ generation: 2 });
    expect(
      listed.find((h) => {
        return h.id === direct.id;
      }),
    ).toMatchObject({ generation: 1 });
    expect(
      (
        await accept(
          runner().observe({
            headers: runnerHeaders,
            params: f.params,
            body: {
              ...f.body,
              expectedGeneration: 2,
              observedAt: nowDate().toISOString(),
              failureReason: "access_rejected",
            },
          }),
          [200],
        )
      ).body.outcome,
    ).toBe("ignored");
    const replacement = await config("Replacement");
    let generation = 3;
    for (const body of [
      { host: "changed.example.com" },
      {
        transport: {
          type: "cloudflare_access" as const,
          configId: replacement.id,
        },
      },
      { transport: { type: "direct" as const }, port: 22 },
      {
        transport: {
          type: "cloudflare_access" as const,
          configId: replacement.id,
        },
        port: 443,
      },
    ]) {
      const edited = await accept(
        connections().update({
          headers,
          params: { connectionId: f.host.id },
          body: { expectedGeneration: generation, ...body },
        }),
        [200],
      );
      expect(edited.body.learnedHostKey).toStrictEqual(hostKey);
      generation = edited.body.generation;
    }
    await accept(
      connections().resetHostKey({
        headers,
        params: { connectionId: f.host.id },
        body: { expectedGeneration: generation },
      }),
      [200],
    );
    await expect(resolve(f)).resolves.toMatchObject({
      outcome: "resolved_access",
      learnedHostKey: null,
    });
  });

  it("preserves precise Access-stage evidence instead of misclassifying SSH authentication", async () => {
    const f = await fixture();
    const body = {
      ...f.body,
      expectedGeneration: 1,
      observedAt: nowDate().toISOString(),
      failureReason: "access_rejected" as const,
    };
    expect(
      (
        await accept(
          runner().observe({ headers: runnerHeaders, params: f.params, body }),
          [200],
        )
      ).body.outcome,
    ).toBe("recorded");
    expect(
      (await accept(connections().observations({ headers }), [200])).body
        .observations[0]?.failureReason,
    ).toBe("access_rejected");
  });

  it("rejects unsafe protected destinations without silently creating Direct hosts", async () => {
    await owner();
    const c = await config();
    const request = setupRawAppRequest({
      context,
      routes: sshConnectionsRoutes,
    });
    for (const destination of [
      "1.2.3.4",
      "::1",
      "localhost",
      "*.example.com",
      "https://ssh.example.com/path",
    ]) {
      const result = await request("/api/ssh/connections", {
        method: "POST",
        headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify({
          displayName: "Bad",
          host: destination,
          port: 443,
          credential: {
            create: {
              name: "Login",
              username: "user",
              authentication: { method: "password", password: "secret" },
            },
          },
          transport: { type: "cloudflare_access", configId: c.id },
        }),
      });
      expect(result.status).toBe(400);
    }
    expect(
      (await accept(connections().list({ headers }), [200])).body.connections,
    ).toStrictEqual([]);
  });
});
