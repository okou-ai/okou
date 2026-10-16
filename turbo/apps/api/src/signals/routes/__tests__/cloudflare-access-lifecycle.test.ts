import { randomUUID } from "node:crypto";

import { cloudflareAccessContract } from "@okouai/api-contracts/contracts/cloudflare-access";
import { sshConnectionsContract } from "@okouai/api-contracts/contracts/ssh-connections";
import { sshCredentialsContract } from "@okouai/api-contracts/contracts/ssh-credentials";
import { orgDeleteContract } from "@okouai/api-contracts/contracts/org-routes";
import { webhookClerkContract } from "@okouai/api-contracts/contracts/webhooks";
import { createStore } from "ccstate";
import { expect, test } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { mockOptionalEnv } from "../../../lib/env";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { cloudflareAccessRoutes } from "../cloudflare-access";
import { sshConnectionsRoutes } from "../ssh-connections";
import { orgDeleteRoutes } from "../org-delete";
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
  const created = (
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
  if (!("credentialId" in created)) {
    throw new Error("Expected a credential-backed test host");
  }
  return created;
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

test("creator deletion erases private Access while preserving shared Access and another member's SSH host", async () => {
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

  await webhook("user.deleted", creator.userId);

  mocks.clerk.session(member.userId, member.orgId, "org:member");
  const recreated = await accept(
    configs().create({
      headers,
      query,
      body: {
        id: personal.id,
        scope: "personal",
        name: "Replacement after creator erasure",
        credentials: { clientId: "peer-id", clientSecret: "peer-secret" },
      },
    }),
    [201],
  );
  expect(
    (await accept(configs().list({ headers, query }), [200])).body.configs,
  ).toStrictEqual([
    { ...shared, sshHosts: [{ id: host.id, displayName: host.displayName }] },
    recreated.body,
  ]);
  expect(
    (await accept(hosts().list({ headers }), [200])).body.connections,
  ).toContainEqual(expect.objectContaining({ id: host.id }));
});

test.each(["Clerk webhook", "manual"] as const)(
  "%s organization deletion erases remote identities while preserving another organization's resources",
  async (entry) => {
    useSecretKmsProbe();
    const creator = await owner();
    const shared = await createShared();
    await owner(creator.orgId, "member");
    const departedHost = await createHost(shared.id);
    const survivor = await owner();
    const ownConfig = await createShared();
    const ownHost = await createHost(ownConfig.id);

    if (entry === "manual") {
      mocks.clerk.session(creator.userId, creator.orgId, "org:admin");
      context.mocks.clerk.organizations.getOrganization.mockResolvedValue({
        id: creator.orgId,
      });
      context.mocks.clerk.organizations.getOrganizationMembershipList.mockResolvedValue(
        { data: [] },
      );
      context.mocks.clerk.organizations.deleteOrganization.mockResolvedValue(
        {},
      );
      await accept(
        setupApp({ context, routes: orgDeleteRoutes })(
          orgDeleteContract,
        ).delete({
          headers,
          body: { confirm: "confirm" },
        }),
        [200],
      );
    } else {
      await webhook("organization.deleted", creator.orgId);
    }

    mocks.clerk.session(survivor.userId, survivor.orgId, "org:admin");
    const recreated = await accept(
      configs().create({
        headers,
        query,
        body: {
          id: shared.id,
          scope: "organization",
          name: "Replacement after organization erasure",
          credentials: {
            clientId: "foreign-id",
            clientSecret: "foreign-secret",
          },
        },
      }),
      [201],
    );
    expect(
      (await accept(configs().list({ headers, query }), [200])).body.configs,
    ).toStrictEqual([
      {
        ...ownConfig,
        sshHosts: [{ id: ownHost.id, displayName: ownHost.displayName }],
      },
      recreated.body,
    ]);
    expect(
      (await accept(hosts().list({ headers }), [200])).body.connections,
    ).toStrictEqual([ownHost]);
    const recreatedLogin = (
      await accept(
        setupApp({ context, routes: sshConnectionsRoutes })(
          sshCredentialsContract,
        ).create({
          headers,
          body: {
            id: departedHost.credentialId,
            name: "Replacement login after erasure",
            username: "replacement",
            authentication: {
              method: "password",
              password: "replacement-password",
            },
          },
        }),
        [201],
      )
    ).body;
    const recreatedHost = (
      await accept(
        hosts().create({
          headers,
          body: {
            id: departedHost.id,
            displayName: "Replacement host after erasure",
            host: "replacement.example.com",
            port: 443,
            credential: { id: recreatedLogin.id },
            transport: {
              type: "cloudflare_access",
              configId: recreated.body.id,
            },
          },
        }),
        [201],
      )
    ).body;
    expect(
      (await accept(hosts().list({ headers }), [200])).body.connections,
    ).toStrictEqual([ownHost, recreatedHost]);
  },
);

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
      configs().impactPreview({
        headers,
        params: { configId: shared.id },
        query: { operation: "convert" },
      }),
      [403],
    ),
  ).resolves.toMatchObject({
    body: { error: { code: "CLOUDFLARE_ACCESS_FORBIDDEN" } },
  });

  mocks.clerk.session(admin.userId, admin.orgId, "org:admin");
  const preview = (
    await accept(
      configs().impactPreview({
        headers,
        params: { configId: shared.id },
        query: { operation: "convert" },
      }),
      [200],
    )
  ).body;
  expect(preview).toMatchObject({
    expectedRevision: 1,
    otherHostCount: 2,
    impactSnapshot: expect.stringMatching(/^[a-f0-9]{64}$/u),
  });
  expect(preview.affectedOwners).toStrictEqual(
    expect.arrayContaining([
      expect.objectContaining({ userId: member.userId }),
      expect.objectContaining({ userId: secondMember.userId }),
    ]),
  );
  expect(JSON.stringify(preview)).not.toContain("hostCount");
  expect(JSON.stringify(preview)).not.toContain(memberHost.id);
  expect(JSON.stringify(preview)).not.toContain(secondMemberHost.id);
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
      configs().impactPreview({
        headers,
        params: { configId: shared.id },
        query: { operation: "convert" },
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
      configs().impactPreview({
        headers,
        params: { configId: shared.id },
        query: { operation: "convert" },
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
      configs().impactPreview({
        headers,
        params: { configId: shared.id },
        query: { operation: "convert" },
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
    expect([
      "CLOUDFLARE_ACCESS_REVISION_CONFLICT",
      "CLOUDFLARE_ACCESS_IMPACT_CONFLICT",
    ]).toContain(converted.body.error.code);
    expect(
      (await accept(configs().list({ headers, query }), [200])).body.configs,
    ).toContainEqual(
      expect.objectContaining({
        id: shared.id,
        scope: "organization",
        revision: shared.revision,
        generation: shared.generation,
      }),
    );
    expect(
      (await accept(hosts().list({ headers }), [200])).body.connections,
    ).toStrictEqual([host]);
    const latest = (
      await accept(
        configs().impactPreview({
          headers,
          params: { configId: shared.id },
          query: { operation: "convert" },
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
    expect.objectContaining({
      id: shared.id,
      scope: "personal",
      revision: shared.revision + 1,
      generation: shared.generation + 1,
    }),
  );
  expect(
    (await accept(hosts().list({ headers }), [200])).body.connections,
  ).toContainEqual(
    expect.objectContaining({
      id: host.id,
      generation: host.generation + (converted.status === 409 ? 1 : 0),
      transport: { type: "cloudflare_access", configId: shared.id },
    }),
  );
});
