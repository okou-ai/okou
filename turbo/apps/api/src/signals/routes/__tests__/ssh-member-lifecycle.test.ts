import { randomUUID } from "node:crypto";

import { cloudflareAccessContract } from "@okouai/api-contracts/contracts/cloudflare-access";
import {
  sshConnectionsContract,
  type CreateSshConnectionRequest,
} from "@okouai/api-contracts/contracts/ssh-connections";
import { sshCredentialsContract } from "@okouai/api-contracts/contracts/ssh-credentials";
import { tailscaleContract } from "@okouai/api-contracts/contracts/tailscale";
import { vncConnectionsContract } from "@okouai/api-contracts/contracts/vnc-connections";
import { vncCredentialsContract } from "@okouai/api-contracts/contracts/vnc-credentials";
import { webhookClerkContract } from "@okouai/api-contracts/contracts/webhooks";
import { createStore } from "ccstate";
import { Webhook } from "svix";
import { expect, test } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { mockOptionalEnv } from "../../../lib/env";
import { nowDate } from "../../../lib/time";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { cloudflareAccessRoutes } from "../cloudflare-access";
import { sshConnectionsRoutes } from "../ssh-connections";
import { tailscaleRoutes } from "../tailscale";
import { vncConnectionsRoutes } from "../vnc-connections";
import { webhooksClerkRoutes } from "../webhooks-clerk";
import { createAuthOrgAgentsBddApi } from "./helpers/api-bdd-auth-org";
import {
  deleteOrgMembership$,
  seedOrgMembership$,
} from "./helpers/org-membership";
import { createRouteMocks } from "./helpers/route-test";
import { useSecretKmsProbe } from "./helpers/secret-kms-probe";

const context = testContext();
const store = createStore();
const mocks = createRouteMocks(context);
const org = createAuthOrgAgentsBddApi(context);
const headers = Object.freeze({ authorization: "Bearer clerk-session" });

function connections() {
  return setupApp({ context, routes: sshConnectionsRoutes })(
    sshConnectionsContract,
  );
}
function credentials() {
  return setupApp({ context, routes: sshConnectionsRoutes })(
    sshCredentialsContract,
  );
}
function desktops() {
  return setupApp({ context, routes: vncConnectionsRoutes })(
    vncConnectionsContract,
  );
}
function desktopCredentials() {
  return setupApp({ context, routes: vncConnectionsRoutes })(
    vncCredentialsContract,
  );
}
function access() {
  return setupApp({ context, routes: cloudflareAccessRoutes })(
    cloudflareAccessContract,
  );
}
function tailscale() {
  return setupApp({ context, routes: tailscaleRoutes })(tailscaleContract);
}

async function owner(
  overrides: {
    orgId?: string;
    userId?: string;
    orgRole?: "org:admin" | "org:member";
  } = {},
) {
  const actor = org.user(overrides);
  if (!actor.orgId) {
    throw new Error("Expected an organization-scoped actor");
  }
  const value = {
    ...actor,
    orgId: actor.orgId,
    membershipId: `orgmem_${randomUUID()}`,
  };
  await store.set(
    seedOrgMembership$,
    { ...value, role: actor.orgRole === "org:admin" ? "admin" : "member" },
    context.signal,
  );
  mocks.clerk.session(value.userId, value.orgId, value.orgRole);
  mocks.s3.listObjects([]);
  return value;
}

async function createCredential(name = "Login", id: string = randomUUID()) {
  return (
    await accept(
      credentials().create({
        headers,
        body: {
          id,
          name,
          username: "deploy",
          authentication: { method: "password", password: "synthetic-login" },
        },
      }),
      [201],
    )
  ).body;
}

async function createHost(
  credentialId: string,
  transport?: Exclude<
    CreateSshConnectionRequest["transport"],
    { type: "tailscale_ssh" }
  >,
  id: string = randomUUID(),
) {
  return (
    await accept(
      connections().create({
        headers,
        body: {
          id,
          displayName: "Managed host",
          host: "ssh.example.com",
          port: transport?.type === "cloudflare_access" ? 443 : 22,
          credential: { id: credentialId },
          transport,
        },
      }),
      [201],
    )
  ).body;
}

