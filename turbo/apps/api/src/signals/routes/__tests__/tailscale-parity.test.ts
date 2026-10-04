import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, expect, test } from "vitest";
import { tailscaleContract } from "@okouai/api-contracts/contracts/tailscale";
import { cloudflareAccessContract } from "@okouai/api-contracts/contracts/cloudflare-access";
import {
  sshConnectionsContract,
  type SshConnectionResponse,
} from "@okouai/api-contracts/contracts/ssh-connections";
import { runnerSshContract } from "@okouai/api-contracts/contracts/runner-ssh";
import { sshCredentialsContract } from "@okouai/api-contracts/contracts/ssh-credentials";
import { chatRemoteAccessContract } from "@okouai/api-contracts/contracts/chat-remote-access";
import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { mockEnv } from "../../../lib/env";
import { tailscaleRoutes } from "../tailscale";
import { cloudflareAccessRoutes } from "../cloudflare-access";
import { sshConnectionsRoutes } from "../ssh-connections";
import { runnerSshRoutes } from "../runner-ssh";
import { chatRemoteAccessRoutes } from "../chat-remote-access";
import { createRouteMocks } from "./helpers/route-test";
import { createClaimedSshRuntimeApi } from "./helpers/claimed-ssh-runtime";
import { useSecretKmsProbe } from "./helpers/secret-kms-probe";
import { createDeferredPromise, joinAll } from "../../utils";

