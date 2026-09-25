import { randomUUID } from "node:crypto";

import { cloudflareAccessContract } from "@okouai/api-contracts/contracts/cloudflare-access";
import { sshConnectionsContract } from "@okouai/api-contracts/contracts/ssh-connections";
import { webhookClerkContract } from "@okouai/api-contracts/contracts/webhooks";
import { createStore } from "ccstate";
import { expect, test } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { mockOptionalEnv } from "../../../lib/env";
import { countUserSshAccessResourcesFixture } from "../../../test-fixtures/ssh-access-owner-lifecycle";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { cloudflareAccessRoutes } from "../cloudflare-access";
import { sshConnectionsRoutes } from "../ssh-connections";
import { webhooksClerkRoutes } from "../webhooks-clerk";
import { seedOrgMembership$ } from "./helpers/org-membership";
import { createRouteMocks } from "./helpers/route-test";
import { useSecretKmsProbe } from "./helpers/secret-kms-probe";

const context = testContext();
const store = createStore();
const mocks = createRouteMocks(context);
const headers = Object.freeze({ authorization: "Bearer clerk-session" });
const query = Object.freeze({ view: "scoped" as const });
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

async function owner(
  orgId = `org_shared_access_${randomUUID()}`,
  role: "admin" | "member" = "admin",
) {
  const value = {
    orgId,
    userId: `user_shared_access_${randomUUID()}`,
    membershipId: `orgmem_${randomUUID()}`,
  };
  await store.set(seedOrgMembership$, { ...value, role }, context.signal);
  mocks.clerk.session(value.userId, value.orgId, `org:${role}`);
  mocks.s3.listObjects([]);
  return value;
}

async function createShared() {
  return (
    await accept(
      configs().create({
        headers,
        query,
        body: {
          id: randomUUID(),
          scope: "organization",
          name: "Shared gateway",
          credentials: { clientId: "client-id", clientSecret: "client-secret" },
        },
      }),
      [201],
    )
  ).body;
}

async function createHost(configId: string) {
  return (
    await accept(
      hosts().create({
        headers,
        body: {
          id: randomUUID(),
          displayName: "Shared protected host",
          host: "ssh.example.com",
          port: 443,
          credential: {
            create: {
              name: "Login",
              username: "deploy",
              authentication: { method: "password", password: "password" },
            },
          },
          transport: { type: "cloudflare_access", configId },
        },
      }),
      [201],
    )
  ).body;
}

async function webhook(
  type: "user.deleted" | "organization.deleted",
  id: string,
) {
  mockOptionalEnv(
    "CLERK_WEBHOOK_SIGNING_SECRET",
    "synthetic-access-signing-secret",
  );
  const event = { type, data: { id } };
  context.mocks.clerk.verifyWebhook.mockResolvedValueOnce(event);
  await accept(
    setupApp({ context, routes: webhooksClerkRoutes })(
      webhookClerkContract,
    ).post({
      body: JSON.stringify(event),
    }),
    [200],
  );
  await flushWaitUntilForTest();
}

test("creator erasure preserves shared Access and another member's SSH host", async () => {
  useSecretKmsProbe();
  const creator = await owner();
  const shared = await createShared();
  const personal = (
    await accept(
      configs().create({
        headers,
        query,
        body: {
          id: randomUUID(),
          scope: "personal",
          name: "Personal gateway",
          credentials: {
            clientId: "personal-id",
            clientSecret: "personal-secret",
          },
        },
      }),
      [201],
    )
  ).body;
  await createHost(personal.id);
  const member = await owner(creator.orgId, "member");
  const host = await createHost(shared.id);

  await expect(
    countUserSshAccessResourcesFixture(creator.userId),
  ).resolves.toStrictEqual({
    configs: 1,
    hosts: 1,
    credentials: 1,
  });
  await webhook("user.deleted", creator.userId);

  // The deleted user cannot authenticate to list their own resources. This
  // narrow fixture verifies that encrypted personal state was actually erased.
  await expect(
    countUserSshAccessResourcesFixture(creator.userId),
  ).resolves.toStrictEqual({
    configs: 0,
    hosts: 0,
    credentials: 0,
  });

  mocks.clerk.session(member.userId, member.orgId, "org:member");
  expect(
    (await accept(configs().list({ headers, query }), [200])).body.configs,
  ).toMatchObject([{ id: shared.id, scope: "organization" }]);
  expect(
    (await accept(hosts().list({ headers }), [200])).body.connections,
  ).toContainEqual(expect.objectContaining({ id: host.id }));
});