async function membershipWebhook(actor: {
  orgId: string;
  userId: string;
  membershipId: string;
}) {
  const secret = `whsec_${Buffer.from("ssh-member-lifecycle-signing-key").toString("base64")}`;
  mockOptionalEnv("CLERK_WEBHOOK_SIGNING_SECRET", secret);
  context.mocks.clerk.verifyWebhook.mockImplementation(async (request) => {
    if (!(request instanceof Request)) {
      throw new Error("Expected the Clerk webhook request");
    }
    const payload = await request.text();
    new Webhook(secret).verify(payload, Object.fromEntries(request.headers));
    const verified: unknown = JSON.parse(payload);
    return verified;
  });
  const body = JSON.stringify({
    type: "organizationMembership.deleted",
    data: {
      id: actor.membershipId,
      organization_id: actor.orgId,
      user_id: actor.userId,
    },
  });
  const id = `msg_${randomUUID()}`;
  const timestamp = nowDate();
  await accept(
    setupApp({ context, routes: webhooksClerkRoutes })(
      webhookClerkContract,
    ).post({
      body,
      extraHeaders: {
        "svix-id": id,
        "svix-timestamp": Math.floor(timestamp.getTime() / 1000).toString(),
        "svix-signature": new Webhook(secret).sign(id, timestamp, body),
      },
    }),
    [200],
  );
  await flushWaitUntilForTest();
}

