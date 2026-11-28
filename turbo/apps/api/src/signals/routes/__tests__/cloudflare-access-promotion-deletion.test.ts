import { randomUUID } from "node:crypto";

import { cloudflareAccessContract } from "@okouai/api-contracts/contracts/cloudflare-access";
import { sshConnectionsContract } from "@okouai/api-contracts/contracts/ssh-connections";
import { webhookClerkContract } from "@okouai/api-contracts/contracts/webhooks";
import { describe, expect, it } from "vitest";

import { mockNow, now } from "../../../lib/time";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { cloudflareAccessRoutes } from "../cloudflare-access";
import { sshConnectionsRoutes } from "../ssh-connections";
import { webhooksClerkRoutes } from "../webhooks-clerk";
import { mockClerkUsers } from "./helpers/clerk-users";
import { createRouteMocks } from "./helpers/route-test";
import { inlineSshKey } from "./helpers/ssh-credential";

const context = testContext();
const headers = Object.freeze({ authorization: "Bearer clerk-session" });

interface Actor {
  readonly userId: string;
  readonly orgId: string;
  readonly role: "org:admin" | "org:member";
}

function workspace() {
  const orgId = `org_${randomUUID()}`;
  const actor = (role: Actor["role"]): Actor => {
    return { userId: `user_${randomUUID()}`, orgId, role };
  };
  return { admin: actor("org:admin"), member: actor("org:member") };
}

function signIn(actor: Actor) {
  createRouteMocks(context).clerk.session(
    actor.userId,
    actor.orgId,
    actor.role,
  );
}

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

async function createConfig(
  actor: Actor,
  scope: "personal" | "organization",
  id: string = randomUUID(),
) {
  signIn(actor);
  const created = await accept(
    configs().create({
      headers,
      query: { view: "scoped" },
      body: {
        id,
        name: `Access ${id.slice(0, 8)}`,
        scope,
        credentials: {
          clientId: `client-${randomUUID()}`,
          clientSecret: `secret-${randomUUID()}`,
        },
      },
    }),
    [201],
  );
  return created.body;
}

async function bindHost(actor: Actor, configId: string) {
  signIn(actor);
  const id = randomUUID();
  const created = await accept(
    hosts().create({
      headers,
      body: {
        id,
        displayName: `Host ${id.slice(0, 8)}`,
        host: `ssh-${id.slice(0, 8)}.example.test`,
        port: 443,
        credential: inlineSshKey("deploy", `key-${randomUUID()}`),
        transport: { type: "cloudflare_access", configId },
      },
    }),
    [201],
  );
  return created.body;
}

async function listHosts(actor: Actor) {
  signIn(actor);
  const listed = await accept(hosts().list({ headers }), [200]);
  return listed.body.connections;
}

async function listConfigs(actor: Actor) {
  signIn(actor);
  const listed = await accept(
    configs().list({ headers, query: { view: "scoped" } }),
    [200],
  );
  return listed.body.configs;
}

async function deleteClerkUser(userId: string) {
  context.mocks.clerk.verifyWebhook.mockResolvedValue({
    type: "user.deleted",
    data: { id: userId, deleted: true, object: "user" },
  });
  await accept(
    setupApp({ context, routes: webhooksClerkRoutes })(
      webhookClerkContract,
    ).post({
      body: JSON.stringify({ type: "user.deleted", data: { id: userId } }),
      extraHeaders: {
        "svix-id": `msg_${randomUUID()}`,
        "svix-timestamp": String(Math.floor(now() / 1000)),
        "svix-signature": "v1,signed-by-clerk",
      },
    }),
    [200],
  );
}

function preview(
  actor: Actor,
  configId: string,
  operation: "convert" | "delete",
) {
  signIn(actor);
  return configs().impactPreview({
    headers,
    params: { configId },
    query: { operation },
  });
}