test("organization erasure removes shared Access after its member SSH references", async () => {
  useSecretKmsProbe();
  const creator = await owner();
  const shared = await createShared();
  const member = await owner(creator.orgId, "member");
  await createHost(shared.id);

  await webhook("organization.deleted", creator.orgId);

  mocks.clerk.session(member.userId, member.orgId, "org:member");
  expect(
    (await accept(configs().list({ headers, query }), [200])).body.configs,
  ).toStrictEqual([]);
  expect(
    (await accept(hosts().list({ headers }), [200])).body.connections,
  ).toStrictEqual([]);
});

test("admin conversion retains the config and hosts while other owners must rebind", async () => {
  useSecretKmsProbe();
  const admin = await owner();
  const shared = await createShared();
  const adminHost = await createHost(shared.id);
  const member = await owner(admin.orgId, "member");
  const memberHost = await createHost(shared.id);
  const secondMember = await owner(admin.orgId, "member");
  const secondMemberHost = await createHost(shared.id);

  await expect(
    accept(
      configs().conversionPreview({
        headers,
        params: { configId: shared.id },
      }),
      [403],
    ),
  ).resolves.toMatchObject({
    body: { error: { code: "CLOUDFLARE_ACCESS_FORBIDDEN" } },
  });

  mocks.clerk.session(admin.userId, admin.orgId, "org:admin");
  const preview = (
    await accept(
      configs().conversionPreview({
        headers,
        params: { configId: shared.id },
      }),
      [200],
    )
  ).body;
  expect(preview).toMatchObject({
    expectedRevision: 1,
    otherHostCount: 2,
    impactSnapshot: expect.stringMatching(/^[a-f0-9]{64}$/u),
  });
  expect(JSON.stringify(preview)).not.toContain(memberHost.id);
  expect(JSON.stringify(preview)).not.toContain(member.userId);
  expect(JSON.stringify(preview)).not.toContain(secondMemberHost.id);
  expect(JSON.stringify(preview)).not.toContain(secondMember.userId);
  mocks.clerk.session(member.userId, member.orgId, "org:member");
  await expect(
    accept(
      configs().convertToPersonal({
        headers,
        params: { configId: shared.id },
        body: {
          expectedRevision: preview.expectedRevision,
          impactSnapshot: preview.impactSnapshot,
        },
      }),
      [403],
    ),
  ).resolves.toMatchObject({
    body: { error: { code: "CLOUDFLARE_ACCESS_FORBIDDEN" } },
  });
  mocks.clerk.session(admin.userId, admin.orgId, "org:admin");
  const converted = await accept(
    configs().convertToPersonal({
      headers,
      params: { configId: shared.id },
      body: {
        expectedRevision: preview.expectedRevision,
        impactSnapshot: preview.impactSnapshot,
      },
    }),
    [200],
  );
  expect(converted.body).toMatchObject({
    id: shared.id,
    scope: "personal",
    revision: 2,
    generation: 2,
    sshHosts: [{ id: adminHost.id }],
  });
  expect(JSON.stringify(converted.body)).not.toContain("client-secret");
  expect(
    (await accept(hosts().list({ headers }), [200])).body.connections,
  ).toContainEqual(
    expect.objectContaining({
      id: adminHost.id,
      generation: adminHost.generation + 1,
      transport: { type: "cloudflare_access", configId: shared.id },
    }),
  );

  mocks.clerk.session(member.userId, member.orgId, "org:member");
  const retained = (
    await accept(hosts().list({ headers }), [200])
  ).body.connections.find((host) => {
    return host.id === memberHost.id;
  });
  expect(retained).toMatchObject({
    id: memberHost.id,
    host: memberHost.host,
    port: memberHost.port,
    credentialId: memberHost.credentialId,
    generation: memberHost.generation + 1,
    transport: { type: "cloudflare_access", needsRebind: true },
  });
  expect(retained).not.toHaveProperty("transport.configId");
  expect(
    (await accept(configs().list({ headers, query }), [200])).body.configs,
  ).toStrictEqual([]);

  mocks.clerk.session(secondMember.userId, secondMember.orgId, "org:member");
  expect(
    (await accept(hosts().list({ headers }), [200])).body.connections,
  ).toContainEqual(
    expect.objectContaining({
      id: secondMemberHost.id,
      generation: secondMemberHost.generation + 1,
      transport: { type: "cloudflare_access", needsRebind: true },
    }),
  );

  await webhook("user.deleted", admin.userId);
  mocks.clerk.session(member.userId, member.orgId, "org:member");
  expect(
    (await accept(hosts().list({ headers }), [200])).body.connections,
  ).toContainEqual(expect.objectContaining({ id: memberHost.id }));
});