test.each(["self-leave", "administrator", "Clerk webhook"] as const)(
  "%s erases the departing member's private remote resources after VNC dependencies",
  async (entry) => {
    useSecretKmsProbe();
    const departing = await owner({ orgRole: "org:member" });
    const login = await createCredential();
    const unused = await createCredential("Unused login");
    const personalAccess = (
      await accept(
        access().create({
          headers,
          body: {
            id: randomUUID(),
            scope: "personal",
            name: "Independent personal gateway",
            credentials: {
              clientId: "personal-id",
              clientSecret: "personal-secret",
            },
          },
        }),
        [201],
      )
    ).body;
    const personalTailscale = (
      await accept(
        tailscale().create({
          headers,
          body: {
            id: randomUUID(),
            scope: "personal",
            name: "Departing private network",
            credentials: {
              clientId: "private-id",
              clientSecret: "private-secret",
            },
            tags: ["tag:okou"],
          },
        }),
        [201],
      )
    ).body;
    const rfbHost = await createHost(login.id, {
      type: "cloudflare_access",
      configId: personalAccess.id,
    });
    const kdcHost = await createHost(login.id);
    const desktop = (
      await accept(
        desktops().create({
          headers,
          body: {
            id: randomUUID(),
            displayName: "SSH RFB and KDC dependencies",
            host: "127.0.0.1",
            credential: {
              create: {
                name: "Kerberos login",
                authentication: {
                  method: "qemu_kerberos_password",
                  initiator: {
                    realm: "EXAMPLE.INVALID",
                    components: ["alice"],
                  },
                  password: "synthetic-kerberos-login",
                },
              },
            },
            transport: { type: "ssh", connectionId: rfbHost.id },
            security: {
              type: "qemu_x509_gssapi",
              trust: { mode: "system" },
              service: {
                realm: "EXAMPLE.INVALID",
                components: ["vnc", "desktop.example.com"],
              },
              kdc: {
                host: "127.0.0.1",
                port: 88,
                transport: { type: "ssh", connectionId: kdcHost.id },
              },
            },
          },
        }),
        [201],
      )
    ).body;
    const peer = await owner({ orgId: departing.orgId });
    const sharedAccess = (
      await accept(
        access().create({
          headers,
          body: {
            id: randomUUID(),
            scope: "organization",
            name: "Shared gateway",
            credentials: {
              clientId: "shared-id",
              clientSecret: "shared-secret",
            },
          },
        }),
        [201],
      )
    ).body;
    const sharedTailscale = (
      await accept(
        tailscale().create({
          headers,
          body: {
            id: randomUUID(),
            scope: "organization",
            name: "Shared network",
            credentials: {
              clientId: "shared-tail-id",
              clientSecret: "shared-tail-secret",
            },
            tags: ["tag:okou"],
          },
        }),
        [201],
      )
    ).body;
    const peerLogin = await createCredential("Surviving member login");
    const peerAccessHost = await createHost(peerLogin.id, {
      type: "cloudflare_access",
      configId: sharedAccess.id,
    });
    const peerTailHost = await createHost(peerLogin.id, {
      type: "tailscale",
      configId: sharedTailscale.id,
    });
    mocks.clerk.session(departing.userId, departing.orgId, departing.orgRole);
    const sharedHosts = [
      await createHost(login.id, {
        type: "cloudflare_access",
        configId: sharedAccess.id,
      }),
      await createHost(login.id, {
        type: "tailscale",
        configId: sharedTailscale.id,
      }),
    ];
    const elsewhere = await owner({ userId: departing.userId });
    const elsewhereLogin = await createCredential("Other organization login");
    const elsewhereHost = await createHost(elsewhereLogin.id);

    org.mockClerkUsers([departing, peer]);
    context.mocks.clerk.organizations.deleteOrganizationMembership.mockImplementation(
      async () => {
        await store.set(deleteOrgMembership$, departing, context.signal);
        return {};
      },
    );
    if (entry === "self-leave") {
      await expect(org.leaveOrg(departing)).resolves.toStrictEqual({
        message: "Left org",
      });
    } else if (entry === "administrator") {
      await expect(
        org.removeMember(peer, { email: departing.email }),
      ).resolves.toStrictEqual({
        message: `Removed ${departing.email} from org`,
      });
    } else {
      await store.set(deleteOrgMembership$, departing, context.signal);
      await membershipWebhook(departing);
    }
    // A surviving member reuses caller-known IDs before later Clerk delivery:
    // each entry point must have erased them, not just made them invisible.
    mocks.clerk.session(peer.userId, peer.orgId, peer.orgRole);
    const reclaimedCredential = await createCredential(
      "Recreated after departure",
      unused.id,
    );
    const reclaimedHost = await createHost(
      reclaimedCredential.id,
      undefined,
      rfbHost.id,
    );
    // The app path is also followed by Clerk delivery; neither may resurrect or
    // erase another member's replacement resources on repeated delivery.
    await membershipWebhook(departing);
    await membershipWebhook(departing);
    await store.set(
      seedOrgMembership$,
      { ...departing, membershipId: `orgmem_${randomUUID()}` },
      context.signal,
    );
    mocks.clerk.session(departing.userId, departing.orgId, departing.orgRole);
    expect(
      (await accept(connections().list({ headers }), [200])).body.connections,
    ).toStrictEqual([]);
    expect(
      (await accept(credentials().list({ headers }), [200])).body.credentials,
    ).toStrictEqual([]);
    expect(
      (await accept(desktops().list({ headers }), [200])).body.connections,
    ).toStrictEqual([]);
    expect(
      (await accept(desktopCredentials().list({ headers }), [200])).body
        .credentials,
    ).toStrictEqual([]);
    for (const host of [rfbHost, kdcHost, ...sharedHosts]) {
      await accept(
        connections().update({
          headers,
          params: { connectionId: host.id },
          body: { expectedGeneration: 1, displayName: "Rejoined host" },
        }),
        [404],
      );
    }
    for (const credential of [login, unused]) {
      await accept(
        credentials().update({
          headers,
          params: { credentialId: credential.id },
          body: { expectedRevision: 1, name: "Rejoined login" },
        }),
        [404],
      );
    }
    await accept(
      desktops().update({
        headers,
        params: { connectionId: desktop.id },
        body: { expectedGeneration: 1, displayName: "Rejoined desktop" },
      }),
      [404],
    );
    expect(
      (
        await accept(
          access().list({ headers, query: { view: "scoped" } }),
          [200],
        )
      ).body.configs,
    ).not.toContainEqual(expect.objectContaining({ id: personalAccess.id }));
    expect(
      (await accept(tailscale().list({ headers }), [200])).body.configs,
    ).not.toContainEqual(expect.objectContaining({ id: personalTailscale.id }));
    // Rejoining is a real surviving caller. Recreate the caller-known private
    // identities and verify their old Host references cannot reappear.
    expect(
      (
        await accept(
          access().create({
            headers,
            body: {
              id: personalAccess.id,
              scope: "personal",
              name: "Rejoined gateway",
              credentials: {
                clientId: "rejoined-id",
                clientSecret: "rejoined-secret",
              },
            },
          }),
          [201],
        )
      ).body.sshHosts,
    ).toStrictEqual([]);
    expect(
      (
        await accept(
          tailscale().create({
            headers,
            body: {
              id: personalTailscale.id,
              scope: "personal",
              name: "Rejoined network",
              credentials: {
                clientId: "rejoined-id",
                clientSecret: "rejoined-secret",
              },
              tags: ["tag:okou"],
            },
          }),
          [201],
        )
      ).body.sshHosts,
    ).toStrictEqual([]);

    mocks.clerk.session(peer.userId, peer.orgId, peer.orgRole);
    const survivingHosts = (
      await accept(connections().list({ headers }), [200])
    ).body.connections;
    expect(survivingHosts).toHaveLength(3);
    expect(survivingHosts).toStrictEqual(
      expect.arrayContaining([peerAccessHost, peerTailHost, reclaimedHost]),
    );
    expect(
      (await accept(credentials().list({ headers }), [200])).body.credentials,
    ).toStrictEqual([
      {
        ...peerLogin,
        hosts: [peerAccessHost, peerTailHost]
          .map(({ id, displayName }) => {
            return { id, displayName };
          })
          .sort((a, b) => {
            return a.id.localeCompare(b.id);
          }),
      },
      {
        ...reclaimedCredential,
        hosts: [
          { id: reclaimedHost.id, displayName: reclaimedHost.displayName },
        ],
      },
    ]);
    expect(
      (
        await accept(
          access().list({ headers, query: { view: "scoped" } }),
          [200],
        )
      ).body.configs,
    ).toStrictEqual([
      {
        ...sharedAccess,
        sshHosts: [
          { id: peerAccessHost.id, displayName: peerAccessHost.displayName },
        ],
      },
    ]);
    expect(
      (await accept(tailscale().list({ headers }), [200])).body.configs,
    ).toStrictEqual([
      {
        ...sharedTailscale,
        sshHosts: [
          { id: peerTailHost.id, displayName: peerTailHost.displayName },
        ],
      },
    ]);
    mocks.clerk.session(elsewhere.userId, elsewhere.orgId, elsewhere.orgRole);
    expect(
      (await accept(connections().list({ headers }), [200])).body.connections,
    ).toStrictEqual([elsewhereHost]);
    expect(
      (await accept(credentials().list({ headers }), [200])).body.credentials,
    ).toStrictEqual([
      {
        ...elsewhereLogin,
        hosts: [
          { id: elsewhereHost.id, displayName: elsewhereHost.displayName },
        ],
      },
    ]);
  },
);

test.each(["unused credentials", "empty"] as const)(
  "membership deletion and replay safely erase an owner with %s",
  async (scenario) => {
    useSecretKmsProbe();
    const departing = await owner();
    if (scenario === "unused credentials") {
      await createCredential("Never attached");
    }
    await store.set(deleteOrgMembership$, departing, context.signal);
    await membershipWebhook(departing);
    await membershipWebhook(departing);
    await store.set(
      seedOrgMembership$,
      { ...departing, membershipId: `orgmem_${randomUUID()}` },
      context.signal,
    );
    mocks.clerk.session(departing.userId, departing.orgId, departing.orgRole);
    expect(
      (await accept(connections().list({ headers }), [200])).body.connections,
    ).toStrictEqual([]);
    expect(
      (await accept(credentials().list({ headers }), [200])).body.credentials,
    ).toStrictEqual([]);
  },
);
