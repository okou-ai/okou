import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, expect, test } from "vitest";
import {
  tailscaleContract,
  type UpdateTailscaleRequest,
} from "@okouai/api-contracts/contracts/tailscale";
import {
  sshConnectionsContract,
  type SshConnectionResponse,
} from "@okouai/api-contracts/contracts/ssh-connections";
import { runnerSshContract } from "@okouai/api-contracts/contracts/runner-ssh";
import { chatRemoteAccessContract } from "@okouai/api-contracts/contracts/chat-remote-access";
import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { mockEnv } from "../../../lib/env";
import { nowDate } from "../../../lib/time";
import { tailscaleRoutes } from "../tailscale";
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
const secret = "f".repeat(64);
const runnerHeaders = Object.freeze({
  authorization: `Bearer vm0_official_${secret}`,
});
const key = Object.freeze({
  algorithm: "ssh-ed25519" as const,
  fingerprint: `SHA256:${Buffer.alloc(32, 9).toString("base64").replace(/=+$/u, "")}`,
});
type Owner = { readonly userId: string; readonly orgId: string };
type MetadataEdit = "name" | "tag order";
function owner(orgId = `org_tail_metadata_${randomUUID()}`): Owner {
  return { orgId, userId: `user_tail_metadata_${randomUUID()}` };
}
function authenticate(
  o: Owner,
  role: "org:admin" | "org:member" = "org:admin",
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
const ordinary = createClaimedSshRuntimeApi(context, {
  runnerHeaders,
  authenticate,
});
beforeEach(() => {
  mockEnv("OFFICIAL_RUNNER_SECRET", secret);
  useSecretKmsProbe();
});
afterEach(ordinary.cleanup);
async function config() {
  return (
    await accept(
      configs().create({
        headers,
        body: {
          id: randomUUID(),
          name: "Shared private network",
          scope: "organization",
          credentials: {
            clientId: "synthetic-metadata-id",
            clientSecret: "synthetic-metadata-secret",
          },
          tags: ["tag:prod", "tag:ci"],
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
          credential: {
            create: {
              name: "Independent login",
              username: "deploy",
              authentication: {
                method: "password",
                password: "synthetic-login",
              },
            },
          },
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
    throw new Error("Owned metadata test host is missing");
  }
  return value;
}
function metadataBody(
  kind: MetadataEdit,
  expectedRevision: number,
): UpdateTailscaleRequest {
  return kind === "name"
    ? { expectedRevision, name: "Renamed private network" }
    : { expectedRevision, tags: ["tag:ci", "tag:prod"] };
}

test.each(["name", "tag order"] as const)(
  "commits only one concurrent %s edit for the same revision and returns its decoded state",
  async (kind) => {
    const admin = owner();
    authenticate(admin);
    const shared = await config();
    const request = {
      headers,
      params: { configId: shared.id },
      body: metadataBody(kind, shared.revision),
    };
    const results = await joinAll([
      accept(configs().update(request), [200, 409]),
      accept(configs().update(request), [200, 409]),
    ]);
    expect(
      results
        .map((result) => {
          return result.status;
        })
        .sort(),
    ).toStrictEqual([200, 409]);
    const winner = results.find((result) => {
      return result.status === 200;
    });
    const rejected = results.find((result) => {
      return result.status === 409;
    });
    expect(winner?.body).toStrictEqual({
      ...shared,
      name: kind === "name" ? "Renamed private network" : shared.name,
      tags: kind === "tag order" ? ["tag:ci", "tag:prod"] : shared.tags,
      revision: shared.revision + 1,
      updatedAt: expect.any(String),
    });
    expect(rejected?.body).toMatchObject({
      error: { code: "TAILSCALE_REVISION_CONFLICT" },
    });
    expect(
      (await accept(configs().list({ headers }), [200])).body.configs,
    ).toStrictEqual([winner?.body]);
  },
);

test.each(["name", "tag order"] as const)(
  "updates %s alongside host editing and selected binding without exposing another owner's hosts",
  async (kind) => {
    const admin = owner();
    authenticate(admin);
    const shared = await config();
    const own = await host(shared.id);
    const member = owner(admin.orgId);
    authenticate(member, "org:member");
    const other = await host(shared.id);
    authenticate(admin);
    const metadata = accept(
      configs().update({
        headers,
        params: { configId: shared.id },
        body: metadataBody(kind, shared.revision),
      }),
      [200],
    );
    const edited = accept(
      hosts().update({
        headers,
        params: { connectionId: own.id },
        body: {
          expectedGeneration: own.generation,
          displayName: "Edited private host",
        },
      }),
      [200],
    );
    const bound = accept(
      hosts().create({
        headers,
        body: {
          id: randomUUID(),
          displayName: "New binding",
          host: "another-peer",
          port: 2223,
          credential: { id: own.credentialId },
          transport: { type: "tailscale", configId: shared.id },
        },
      }),
      [201],
    );
    await joinAll([metadata, edited, bound]);
    const updated = (await metadata).body;
    const created = (await bound).body;
    expect(updated).toMatchObject({
      revision: shared.revision + 1,
      generation: shared.generation,
    });
    expect(updated.sshHosts).toContainEqual(
      expect.objectContaining({ id: own.id }),
    );
    for (const reference of updated.sshHosts) {
      expect([own.id, created.id]).toContain(reference.id);
    }
    expect((await edited).body).toMatchObject({
      generation: own.generation + 1,
      host: own.host,
      port: own.port,
      credentialId: own.credentialId,
      username: own.username,
      learnedHostKey: own.learnedHostKey,
      transport: { type: "tailscale", configId: shared.id },
    });
    await expect(latest(own.id)).resolves.toStrictEqual((await edited).body);
    await expect(latest(created.id)).resolves.toStrictEqual(created);
    authenticate(member, "org:member");
    await expect(latest(other.id)).resolves.toStrictEqual(other);
  },
);

test.each(["name", "tag order"] as const)(
  "preserves winning-Runner pin and observation authority during a concurrent %s update",
  async (kind) => {
    const admin = owner();
    authenticate(admin);
    const shared = await config();
    const saved = await host(shared.id);
    const runtime = await ordinary.runtime(admin);
    await accept(
      setupApp({ context, routes: chatRemoteAccessRoutes })(
        chatRemoteAccessContract,
      ).updateHostDefault({
        headers,
        params: { protocol: "ssh", connectionId: saved.id },
        body: { enabled: true },
      }),
      [200],
    );
    const metadata = accept(
      configs().update({
        headers,
        params: { configId: shared.id },
        body: metadataBody(kind, shared.revision),
      }),
      [200],
    );
    const pinned = accept(
      runner().pin({
        headers: runnerHeaders,
        params: { runId: runtime.runId },
        body: {
          connectionId: saved.id,
          runnerIdentity: runtime.runnerIdentity,
          expectedGeneration: saved.generation,
          observedHostKey: key,
        },
      }),
      [200],
    );
    await joinAll([metadata, pinned]);
    expect((await metadata).body.generation).toBe(shared.generation);
    expect((await pinned).body).toStrictEqual({
      outcome: "pinned",
      generation: saved.generation + 1,
    });
    const current = await latest(saved.id);
    expect(current).toMatchObject({
      generation: saved.generation + 1,
      learnedHostKey: key,
      host: saved.host,
      port: saved.port,
      credentialId: saved.credentialId,
      username: saved.username,
      transport: { type: "tailscale", configId: shared.id },
    });
    expect(
      (
        await accept(
          runner().observe({
            headers: runnerHeaders,
            params: { runId: runtime.runId },
            body: {
              connectionId: saved.id,
              runnerIdentity: runtime.runnerIdentity,
              expectedGeneration: current.generation,
              observedAt: nowDate().toISOString(),
              failureReason: null,
            },
          }),
          [200],
        )
      ).body,
    ).toStrictEqual({ outcome: "recorded" });
  },
);

test.each(["name", "tag order"] as const)(
  "rejects a credential replacement prepared before a %s update without changing host authority",
  async (kind) => {
    const admin = owner();
    authenticate(admin);
    const shared = await config();
    const saved = await host(shared.id);
    const entered = createDeferredPromise<void>(context.signal);
    const release = createDeferredPromise<void>(context.signal);
    const probe = useSecretKmsProbe(async (request, call) => {
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
        params: { configId: shared.id },
        body: {
          expectedRevision: shared.revision,
          credentials: {
            clientId: "replacement-id",
            clientSecret: "replacement-secret",
          },
        },
      }),
      [409],
    );
    await joinAll([
      (async () => {
        await entered.promise;
        const updated = await accept(
          configs().update({
            headers,
            params: { configId: shared.id },
            body: metadataBody(kind, shared.revision),
          }),
          [200],
        );
        expect(updated.body).toMatchObject({
          revision: shared.revision + 1,
          generation: shared.generation,
        });
        expect(probe.generateDataKeyCalls).toBe(1);
        release.resolve();
        expect((await rotation).body).toMatchObject({
          error: { code: "TAILSCALE_REVISION_CONFLICT" },
        });
        await expect(latest(saved.id)).resolves.toStrictEqual(saved);
      })().finally(() => {
        if (!release.settled()) {
          release.resolve();
        }
      }),
      rotation,
    ]);
  },
);

test.each([
  { kind: "name", operation: "convert" },
  { kind: "name", operation: "delete" },
  { kind: "tag order", operation: "convert" },
  { kind: "tag order", operation: "delete" },
] as const)(
  "invalidates reviewed $operation impact after a $kind update and keeps shared management admin-only",
  async ({ kind, operation }) => {
    const admin = owner();
    authenticate(admin);
    const shared = await config();
    const member = owner(admin.orgId);
    authenticate(member, "org:member");
    const saved = await host(shared.id);
    authenticate(admin);
    const impact = (
      await accept(
        configs().impactPreview({
          headers,
          params: { configId: shared.id },
          query: { operation },
        }),
        [200],
      )
    ).body;
    const updated = (
      await accept(
        configs().update({
          headers,
          params: { configId: shared.id },
          body: metadataBody(kind, shared.revision),
        }),
        [200],
      )
    ).body;
    expect(updated).toMatchObject({
      revision: shared.revision + 1,
      generation: shared.generation,
      sshHosts: [],
    });
    const request = {
      headers,
      params: { configId: shared.id },
      body: {
        expectedRevision: impact.expectedRevision,
        impactSnapshot: impact.impactSnapshot,
      },
    };
    if (operation === "convert") {
      await accept(configs().convertToPersonal(request), [409]);
    } else {
      await accept(configs().delete(request), [409]);
    }
    authenticate(member, "org:member");
    await accept(
      configs().update({
        headers,
        params: { configId: shared.id },
        body: metadataBody(kind, updated.revision),
      }),
      [403],
    );
    await expect(latest(saved.id)).resolves.toStrictEqual(saved);
    expect(
      (await accept(configs().list({ headers }), [200])).body.configs,
    ).toContainEqual({
      ...updated,
      sshHosts: [{ id: saved.id, displayName: saved.displayName }],
    });
  },
);