test("conversion requires a fresh preview after binding or revision drift", async () => {
  useSecretKmsProbe();
  const admin = await owner();
  const shared = await createShared();
  const initial = (
    await accept(
      configs().conversionPreview({
        headers,
        params: { configId: shared.id },
      }),
      [200],
    )
  ).body;
  const member = await owner(admin.orgId, "member");
  await createHost(shared.id);
  mocks.clerk.session(admin.userId, admin.orgId, "org:admin");
  await expect(
    accept(
      configs().convertToPersonal({
        headers,
        params: { configId: shared.id },
        body: {
          expectedRevision: initial.expectedRevision,
          impactSnapshot: initial.impactSnapshot,
        },
      }),
      [409],
    ),
  ).resolves.toMatchObject({
    body: { error: { code: "CLOUDFLARE_ACCESS_IMPACT_CONFLICT" } },
  });
  const updated = (
    await accept(
      configs().conversionPreview({
        headers,
        params: { configId: shared.id },
      }),
      [200],
    )
  ).body;
  expect(updated.otherHostCount).toBe(1);
  expect(updated.impactSnapshot).not.toBe(initial.impactSnapshot);
  await accept(
    configs().update({
      headers,
      query,
      params: { configId: shared.id },
      body: { expectedRevision: 1, name: "Renamed shared gateway" },
    }),
    [200],
  );
  await expect(
    accept(
      configs().convertToPersonal({
        headers,
        params: { configId: shared.id },
        body: {
          expectedRevision: updated.expectedRevision,
          impactSnapshot: updated.impactSnapshot,
        },
      }),
      [409],
    ),
  ).resolves.toMatchObject({
    body: { error: { code: "CLOUDFLARE_ACCESS_REVISION_CONFLICT" } },
  });
  mocks.clerk.session(member.userId, member.orgId, "org:member");
  expect(
    (await accept(hosts().list({ headers }), [200])).body.connections[0],
  ).toMatchObject({
    transport: { type: "cloudflare_access", configId: shared.id },
  });
});

test("conversion and concurrent host binding retain a valid admin-owned reference", async () => {
  useSecretKmsProbe();
  await owner();
  const shared = await createShared();
  const preview = (
    await accept(
      configs().conversionPreview({
        headers,
        params: { configId: shared.id },
      }),
      [200],
    )
  ).body;
  const [converted, host] = await Promise.all([
    accept(
      configs().convertToPersonal({
        headers,
        params: { configId: shared.id },
        body: {
          expectedRevision: preview.expectedRevision,
          impactSnapshot: preview.impactSnapshot,
        },
      }),
      [200, 409],
    ),
    createHost(shared.id),
  ]);
  if (converted.status === 409) {
    expect(converted.body.error.code).toBe("CLOUDFLARE_ACCESS_IMPACT_CONFLICT");
    const latest = (
      await accept(
        configs().conversionPreview({
          headers,
          params: { configId: shared.id },
        }),
        [200],
      )
    ).body;
    await accept(
      configs().convertToPersonal({
        headers,
        params: { configId: shared.id },
        body: {
          expectedRevision: latest.expectedRevision,
          impactSnapshot: latest.impactSnapshot,
        },
      }),
      [200],
    );
  }
  expect(
    (await accept(configs().list({ headers, query }), [200])).body.configs,
  ).toContainEqual(
    expect.objectContaining({ id: shared.id, scope: "personal" }),
  );
  expect(
    (await accept(hosts().list({ headers }), [200])).body.connections,
  ).toContainEqual(
    expect.objectContaining({
      id: host.id,
      transport: { type: "cloudflare_access", configId: shared.id },
    }),
  );
});