describe("Cloudflare Access promotion and deletion", () => {
  it("cloudflare-access-promotion-deletion-003 previews report no impact when no hosts are bound", async () => {
    const { admin } = workspace();
    const config = await createConfig(admin, "organization");
    for (const operation of ["convert", "delete"] as const) {
      const result = await accept(preview(admin, config.id, operation), [200]);
      expect(result.body).toMatchObject({
        ownHostCount: 0,
        otherHostCount: 0,
        affectedOwners: [],
      });
    }
  });

  it("cloudflare-access-promotion-deletion-001 only an admin promotes their own personal Access in place and keeps its SSH host", async () => {
    const { admin, member } = workspace();
    const foreignAdmin: Actor = {
      userId: `user_${randomUUID()}`,
      orgId: `org_${randomUUID()}`,
      role: "org:admin",
    };
    const personal = await createConfig(admin, "personal");
    const adminHost = await bindHost(admin, personal.id);
    const memberConfig = await createConfig(member, "personal");
    const promote = (actor: Actor, configId: string, revision: number) => {
      signIn(actor);
      return configs().convertToOrganization({
        headers,
        params: { configId },
        body: { expectedRevision: revision },
      });
    };

    const memberAttempt = await accept(
      promote(member, memberConfig.id, 1),
      [403],
    );
    expect(memberAttempt.body.error.code).toBe("CLOUDFLARE_ACCESS_FORBIDDEN");
    await accept(promote(admin, memberConfig.id, 1), [404]);
    await accept(promote(foreignAdmin, personal.id, 1), [404]);
    await accept(promote(admin, personal.id, 2), [409]);

    const promoted = await accept(promote(admin, personal.id, 1), [200]);
    expect(promoted.body).toMatchObject({
      id: personal.id,
      scope: "organization",
      revision: 2,
      generation: 2,
      sshHosts: [{ id: adminHost.id }],
    });
    expect(promoted.body.sshHosts).toHaveLength(1);
    expect(JSON.stringify(promoted.body)).not.toContain("secret-");
    const [hostAfter] = await listHosts(admin);
    expect(hostAfter).toMatchObject({
      id: adminHost.id,
      username: adminHost.username,
      port: adminHost.port,
      generation: adminHost.generation + 1,
      transport: { type: "cloudflare_access", configId: personal.id },
    });

    const seen = (await listConfigs(member)).find(({ id }) => {
      return id === personal.id;
    });
    expect(seen).toMatchObject({ scope: "organization", sshHosts: [] });
    const memberHost = await bindHost(member, personal.id);

    await deleteClerkUser(admin.userId);
    const afterErasure = (await listConfigs(member)).find(({ id }) => {
      return id === personal.id;
    });
    expect(afterErasure?.scope).toBe("organization");
    const [memberHostAfter] = await listHosts(member);
    expect(memberHostAfter).toMatchObject({
      id: memberHost.id,
      transport: { type: "cloudflare_access", configId: personal.id },
    });
  });

  it("cloudflare-access-promotion-deletion-002 impact previews name owners and totals without per-owner host details", async () => {
    const { admin, member: firstMember } = workspace();
    const secondMember: Actor = {
      ...firstMember,
      userId: `user_${randomUUID()}`,
    };
    mockClerkUsers(context, [
      {
        id: firstMember.userId,
        firstName: "First",
        lastName: "Member",
        imageUrl: "",
        emailAddresses: [],
        primaryEmailAddressId: null,
      },
      {
        id: secondMember.userId,
        firstName: null,
        lastName: null,
        imageUrl: "",
        emailAddresses: [],
        primaryEmailAddressId: null,
      },
    ]);
    const config = await createConfig(admin, "organization");
    await bindHost(admin, config.id);
    signIn(firstMember);
    const firstHosts = await Promise.all([
      bindHost(firstMember, config.id),
      bindHost(firstMember, config.id),
    ]);
    const secondHost = await bindHost(secondMember, config.id);

    for (const operation of ["convert", "delete"] as const) {
      await accept(preview(firstMember, config.id, operation), [403]);
    }
    const [convert, remove] = await Promise.all([
      accept(preview(admin, config.id, "convert"), [200]),
      accept(preview(admin, config.id, "delete"), [200]),
    ]);
    for (const result of [convert, remove]) {
      expect(result.body).toMatchObject({
        expectedRevision: 1,
        ownHostCount: 1,
        otherHostCount: 3,
      });
      expect(result.body.affectedOwners).toHaveLength(2);
      expect(result.body.affectedOwners).toStrictEqual(
        expect.arrayContaining([
          { userId: firstMember.userId, displayName: "First Member" },
          { userId: secondMember.userId, displayName: null },
        ]),
      );
      const serialized = JSON.stringify(result.body);
      for (const host of [...firstHosts, secondHost]) {
        expect(serialized).not.toContain(host.id);
        expect(serialized).not.toContain(host.displayName);
      }
    }
    expect(remove.body.impactSnapshot).toBe(convert.body.impactSnapshot);
  });

  it("cloudflare-access-promotion-deletion-004 deleting shared Access needs a fresh reviewed impact and asks members to rebind", async () => {
    const { admin, member: firstMember } = workspace();
    const secondMember: Actor = {
      ...firstMember,
      userId: `user_${randomUUID()}`,
    };
    const config = await createConfig(admin, "organization");
    signIn(firstMember);
    const firstHosts = await Promise.all([
      bindHost(firstMember, config.id),
      bindHost(firstMember, config.id),
    ]);
    const secondHost = await bindHost(secondMember, config.id);

    await accept(preview(firstMember, config.id, "delete"), [403]);
    const reviewed = await accept(preview(admin, config.id, "delete"), [200]);
    expect(reviewed.body).toMatchObject({
      expectedRevision: 1,
      ownHostCount: 0,
      otherHostCount: 3,
    });
    expect(reviewed.body.affectedOwners).toHaveLength(2);
    const remove = (body: {
      expectedRevision: number;
      impactSnapshot?: string;
    }) => {
      signIn(admin);
      return configs().delete({
        headers,
        params: { configId: config.id },
        body,
      });
    };

    const unreviewed = await accept(remove({ expectedRevision: 1 }), [409]);
    expect(unreviewed.body.error.code).toBe(
      "CLOUDFLARE_ACCESS_IMPACT_CONFLICT",
    );
    const lateHost = await bindHost(firstMember, config.id);
    await accept(
      remove({
        expectedRevision: 1,
        impactSnapshot: reviewed.body.impactSnapshot,
      }),
      [409],
    );
    const refreshed = await accept(preview(admin, config.id, "delete"), [200]);
    expect(refreshed.body.otherHostCount).toBe(4);
    expect(refreshed.body.impactSnapshot).not.toBe(
      reviewed.body.impactSnapshot,
    );
    await accept(
      configs().update({
        headers,
        params: { configId: config.id },
        query: { view: "scoped" },
        body: { expectedRevision: 1, name: "Renamed Access" },
      }),
      [200],
    );
    const staleRevision = await accept(
      remove({
        expectedRevision: refreshed.body.expectedRevision,
        impactSnapshot: refreshed.body.impactSnapshot,
      }),
      [409],
    );
    expect(staleRevision.body.error.code).toBe(
      "CLOUDFLARE_ACCESS_REVISION_CONFLICT",
    );

    const final = await accept(preview(admin, config.id, "delete"), [200]);
    expect(final.body.expectedRevision).toBe(2);
    const deletedAt = new Date("2026-04-05T06:07:08.000Z");
    mockNow(deletedAt);
    await accept(
      remove({
        expectedRevision: final.body.expectedRevision,
        impactSnapshot: final.body.impactSnapshot,
      }),
      [204],
    );
    await expect(listConfigs(admin)).resolves.toStrictEqual([]);
    for (const [owner, before] of [
      [firstMember, [...firstHosts, lateHost]],
      [secondMember, [secondHost]],
    ] as const) {
      const after = await listHosts(owner);
      expect(after).toHaveLength(before.length);
      for (const host of before) {
        expect(
          after.find(({ id }) => {
            return id === host.id;
          }),
        ).toMatchObject({
          username: host.username,
          generation: host.generation + 1,
          updatedAt: deletedAt.toISOString(),
          transport: { type: "cloudflare_access", needsRebind: true },
        });
      }
    }
  });

  it("cloudflare-access-promotion-deletion-008 an admin demoted after reviewing cannot delete another member's binding", async () => {
    const { admin, member } = workspace();
    const config = await createConfig(admin, "organization");
    const memberHost = await bindHost(member, config.id);
    const reviewed = await accept(preview(admin, config.id, "delete"), [200]);

    signIn({ ...admin, role: "org:member" });
    const demoted = await accept(
      configs().delete({
        headers,
        params: { configId: config.id },
        body: {
          expectedRevision: reviewed.body.expectedRevision,
          impactSnapshot: reviewed.body.impactSnapshot,
        },
      }),
      [403],
    );
    expect(demoted.body.error.code).toBe("CLOUDFLARE_ACCESS_FORBIDDEN");
    const [hostAfter] = await listHosts(member);
    expect(hostAfter).toMatchObject({
      id: memberHost.id,
      transport: { type: "cloudflare_access", configId: config.id },
    });
  });

  it("cloudflare-access-promotion-deletion-012 the admin's own bound host blocks deletion even after review", async () => {
    const { admin, member } = workspace();
    const config = await createConfig(admin, "organization");
    const adminHost = await bindHost(admin, config.id);
    const memberHost = await bindHost(member, config.id);

    await accept(preview(member, config.id, "delete"), [403]);
    const reviewed = await accept(preview(admin, config.id, "delete"), [200]);
    expect(reviewed.body.ownHostCount).toBe(1);
    signIn(admin);
    const blocked = await accept(
      configs().delete({
        headers,
        params: { configId: config.id },
        body: {
          expectedRevision: 1,
          impactSnapshot: reviewed.body.impactSnapshot,
        },
      }),
      [409],
    );
    expect(blocked.body.error.code).toBe("CLOUDFLARE_ACCESS_IN_USE");
    for (const [owner, host] of [
      [member, memberHost],
      [admin, adminHost],
    ] as const) {
      const [after] = await listHosts(owner);
      expect(after).toMatchObject({
        id: host.id,
        transport: { type: "cloudflare_access", configId: config.id },
      });
    }
  });
});