const context = testContext();
const mocks = createRouteMocks(context);
const headers = Object.freeze({ authorization: "Bearer clerk-session" });
const secret = "e".repeat(64);
const runnerHeaders = Object.freeze({
  authorization: `Bearer vm0_official_${secret}`,
});
const oauth = Object.freeze({
  clientId: "synthetic-tail-id",
  clientSecret: "synthetic-tail-secret",
});
const login = Object.freeze({
  name: "Login",
  username: "deploy",
  authentication: { method: "password" as const, password: "synthetic-login" },
});
const key = Object.freeze({
  algorithm: "ssh-ed25519" as const,
  fingerprint: `SHA256:${Buffer.alloc(32, 7).toString("base64").replace(/=+$/u, "")}`,
});
type Owner = { userId: string; orgId: string };
function authenticate(
  o: Owner,
  role: "org:admin" | "org:member" = "org:member",
) {
  mocks.clerk.session(o.userId, o.orgId, role);
  context.mocks.clerk.users.getOrganizationMembershipList.mockResolvedValue({
    data: [
      {
        role,
        organization: { id: o.orgId },
        publicUserData: { userId: o.userId },
      },
    ],
  });
}
function owner(
  orgId = `org_tail_parity_${randomUUID()}`,
  role: "org:admin" | "org:member" = "org:member",
) {
  const o = { orgId, userId: `user_tail_parity_${randomUUID()}` };
  authenticate(o, role);
  return o;
}
const configs = () => {
  return setupApp({ context, routes: tailscaleRoutes })(tailscaleContract);
};
const hosts = () => {
  return setupApp({ context, routes: sshConnectionsRoutes })(
    sshConnectionsContract,
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
const ordinary = createClaimedSshRuntimeApi(context, {
  runnerHeaders,
  authenticate,
});
beforeEach(() => {
  mockEnv("OFFICIAL_RUNNER_SECRET", secret);
  useSecretKmsProbe();
});
afterEach(ordinary.cleanup);
async function config(scope: "personal" | "organization" = "personal") {
  return (
    await accept(
      configs().create({
        headers,
        body: {
          id: randomUUID(),
          name: "Network",
          scope,
          credentials: oauth,
          tags: ["tag:okou"],
        },
      }),
      [201],
    )
  ).body;
}
async function host(configId: string) {
  return (
    await accept(
      hosts().create({
        headers,
        body: {
          id: randomUUID(),
          displayName: "Private host",
          host: "peer",
          port: 2222,
          credential: { create: login },
          transport: { type: "tailscale", configId },
        },
      }),
      [201],
    )
  ).body;
}
async function latest(id: string): Promise<SshConnectionResponse> {
  const value = (
    await accept(hosts().list({ headers }), [200])
  ).body.connections.find((h) => {
    return h.id === id;
  });
  if (!value) {
    throw new Error("Owned test host is missing");
  }
  return value;
}
async function pin(o: Owner, h: SshConnectionResponse) {
  const runtime = await ordinary.runtime(o);
  await accept(
    remote().updateHostDefault({
      headers,
      params: { protocol: "ssh", connectionId: h.id },
      body: { enabled: true },
    }),
    [200],
  );
  await accept(
    runner().pin({
      headers: runnerHeaders,
      params: { runId: runtime.runId },
      body: {
        connectionId: h.id,
        runnerIdentity: runtime.runnerIdentity,
        expectedGeneration: h.generation,
        observedHostKey: key,
      },
    }),
    [200],
  );
  return { runtime, host: await latest(h.id) };
}
async function preview(configId: string, operation: "convert" | "delete") {
  return (
    await accept(
      configs().impactPreview({
        headers,
        params: { configId },
        query: { operation },
      }),
      [200],
    )
  ).body;
}

test("preserves trust through protected endpoint/carrier edits, resets only explicitly or for Direct-to-Direct endpoint changes", async () => {
  const o = owner();
  const c = await config();
  const access = (
    await accept(
      setupApp({ context, routes: cloudflareAccessRoutes })(
        cloudflareAccessContract,
      ).create({
        headers,
        query: { view: "scoped" },
        body: { id: randomUUID(), name: "Gateway", credentials: oauth },
      }),
      [201],
    )
  ).body;
  const direct = (
    await accept(
      hosts().create({
        headers,
        body: {
          id: randomUUID(),
          displayName: "Direct",
          host: "direct.example.com",
          credential: { create: login },
        },
      }),
      [201],
    )
  ).body;
  const pinned = await pin(o, direct);
  let current = pinned.host;
  for (const endpoint of [
    { host: "peer", port: 2222 },
    { host: "other-peer", port: 65_535 },
  ]) {
    current = (
      await accept(
        hosts().update({
          headers,
          params: { connectionId: current.id },
          body: {
            expectedGeneration: current.generation,
            ...endpoint,
            transport: { type: "tailscale", configId: c.id },
          },
        }),
        [200],
      )
    ).body;
    expect(current.learnedHostKey).toStrictEqual(key);
  }
  current = (
    await accept(
      hosts().resetHostKey({
        headers,
        params: { connectionId: current.id },
        body: { expectedGeneration: current.generation },
      }),
      [200],
    )
  ).body;
  expect(current.learnedHostKey).toBeNull();
  await accept(
    runner().pin({
      headers: runnerHeaders,
      params: { runId: pinned.runtime.runId },
      body: {
        connectionId: current.id,
        runnerIdentity: pinned.runtime.runnerIdentity,
        expectedGeneration: current.generation,
        observedHostKey: key,
      },
    }),
    [200],
  );
  current = await latest(current.id);
  const transitions = [
    {
      host: "direct2.example.com",
      port: 22,
      transport: { type: "direct" as const },
    },
    {
      host: "access.example.com",
      port: 443,
      transport: { type: "cloudflare_access" as const, configId: access.id },
    },
    {
      host: "peer",
      port: 2222,
      transport: { type: "tailscale" as const, configId: c.id },
    },
    {
      host: "direct3.example.com",
      port: 22,
      transport: { type: "direct" as const },
    },
  ];
  for (const transition of transitions) {
    current = (
      await accept(
        hosts().update({
          headers,
          params: { connectionId: current.id },
          body: { expectedGeneration: current.generation, ...transition },
        }),
        [200],
      )
    ).body;
    expect(current.learnedHostKey).toStrictEqual(key);
    expect(current.credentialId).toBe(direct.credentialId);
  }
  current = (
    await accept(
      hosts().update({
        headers,
        params: { connectionId: current.id },
        body: {
          expectedGeneration: current.generation,
          host: "direct4.example.com",
        },
      }),
      [200],
    )
  ).body;
  expect(current.learnedHostKey).toBeNull();
});

test("promotes Personal configuration and requires fresh admin impact review for conversion, retaining SSH identity and explicit private rebind", async () => {
  const admin = owner(undefined, "org:admin");
  const c = await config();
  const own = await host(c.id);
  await accept(
    configs().convertToOrganization({
      headers,
      params: { configId: c.id },
      body: { expectedRevision: c.revision + 1 },
    }),
    [409],
  );
  const promoted = (
    await accept(
      configs().convertToOrganization({
        headers,
        params: { configId: c.id },
        body: { expectedRevision: c.revision },
      }),
      [200],
    )
  ).body;
  expect(promoted).toMatchObject({
    id: c.id,
    scope: "organization",
    revision: 2,
    generation: 2,
    sshHosts: [{ id: own.id }],
  });
  expect((await latest(own.id)).generation).toBe(own.generation + 1);
  const member = owner(admin.orgId);
  const admitted = await pin(member, await host(c.id));
  const h = admitted.host;
  for (const operation of ["convert", "delete"] as const) {
    await accept(
      configs().impactPreview({
        headers,
        params: { configId: c.id },
        query: { operation },
      }),
      [403],
    );
  }
  await accept(
    configs().convertToOrganization({
      headers,
      params: { configId: c.id },
      body: { expectedRevision: 2 },
    }),
    [403],
  );
  authenticate(admin, "org:admin");
  const oldImpact = await preview(c.id, "convert");
  expect(oldImpact).toMatchObject({
    ownHostCount: 1,
    otherHostCount: 1,
    affectedOwners: [{ userId: member.userId }],
  });
  expect(JSON.stringify(oldImpact)).not.toContain(h.id);
  authenticate(member);
  const edited = (
    await accept(
      hosts().update({
        headers,
        params: { connectionId: h.id },
        body: {
          expectedGeneration: h.generation,
          displayName: "Reviewed member host",
        },
      }),
      [200],
    )
  ).body;
  authenticate(admin, "org:admin");
  await accept(
    configs().convertToPersonal({
      headers,
      params: { configId: c.id },
      body: {
        expectedRevision: oldImpact.expectedRevision,
        impactSnapshot: oldImpact.impactSnapshot,
      },
    }),
    [409],
  );
  const impact = await preview(c.id, "convert");
  const converted = (
    await accept(
      configs().convertToPersonal({
        headers,
        params: { configId: c.id },
        body: {
          expectedRevision: impact.expectedRevision,
          impactSnapshot: impact.impactSnapshot,
        },
      }),
      [200],
    )
  ).body;
  expect(converted).toMatchObject({
    id: c.id,
    scope: "personal",
    revision: 3,
    generation: 3,
    sshHosts: [{ id: own.id }],
  });
  authenticate(member);
  const retained = await latest(h.id);
  expect(retained).toMatchObject({
    id: h.id,
    credentialId: h.credentialId,
    learnedHostKey: key,
    host: h.host,
    port: h.port,
    generation: edited.generation + 1,
    transport: { type: "tailscale", needsRebind: true },
  });
  expect(
    (await accept(configs().list({ headers }), [200])).body.configs,
  ).toStrictEqual([]);
  const probe = useSecretKmsProbe();
  expect(
    (
      await accept(
        runner().resolve({
          headers: runnerHeaders,
          params: { runId: admitted.runtime.runId },
          body: {
            connectionId: h.id,
            runnerIdentity: admitted.runtime.runnerIdentity,
          },
        }),
        [200],
      )
    ).body,
  ).toStrictEqual({ outcome: "unavailable" });
  expect(probe.decryptCalls).toBe(0);
  await accept(
    hosts().update({
      headers,
      params: { connectionId: h.id },
      body: {
        expectedGeneration: retained.generation,
        displayName: "Missing recovery",
      },
    }),
    [400],
  );
  await accept(
    hosts().update({
      headers,
      params: { connectionId: h.id },
      body: {
        expectedGeneration: retained.generation,
        transport: { type: "tailscale", configId: c.id },
      },
    }),
    [404],
  );
  const replacement = await config();
  const recovered = (
    await accept(
      hosts().update({
        headers,
        params: { connectionId: h.id },
        body: {
          expectedGeneration: retained.generation,
          host: "replacement-peer",
          port: 22,
          transport: { type: "tailscale", configId: replacement.id },
        },
      }),
      [200],
    )
  ).body;
  expect(recovered).toMatchObject({
    learnedHostKey: key,
    credentialId: h.credentialId,
    generation: retained.generation + 1,
    transport: { type: "tailscale", configId: replacement.id },
  });
  useSecretKmsProbe();
  expect(
    (
      await accept(
        runner().resolve({
          headers: runnerHeaders,
          params: { runId: admitted.runtime.runId },
          body: {
            connectionId: h.id,
            runnerIdentity: admitted.runtime.runnerIdentity,
          },
        }),
        [200],
      )
    ).body,
  ).toMatchObject({
    outcome: "resolved_tailscale",
    tailscale: { configId: replacement.id },
  });
});

test("allows another current admin to adopt shared configuration but hides the resulting Personal configuration from its former creator", async () => {
  const creator = owner(undefined, "org:admin");
  const shared = await config("organization");
  const creatorHost = await host(shared.id);
  const admin = owner(creator.orgId, "org:admin");
  const own = await host(shared.id);
  const impact = await preview(shared.id, "convert");
  await accept(
    configs().convertToPersonal({
      headers,
      params: { configId: shared.id },
      body: {
        expectedRevision: impact.expectedRevision,
        impactSnapshot: impact.impactSnapshot,
      },
    }),
    [200],
  );
  await expect(latest(own.id)).resolves.toMatchObject({
    generation: own.generation + 1,
    transport: { type: "tailscale", configId: shared.id },
  });
  authenticate(creator, "org:admin");
  expect(
    (await accept(configs().list({ headers }), [200])).body.configs,
  ).toStrictEqual([]);
  await expect(latest(creatorHost.id)).resolves.toMatchObject({
    transport: { type: "tailscale", needsRebind: true },
  });
  await accept(
    configs().convertToOrganization({
      headers,
      params: { configId: shared.id },
      body: { expectedRevision: 2 },
    }),
    [404],
  );
  authenticate(admin, "org:admin");
  await accept(
    configs().convertToOrganization({
      headers,
      params: { configId: shared.id },
      body: { expectedRevision: 2 },
    }),
    [200],
  );
});

test("refuses own-reference deletion and requires a current impact snapshot before deleting shared configuration referenced only by others", async () => {
  const admin = owner(undefined, "org:admin");
  const shared = await config("organization");
  const own = await host(shared.id);
  const ownImpact = await preview(shared.id, "delete");
  await accept(
    configs().delete({
      headers,
      params: { configId: shared.id },
      body: {
        expectedRevision: ownImpact.expectedRevision,
        impactSnapshot: ownImpact.impactSnapshot,
      },
    }),
    [409],
  );
  await accept(
    hosts().delete({ headers, params: { connectionId: own.id } }),
    [204],
  );
  const member = owner(admin.orgId);
  const admitted = await pin(member, await host(shared.id));
  const h = admitted.host;
  authenticate(admin, "org:admin");
  const stale = await preview(shared.id, "delete");
  await accept(
    configs().delete({
      headers,
      params: { configId: shared.id },
      body: { expectedRevision: shared.revision },
    }),
    [409],
  );
  authenticate(member);
  const edited = (
    await accept(
      hosts().update({
        headers,
        params: { connectionId: h.id },
        body: {
          expectedGeneration: h.generation,
          host: "next-peer",
          port: 65_535,
        },
      }),
      [200],
    )
  ).body;
  authenticate(admin, "org:admin");
  await accept(
    configs().delete({
      headers,
      params: { configId: shared.id },
      body: {
        expectedRevision: stale.expectedRevision,
        impactSnapshot: stale.impactSnapshot,
      },
    }),
    [409],
  );
  const impact = await preview(shared.id, "delete");
  await accept(
    configs().delete({
      headers,
      params: { configId: shared.id },
      body: {
        expectedRevision: impact.expectedRevision,
        impactSnapshot: impact.impactSnapshot,
      },
    }),
    [204],
  );
  authenticate(member);
  expect(
    (await accept(configs().list({ headers }), [200])).body.configs,
  ).toStrictEqual([]);
  const retained = await latest(h.id);
  expect(retained).toMatchObject({
    id: h.id,
    host: edited.host,
    port: 65_535,
    learnedHostKey: key,
    credentialId: h.credentialId,
    generation: edited.generation + 1,
    transport: { type: "tailscale", needsRebind: true },
  });
  const probe = useSecretKmsProbe();
  expect(
    (
      await accept(
        runner().resolve({
          headers: runnerHeaders,
          params: { runId: admitted.runtime.runId },
          body: {
            connectionId: h.id,
            runnerIdentity: admitted.runtime.runnerIdentity,
          },
        }),
        [200],
      )
    ).body,
  ).toStrictEqual({ outcome: "unavailable" });
  expect(probe.decryptCalls).toBe(0);
  const recovered = (
    await accept(
      hosts().update({
        headers,
        params: { connectionId: h.id },
        body: {
          expectedGeneration: retained.generation,
          host: "direct.example.com",
          port: 22,
          transport: { type: "direct" },
        },
      }),
      [200],
    )
  ).body;
  expect(recovered).toMatchObject({
    learnedHostKey: key,
    credentialId: h.credentialId,
  });
  expect(recovered).not.toHaveProperty("transport");
});

test("fences a first network binding created while credential replacement is externally preparing", async () => {
  owner();
  const c = await config();
  const entered = createDeferredPromise<void>(context.signal);
  const release = createDeferredPromise<void>(context.signal);
  useSecretKmsProbe(async (request, call) => {
    if (call === 1) {
      entered.resolve();
      await release.promise;
    }
    return {
      keyId: request.keyId,
      plaintext: Buffer.from("0123456789abcdef0123456789abcdef", "utf8"),
      encryptedDataKey: Buffer.from("synthetic-wrapped-key", "utf8"),
    };
  });
  const rotation = accept(
    configs().update({
      headers,
      params: { configId: c.id },
      body: {
        expectedRevision: c.revision,
        credentials: {
          clientId: "replacement-id",
          clientSecret: "replacement-secret",
        },
      },
    }),
    [200],
  );
  await joinAll([
    (async () => {
      await entered.promise;
      const h = await host(c.id);
      release.resolve();
      const result = await rotation;
      expect(result.body).toMatchObject({
        generation: c.generation + 1,
        sshHosts: [{ id: h.id }],
      });
      expect((await latest(h.id)).generation).toBe(h.generation + 1);
      await accept(
        hosts().update({
          headers,
          params: { connectionId: h.id },
          body: {
            expectedGeneration: h.generation,
            displayName: "Stale first-binding editor",
          },
        }),
        [409],
      );
    })().finally(() => {
      if (!release.settled()) {
        release.resolve();
      }
    }),
    rotation,
  ]);
});

test("rejects a late member binding after reviewed shared conversion without orphaning a prepared login", async () => {
  const admin = owner(undefined, "org:admin");
  const shared = await config("organization");
  const member = owner(admin.orgId);
  const entered = createDeferredPromise<void>(context.signal);
  const release = createDeferredPromise<void>(context.signal);
  useSecretKmsProbe(async (request, call) => {
    if (call === 1) {
      entered.resolve();
      await release.promise;
    }
    return {
      keyId: request.keyId,
      plaintext: Buffer.from("0123456789abcdef0123456789abcdef", "utf8"),
      encryptedDataKey: Buffer.from("synthetic-wrapped-key", "utf8"),
    };
  });
  // The member's authentication/owner is captured before this external KMS gate.
  const binding = accept(
    hosts().create({
      headers,
      body: {
        id: randomUUID(),
        displayName: "Late member host",
        host: "peer",
        credential: { create: login },
        transport: { type: "tailscale", configId: shared.id },
      },
    }),
    [404],
  );
  await joinAll([
    (async () => {
      await entered.promise;
      authenticate(admin, "org:admin");
      const impact = await preview(shared.id, "convert");
      await accept(
        configs().convertToPersonal({
          headers,
          params: { configId: shared.id },
          body: {
            expectedRevision: impact.expectedRevision,
            impactSnapshot: impact.impactSnapshot,
          },
        }),
        [200],
      );
      release.resolve();
      await binding;
      authenticate(member);
      expect(
        (await accept(hosts().list({ headers }), [200])).body.connections,
      ).toStrictEqual([]);
      expect(
        (
          await accept(
            setupApp({ context, routes: sshConnectionsRoutes })(
              sshCredentialsContract,
            ).list({ headers }),
            [200],
          )
        ).body,
      ).toStrictEqual({ credentials: [] });
    })().finally(() => {
      if (!release.settled()) {
        release.resolve();
      }
    }),
    binding,
  ]);
});

test("rotates shared credentials and all current member host generations atomically while name-only changes preserve effective authority", async () => {
  const admin = owner(undefined, "org:admin");
  const shared = await config("organization");
  const first = await host(shared.id);
  const member = owner(admin.orgId);
  const second = await host(shared.id);
  authenticate(admin, "org:admin");
  const renamed = (
    await accept(
      configs().update({
        headers,
        params: { configId: shared.id },
        body: { expectedRevision: shared.revision, name: "Renamed" },
      }),
      [200],
    )
  ).body;
  expect(renamed.generation).toBe(shared.generation);
  expect((await latest(first.id)).generation).toBe(first.generation);
  const rotated = (
    await accept(
      configs().update({
        headers,
        params: { configId: shared.id },
        body: {
          expectedRevision: renamed.revision,
          credentials: { clientId: "new-id", clientSecret: "new-secret" },
        },
      }),
      [200],
    )
  ).body;
  expect(rotated.generation).toBe(shared.generation + 1);
  expect((await latest(first.id)).generation).toBe(first.generation + 1);
  authenticate(member);
  expect((await latest(second.id)).generation).toBe(second.generation + 1);
  await accept(
    hosts().update({
      headers,
      params: { connectionId: second.id },
      body: {
        expectedGeneration: second.generation,
        displayName: "Stale editor",
      },
    }),
    [409],
  );
});
