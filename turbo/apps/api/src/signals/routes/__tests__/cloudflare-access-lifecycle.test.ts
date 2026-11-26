import { randomUUID } from "node:crypto";

import { cloudflareAccessContract } from "@okouai/api-contracts/contracts/cloudflare-access";
import { sshConnectionsContract } from "@okouai/api-contracts/contracts/ssh-connections";
import { webhookClerkContract } from "@okouai/api-contracts/contracts/webhooks";
import { describe, expect, it } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { cloudflareAccessRoutes } from "../cloudflare-access";
import { sshConnectionsRoutes } from "../ssh-connections";
import { webhooksClerkRoutes } from "../webhooks-clerk";
import { createRouteMocks } from "./helpers/route-test";
import { inlineSshKey } from "./helpers/ssh-credential";
import { now } from "../../../lib/time";

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

describe("Cloudflare Access lifecycle", () => {
  it("cloudflare-access-lifecycle-005 conversion needs a fresh preview after a new binding or a rename", async () => {
    const { admin, member } = workspace();
    const config = await createConfig(admin, "organization");
    signIn(admin);
    const stale = await accept(
      configs().impactPreview({
        headers,
        params: { configId: config.id },
        query: { operation: "convert" },
      }),
      [200],
    );
    const memberHost = await bindHost(member, config.id);

    signIn(admin);
    const impactConflict = await accept(
      configs().convertToPersonal({
        headers,
        params: { configId: config.id },
        body: {
          expectedRevision: stale.body.expectedRevision,
          impactSnapshot: stale.body.impactSnapshot,
        },
      }),
      [409],
    );
    expect(impactConflict.body.error.code).toBe(
      "CLOUDFLARE_ACCESS_IMPACT_CONFLICT",
    );
    const fresh = await accept(
      configs().impactPreview({
        headers,
        params: { configId: config.id },
        query: { operation: "convert" },
      }),
      [200],
    );
    expect(fresh.body.otherHostCount).toBe(1);
    expect(fresh.body.impactSnapshot).not.toBe(stale.body.impactSnapshot);
    await accept(
      configs().update({
        headers,
        params: { configId: config.id },
        query: { view: "scoped" },
        body: { expectedRevision: config.revision, name: "Renamed Access" },
      }),
      [200],
    );
    const revisionConflict = await accept(
      configs().convertToPersonal({
        headers,
        params: { configId: config.id },
        body: {
          expectedRevision: fresh.body.expectedRevision,
          impactSnapshot: fresh.body.impactSnapshot,
        },
      }),
      [409],
    );
    expect(revisionConflict.body.error.code).toBe(
      "CLOUDFLARE_ACCESS_REVISION_CONFLICT",
    );

    const [hostAfter] = await listHosts(member);
    expect(hostAfter).toMatchObject({
      id: memberHost.id,
      transport: { type: "cloudflare_access", configId: config.id },
    });
  });

  it("cloudflare-access-lifecycle-001 erasing the creator removes private Access but keeps shared Access and a member's host", async () => {
    const { admin: creator, member } = workspace();
    const shared = await createConfig(creator, "organization");
    const personal = await createConfig(creator, "personal");
    await bindHost(creator, personal.id);
    const memberHost = await bindHost(member, shared.id);

    await deleteClerkUser(creator.userId);

    const recreated = await createConfig(member, "personal", personal.id);
    expect(recreated.id).toBe(personal.id);
    const memberConfigs = await listConfigs(member);
    expect(
      memberConfigs.map(({ id, scope, sshHosts }) => {
        return {
          id,
          scope,
          sshHosts: sshHosts.map((host) => {
            return host.id;
          }),
        };
      }),
    ).toStrictEqual(
      expect.arrayContaining([
        { id: shared.id, scope: "organization", sshHosts: [memberHost.id] },
        { id: personal.id, scope: "personal", sshHosts: [] },
      ]),
    );
    expect(memberConfigs).toHaveLength(2);
    const memberHosts = await listHosts(member);
    expect(
      memberHosts.map(({ id }) => {
        return id;
      }),
    ).toStrictEqual([memberHost.id]);
  });

  it("cloudflare-access-lifecycle-004 converting shared Access to personal keeps the admin's host and asks members to rebind", async () => {
    const { admin, member } = workspace();
    const secondMember: Actor = { ...member, userId: `user_${randomUUID()}` };
    const config = await createConfig(admin, "organization");
    const adminHost = await bindHost(admin, config.id);
    const memberHost = await bindHost(member, config.id);
    const secondHost = await bindHost(secondMember, config.id);

    signIn(member);
    const memberPreview = await accept(
      configs().impactPreview({
        headers,
        params: { configId: config.id },
        query: { operation: "convert" },
      }),
      [403],
    );
    expect(memberPreview.body.error.code).toBe("CLOUDFLARE_ACCESS_FORBIDDEN");

    signIn(admin);
    const preview = await accept(
      configs().impactPreview({
        headers,
        params: { configId: config.id },
        query: { operation: "convert" },
      }),
      [200],
    );
    expect(preview.body.expectedRevision).toBe(1);
    expect(preview.body.otherHostCount).toBe(2);
    expect(preview.body.impactSnapshot).toMatch(/^[a-f0-9]{64}$/u);
    expect(
      [...preview.body.affectedOwners].sort((a, b) => {
        return a.userId.localeCompare(b.userId);
      }),
    ).toStrictEqual(
      [member.userId, secondMember.userId].sort().map((userId) => {
        return { userId, displayName: null };
      }),
    );
    expect(JSON.stringify(preview.body)).not.toContain(memberHost.id);

    signIn(member);
    const memberConvert = await accept(
      configs().convertToPersonal({
        headers,
        params: { configId: config.id },
        body: {
          expectedRevision: preview.body.expectedRevision,
          impactSnapshot: preview.body.impactSnapshot,
        },
      }),
      [403],
    );
    expect(memberConvert.body.error.code).toBe("CLOUDFLARE_ACCESS_FORBIDDEN");

    signIn(admin);
    const converted = await accept(
      configs().convertToPersonal({
        headers,
        params: { configId: config.id },
        body: {
          expectedRevision: preview.body.expectedRevision,
          impactSnapshot: preview.body.impactSnapshot,
        },
      }),
      [200],
    );
    expect(converted.body).toMatchObject({
      scope: "personal",
      revision: 2,
      generation: 2,
      sshHosts: [{ id: adminHost.id }],
    });
    expect(converted.body.sshHosts).toHaveLength(1);
    expect(converted.body).not.toHaveProperty("credentials");
    expect(JSON.stringify(converted.body)).not.toContain("secret-");

    const [adminAfter] = await listHosts(admin);
    expect(adminAfter).toMatchObject({
      id: adminHost.id,
      generation: adminHost.generation + 1,
      transport: { type: "cloudflare_access", configId: config.id },
    });
    for (const [owner, host] of [
      [member, memberHost],
      [secondMember, secondHost],
    ] as const) {
      const [[after], ownerConfigs] = await Promise.all([
        listHosts(owner),
        listConfigs(owner),
      ]);
      expect(after).toMatchObject({
        id: host.id,
        generation: host.generation + 1,
        transport: { type: "cloudflare_access", needsRebind: true },
      });
      expect(
        after && "transport" in after ? after.transport : undefined,
      ).not.toHaveProperty("configId");
      expect(ownerConfigs).toStrictEqual([]);
    }

    await deleteClerkUser(admin.userId);
    const remaining = await listHosts(member);
    expect(
      remaining.map(({ id }) => {
        return id;
      }),
    ).toStrictEqual([memberHost.id]);
  });
});
