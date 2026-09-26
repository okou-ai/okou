import { randomUUID } from "node:crypto";

import { cloudflareAccessContract } from "@okouai/api-contracts/contracts/cloudflare-access";
import { sshConnectionsContract } from "@okouai/api-contracts/contracts/ssh-connections";
import { webhookClerkContract } from "@okouai/api-contracts/contracts/webhooks";
import { createStore } from "ccstate";
import { expect, test } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { mockOptionalEnv } from "../../../lib/env";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { cloudflareAccessRoutes } from "../cloudflare-access";
import { sshConnectionsRoutes } from "../ssh-connections";
import { webhooksClerkRoutes } from "../webhooks-clerk";
import { mockClerkUsers } from "./helpers/clerk-users";
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

async function actor(
  orgId = `org_promotion_${randomUUID()}`,
  role: "admin" | "member" = "admin",
) {
  const identity = {
    orgId,
    userId: `user_${randomUUID()}`,
    membershipId: `orgmem_${randomUUID()}`,
  };
  await store.set(seedOrgMembership$, { ...identity, role }, context.signal);
  mocks.clerk.session(identity.userId, identity.orgId, `org:${role}`);
  mocks.s3.listObjects([]);
  return identity;
}
function session(
  identity: { readonly orgId: string; readonly userId: string },
  role: "admin" | "member",
) {
  mocks.clerk.session(identity.userId, identity.orgId, `org:${role}`);
}
async function createConfig(scope: "personal" | "organization" = "personal") {
  return (
    await accept(
      configs().create({
        headers,
        query,
        body: {
          id: randomUUID(),
          scope,
          name: "Protected gateway",
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
function hostCreation(configId: string) {
  return hosts().create({
    headers,
    body: {
      id: randomUUID(),
      displayName: "Protected host",
      host: "ssh.example.com",
      port: 443,
      credential: {
        create: {
          name: "Login",
          username: "deploy",
          authentication: {
            method: "password",
            password: "synthetic-password",
          },
        },
      },
      transport: { type: "cloudflare_access", configId },
    },
  });
}
async function createHost(configId: string) {
  return (await accept(hostCreation(configId), [201])).body;
}

test("only an admin may promote their own Personal configuration in place without losing SSH bindings", async () => {
  useSecretKmsProbe();
  const admin = await actor();
  const personal = await createConfig();
  const original = await createHost(personal.id);
  const member = await actor(admin.orgId, "member");
  const memberPersonal = await createConfig();
  await expect(
    accept(
      configs().convertToOrganization({
        headers,
        params: { configId: memberPersonal.id },
        body: { expectedRevision: 1 },
      }),
      [403],
    ),
  ).resolves.toMatchObject({
    body: { error: { code: "CLOUDFLARE_ACCESS_FORBIDDEN" } },
  });
  session(admin, "admin");
  await accept(
    configs().convertToOrganization({
      headers,
      params: { configId: memberPersonal.id },
      body: { expectedRevision: 1 },
    }),
    [404],
  );
  await actor();
  await accept(
    configs().convertToOrganization({
      headers,
      params: { configId: personal.id },
      body: { expectedRevision: 1 },
    }),
    [404],
  );
  session(admin, "admin");
  await accept(
    configs().convertToOrganization({
      headers,
      params: { configId: personal.id },
      body: { expectedRevision: 2 },
    }),
    [409],
  );
  const promoted = await accept(
    configs().convertToOrganization({
      headers,
      params: { configId: personal.id },
      body: { expectedRevision: 1 },
    }),
    [200],
  );
  expect(promoted.body).toMatchObject({
    id: personal.id,
    scope: "organization",
    revision: 2,
    generation: 2,
    sshHosts: [{ id: original.id }],
  });
  expect(JSON.stringify(promoted.body)).not.toContain("synthetic-secret");
  const retained = (
    await accept(hosts().list({ headers }), [200])
  ).body.connections.find(({ id }) => {
    return id === original.id;
  });
  expect(retained).toMatchObject({
    credentialId: original.credentialId,
    port: original.port,
    generation: original.generation + 1,
    transport: { type: "cloudflare_access", configId: personal.id },
  });
  session(member, "member");
  expect(
    (await accept(configs().list({ headers, query }), [200])).body.configs,
  ).toContainEqual(
    expect.objectContaining({
      id: personal.id,
      scope: "organization",
      sshHosts: [],
    }),
  );
  const memberHost = await createHost(personal.id);
  mockOptionalEnv(
    "CLERK_WEBHOOK_SIGNING_SECRET",
    "synthetic-access-signing-secret",
  );
  const event = { type: "user.deleted", data: { id: admin.userId } };
  context.mocks.clerk.verifyWebhook.mockResolvedValueOnce(event);
  await accept(
    setupApp({ context, routes: webhooksClerkRoutes })(
      webhookClerkContract,
    ).post({ body: JSON.stringify(event) }),
    [200],
  );
  await flushWaitUntilForTest();
  session(member, "member");
  expect(
    (await accept(configs().list({ headers, query }), [200])).body.configs,
  ).toContainEqual(
    expect.objectContaining({ id: personal.id, scope: "organization" }),
  );
  expect(
    (await accept(hosts().list({ headers }), [200])).body.connections,
  ).toContainEqual(
    expect.objectContaining({
      id: memberHost.id,
      transport: { type: "cloudflare_access", configId: personal.id },
    }),
  );
});

test("named impact previews disclose total hosts and owners, never per-owner usage or host details", async () => {
  useSecretKmsProbe();
  const admin = await actor();
  const shared = await createConfig("organization");
  const ownHost = await createHost(shared.id);
  const first = await actor(admin.orgId, "member");
  const firstHost = await createHost(shared.id);
  await createHost(shared.id);
  const second = await actor(admin.orgId, "member");
  const secondHost = await createHost(shared.id);
  mockClerkUsers(context, [
    {
      id: first.userId,
      firstName: "First",
      lastName: "Member",
      emailAddresses: [],
      primaryEmailAddressId: null,
      imageUrl: "",
    },
  ]);
  await accept(
    configs().impactPreview({
      headers,
      params: { configId: shared.id },
      query: { operation: "convert" },
    }),
    [403],
  );
  await accept(
    configs().impactPreview({
      headers,
      params: { configId: shared.id },
      query: { operation: "delete" },
    }),
    [403],
  );
  session(admin, "admin");
  const convert = (
    await accept(
      configs().impactPreview({
        headers,
        params: { configId: shared.id },
        query: { operation: "convert" },
      }),
      [200],
    )
  ).body;
  const deletion = (
    await accept(
      configs().impactPreview({
        headers,
        params: { configId: shared.id },
        query: { operation: "delete" },
      }),
      [200],
    )
  ).body;
  for (const preview of [convert, deletion]) {
    expect(preview).toMatchObject({
      expectedRevision: 1,
      ownHostCount: 1,
      otherHostCount: 3,
      affectedOwners: expect.arrayContaining([
        { userId: first.userId, displayName: "First Member" },
        { userId: second.userId, displayName: null },
      ]),
    });
    expect(preview.affectedOwners).toHaveLength(2);
    const body = JSON.stringify(preview);
    expect(body).not.toContain("hostCount");
    expect(body).not.toContain(firstHost.id);
    expect(body).not.toContain(secondHost.id);
    expect(body).not.toContain(ownHost.id);
    expect(body).not.toContain("Protected host");
  }
  expect(convert.impactSnapshot).toBe(deletion.impactSnapshot);
});

test("new impact previews omit the warning data when no other hosts are bound", async () => {
  useSecretKmsProbe();
  await actor();
  const shared = await createConfig("organization");
  for (const operation of ["convert", "delete"] as const) {
    const preview = (
      await accept(
        configs().impactPreview({
          headers,
          params: { configId: shared.id },
          query: { operation },
        }),
        [200],
      )
    ).body;
    expect(preview).toMatchObject({
      ownHostCount: 0,
      otherHostCount: 0,
      affectedOwners: [],
    });
  }
});

test("an admin reviews aggregate impact before deleting other owners' hosts; stale or unreviewed requests cannot detach them", async () => {
  useSecretKmsProbe();
  const admin = await actor();
  const shared = await createConfig("organization");
  const first = await actor(admin.orgId, "member");
  const firstHost = await createHost(shared.id);
  await createHost(shared.id);
  const second = await actor(admin.orgId, "member");
  const secondHost = await createHost(shared.id);
  mockClerkUsers(context, [
    {
      id: first.userId,
      firstName: "First",
      lastName: "Member",
      emailAddresses: [],
      primaryEmailAddressId: null,
      imageUrl: "",
    },
  ]);
  await accept(
    configs().impactPreview({
      headers,
      params: { configId: shared.id },
      query: { operation: "delete" },
    }),
    [403],
  );
  session(admin, "admin");
  const preview = (
    await accept(
      configs().impactPreview({
        headers,
        params: { configId: shared.id },
        query: { operation: "delete" },
      }),
      [200],
    )
  ).body;
  expect(preview).toMatchObject({
    expectedRevision: 1,
    ownHostCount: 0,
    otherHostCount: 3,
    affectedOwners: expect.arrayContaining([
      { userId: first.userId, displayName: "First Member" },
      { userId: second.userId, displayName: null },
    ]),
  });
  expect(preview.affectedOwners).toHaveLength(2);
  expect(JSON.stringify(preview)).not.toContain("hostCount");
  expect(JSON.stringify(preview)).not.toContain(firstHost.id);
  expect(JSON.stringify(preview)).not.toContain(secondHost.id);
  await expect(
    accept(
      configs().delete({
        headers,
        query,
        params: { configId: shared.id },
        body: { expectedRevision: 1 },
      }),
      [409],
    ),
  ).resolves.toMatchObject({
    body: { error: { code: "CLOUDFLARE_ACCESS_IMPACT_CONFLICT" } },
  });
  session(first, "member");
  await createHost(shared.id);
  session(admin, "admin");
  await accept(
    configs().delete({
      headers,
      query,
      params: { configId: shared.id },
      body: { expectedRevision: 1, impactSnapshot: preview.impactSnapshot },
    }),
    [409],
  );
  const latest = (
    await accept(
      configs().impactPreview({
        headers,
        params: { configId: shared.id },
        query: { operation: "delete" },
      }),
      [200],
    )
  ).body;
  expect(latest.otherHostCount).toBe(4);
  expect(latest.affectedOwners).toHaveLength(2);
  expect(latest.impactSnapshot).not.toBe(preview.impactSnapshot);
  await accept(
    configs().update({
      headers,
      query,
      params: { configId: shared.id },
      body: { expectedRevision: 1, name: "Renamed protected gateway" },
    }),
    [200],
  );
  await expect(
    accept(
      configs().delete({
        headers,
        query,
        params: { configId: shared.id },
        body: {
          expectedRevision: latest.expectedRevision,
          impactSnapshot: latest.impactSnapshot,
        },
      }),
      [409],
    ),
  ).resolves.toMatchObject({
    body: { error: { code: "CLOUDFLARE_ACCESS_REVISION_CONFLICT" } },
  });
  const reviewedAgain = (
    await accept(
      configs().impactPreview({
        headers,
        params: { configId: shared.id },
        query: { operation: "delete" },
      }),
      [200],
    )
  ).body;
  expect(reviewedAgain.expectedRevision).toBe(2);
  await accept(
    configs().delete({
      headers,
      query,
      params: { configId: shared.id },
      body: {
        expectedRevision: reviewedAgain.expectedRevision,
        impactSnapshot: reviewedAgain.impactSnapshot,
      },
    }),
    [204],
  );
  expect(
    (await accept(configs().list({ headers, query }), [200])).body.configs,
  ).toStrictEqual([]);
  session(first, "member");
  expect(
    (await accept(hosts().list({ headers }), [200])).body.connections,
  ).toContainEqual(
    expect.objectContaining({
      id: firstHost.id,
      host: firstHost.host,
      credentialId: firstHost.credentialId,
      generation: firstHost.generation + 1,
      transport: { type: "cloudflare_access", needsRebind: true },
    }),
  );
  session(second, "member");
  expect(
    (await accept(hosts().list({ headers }), [200])).body.connections,
  ).toContainEqual(
    expect.objectContaining({
      id: secondHost.id,
      generation: secondHost.generation + 1,
      transport: { type: "cloudflare_access", needsRebind: true },
    }),
  );
});

test("a reviewed deletion is stale when a member removes the last reference", async () => {
  useSecretKmsProbe();
  const admin = await actor();
  const shared = await createConfig("organization");
  const member = await actor(admin.orgId, "member");
  const host = await createHost(shared.id);
  session(admin, "admin");
  const preview = (
    await accept(
      configs().impactPreview({
        headers,
        params: { configId: shared.id },
        query: { operation: "delete" },
      }),
      [200],
    )
  ).body;
  session(member, "member");
  await accept(
    hosts().delete({ headers, params: { connectionId: host.id } }),
    [204],
  );
  session(admin, "admin");
  await expect(
    accept(
      configs().delete({
        headers,
        query,
        params: { configId: shared.id },
        body: {
          expectedRevision: preview.expectedRevision,
          impactSnapshot: preview.impactSnapshot,
        },
      }),
      [409],
    ),
  ).resolves.toMatchObject({
    body: { error: { code: "CLOUDFLARE_ACCESS_IMPACT_CONFLICT" } },
  });
  expect(
    (await accept(configs().list({ headers, query }), [200])).body.configs,
  ).toContainEqual(expect.objectContaining({ id: shared.id }));
});

test("losing admin role after a deletion preview cannot detach another member's host", async () => {
  useSecretKmsProbe();
  const admin = await actor();
  const shared = await createConfig("organization");
  const member = await actor(admin.orgId, "member");
  const host = await createHost(shared.id);
  session(admin, "admin");
  const preview = (
    await accept(
      configs().impactPreview({
        headers,
        params: { configId: shared.id },
        query: { operation: "delete" },
      }),
      [200],
    )
  ).body;
  await store.set(
    seedOrgMembership$,
    { ...admin, role: "member" },
    context.signal,
  );
  session(admin, "member");
  await expect(
    accept(
      configs().delete({
        headers,
        query,
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
  session(member, "member");
  expect(
    (await accept(hosts().list({ headers }), [200])).body.connections,
  ).toContainEqual(
    expect.objectContaining({
      id: host.id,
      transport: { type: "cloudflare_access", configId: shared.id },
    }),
  );
});

test("binding and reviewed deletion serialize without leaving a broken SSH reference", async () => {
  useSecretKmsProbe();
  await actor();
  const shared = await createConfig("organization");
  const preview = (
    await accept(
      configs().impactPreview({
        headers,
        params: { configId: shared.id },
        query: { operation: "delete" },
      }),
      [200],
    )
  ).body;
  const [deleted, bound] = await Promise.all([
    accept(
      configs().delete({
        headers,
        query,
        params: { configId: shared.id },
        body: {
          expectedRevision: preview.expectedRevision,
          impactSnapshot: preview.impactSnapshot,
        },
      }),
      [204, 409],
    ),
    accept(hostCreation(shared.id), [201, 404, 409]),
  ]);
  const listed = (await accept(hosts().list({ headers }), [200])).body
    .connections;
  const remaining = (await accept(configs().list({ headers, query }), [200]))
    .body.configs;
  if (bound.status === 201) {
    expect(deleted.status).toBe(409);
    expect(remaining).toContainEqual(
      expect.objectContaining({ id: shared.id }),
    );
    expect(listed).toContainEqual(
      expect.objectContaining({
        id: bound.body.id,
        transport: { type: "cloudflare_access", configId: shared.id },
      }),
    );
  } else {
    expect(deleted.status).toBe(204);
    expect(remaining).toStrictEqual([]);
    expect(listed).toStrictEqual([]);
  }
});

test("a newly bound self-owned host blocks deletion after an initially empty review", async () => {
  useSecretKmsProbe();
  await actor();
  const shared = await createConfig("organization");
  const preview = (
    await accept(
      configs().impactPreview({
        headers,
        params: { configId: shared.id },
        query: { operation: "delete" },
      }),
      [200],
    )
  ).body;
  expect(preview.ownHostCount).toBe(0);
  expect(preview.affectedOwners).toStrictEqual([]);
  const host = await createHost(shared.id);
  await expect(
    accept(
      configs().delete({
        headers,
        query,
        params: { configId: shared.id },
        body: {
          expectedRevision: preview.expectedRevision,
          impactSnapshot: preview.impactSnapshot,
        },
      }),
      [409],
    ),
  ).resolves.toMatchObject({
    body: { error: { code: "CLOUDFLARE_ACCESS_IN_USE" } },
  });
  expect(
    (await accept(hosts().list({ headers }), [200])).body.connections,
  ).toContainEqual(
    expect.objectContaining({
      id: host.id,
      transport: { type: "cloudflare_access", configId: shared.id },
    }),
  );
});

test("self-owned SSH references block deletion even with a reviewed snapshot; an ordinary member cannot preview impact", async () => {
  useSecretKmsProbe();
  const admin = await actor();
  const shared = await createConfig("organization");
  const selfHost = await createHost(shared.id);
  const other = await actor(admin.orgId, "member");
  const otherHost = await createHost(shared.id);
  await accept(
    configs().impactPreview({
      headers,
      params: { configId: shared.id },
      query: { operation: "delete" },
    }),
    [403],
  );
  session(admin, "admin");
  const preview = (
    await accept(
      configs().impactPreview({
        headers,
        params: { configId: shared.id },
        query: { operation: "delete" },
      }),
      [200],
    )
  ).body;
  expect(preview.ownHostCount).toBe(1);
  await expect(
    accept(
      configs().delete({
        headers,
        query,
        params: { configId: shared.id },
        body: { expectedRevision: 1, impactSnapshot: preview.impactSnapshot },
      }),
      [409],
    ),
  ).resolves.toMatchObject({
    body: { error: { code: "CLOUDFLARE_ACCESS_IN_USE" } },
  });
  session(other, "member");
  expect(
    (await accept(hosts().list({ headers }), [200])).body.connections,
  ).toContainEqual(
    expect.objectContaining({
      id: otherHost.id,
      transport: { type: "cloudflare_access", configId: shared.id },
    }),
  );
  session(admin, "admin");
  expect(
    (await accept(hosts().list({ headers }), [200])).body.connections,
  ).toContainEqual(
    expect.objectContaining({
      id: selfHost.id,
      transport: { type: "cloudflare_access", configId: shared.id },
    }),
  );
});
