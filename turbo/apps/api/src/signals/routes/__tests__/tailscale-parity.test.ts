import { randomUUID } from "node:crypto";
import { sshConnectionsContract } from "@okouai/api-contracts/contracts/ssh-connections";
import { sshCredentialsContract } from "@okouai/api-contracts/contracts/ssh-credentials";
import { tailscaleContract } from "@okouai/api-contracts/contracts/tailscale";
import { createStore } from "ccstate";
import { describe, expect, it } from "vitest";
import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { sshConnectionsRoutes } from "../ssh-connections";
import { tailscaleRoutes } from "../tailscale";
import { seedOrgMembership$ } from "./helpers/org-membership";
import { createRouteMocks } from "./helpers/route-test";
import { useSecretKmsProbe } from "./helpers/secret-kms-probe";

const context = testContext();
const headers = Object.freeze({ authorization: "Bearer clerk-session" });
const clerkDirectory = createStore();

interface Actor {
  readonly userId: string;
  readonly orgId: string;
  readonly role: "admin" | "member";
}

async function createMember(
  options: {
    readonly userId?: string;
    readonly orgId?: string;
    readonly role?: "admin" | "member";
  } = {},
): Promise<Actor> {
  const actor: Actor = {
    userId: options.userId ?? `user_${randomUUID()}`,
    orgId: options.orgId ?? `org_${randomUUID()}`,
    role: options.role ?? "member",
  };
  await clerkDirectory.set(seedOrgMembership$, actor, context.signal);
  return actor;
}

function signIn(actor: Actor): void {
  createRouteMocks(context).clerk.session(
    actor.userId,
    actor.orgId,
    actor.role === "admin" ? "org:admin" : "org:member",
  );
}

const hosts = () => {
  return setupApp({ context, routes: sshConnectionsRoutes })(
    sshConnectionsContract,
  );
};
const logins = () => {
  return setupApp({ context, routes: sshConnectionsRoutes })(
    sshCredentialsContract,
  );
};
const tailscale = () => {
  return setupApp({ context, routes: tailscaleRoutes })(tailscaleContract);
};

function inlineLogin() {
  return {
    create: {
      name: `Login ${randomUUID().slice(0, 8)}`,
      username: "deploy",
      authentication: {
        method: "password" as const,
        password: `pw-${randomUUID()}`,
      },
    },
  };
}

async function createConfig(
  options: { readonly scope?: "personal" | "organization" } = {},
) {
  const id = randomUUID();
  return (
    await accept(
      tailscale().create({
        headers,
        body: {
          id,
          name: `Tailnet ${id.slice(0, 8)}`,
          credentials: {
            clientId: `client-${randomUUID()}`,
            clientSecret: `secret-${randomUUID()}`,
          },
          tags: ["tag:okou"],
          ...(options.scope ? { scope: options.scope } : {}),
        },
      }),
      [201],
    )
  ).body;
}

async function createTailscaleHost(configId: string, host = "100.64.0.10") {
  return (
    await accept(
      hosts().create({
        headers,
        body: {
          id: randomUUID(),
          displayName: `Host ${randomUUID().slice(0, 8)}`,
          host,
          port: 22,
          credential: inlineLogin(),
          transport: { type: "tailscale", configId },
        },
      }),
      [201],
    )
  ).body;
}

describe("Tailscale configuration parity", () => {
  it("tailscale-parity-003 allows another current admin to adopt shared configuration but hides the resulting Personal configuration from its former creator", async () => {
    const creator = await createMember({ role: "admin" });
    const secondAdmin = await createMember({
      orgId: creator.orgId,
      role: "admin",
    });

    signIn(creator);
    const shared = await createConfig({ scope: "organization" });
    const creatorHost = await createTailscaleHost(shared.id, "100.64.0.11");

    signIn(secondAdmin);
    const secondAdminHost = await createTailscaleHost(shared.id, "100.64.0.12");

    const preview = await accept(
      tailscale().impactPreview({
        headers,
        params: { configId: shared.id },
        query: { operation: "convert" },
      }),
      [200],
    );
    const converted = await accept(
      tailscale().convertToPersonal({
        headers,
        params: { configId: shared.id },
        body: {
          expectedRevision: shared.revision,
          impactSnapshot: preview.body.impactSnapshot,
        },
      }),
      [200],
    );
    expect(converted.body.scope).toBe("personal");
    expect(converted.body.revision).toBe(2);

    const secondAdminHosts = await accept(hosts().list({ headers }), [200]);
    expect(secondAdminHosts.body.connections).toStrictEqual([
      expect.objectContaining({
        id: secondAdminHost.id,
        generation: secondAdminHost.generation + 1,
        transport: { type: "tailscale", configId: shared.id },
      }),
    ]);

    signIn(creator);
    const creatorConfigs = await accept(tailscale().list({ headers }), [200]);
    expect(creatorConfigs.body.configs).toStrictEqual([]);

    const creatorHosts = await accept(hosts().list({ headers }), [200]);
    expect(creatorHosts.body.connections).toStrictEqual([
      expect.objectContaining({
        id: creatorHost.id,
        transport: { type: "tailscale", needsRebind: true },
      }),
    ]);

    await accept(
      tailscale().convertToOrganization({
        headers,
        params: { configId: shared.id },
        body: { expectedRevision: 2 },
      }),
      [404],
    );

    signIn(secondAdmin);
    const promoted = await accept(
      tailscale().convertToOrganization({
        headers,
        params: { configId: shared.id },
        body: { expectedRevision: 2 },
      }),
      [200],
    );
    expect(promoted.body.scope).toBe("organization");
  });

  it("tailscale-parity-007 rejects invisible tailscale host-update configuration before login encryption even when KMS fails", async () => {
    const actor = await createMember();
    const peer = await createMember({ orgId: actor.orgId });
    const otherOrgActor = await createMember({ userId: actor.userId });

    signIn(peer);
    const peerConfig = await createConfig();

    signIn(otherOrgActor);
    const otherOrgConfig = await createConfig();

    signIn(actor);
    const ownConfig = await createConfig();
    const host = (
      await accept(
        hosts().create({
          headers,
          body: {
            id: randomUUID(),
            displayName: "Direct peer",
            host: "peer.example.com",
            port: 443,
            credential: inlineLogin(),
          },
        }),
        [201],
      )
    ).body;
    const beforeHosts = (await accept(hosts().list({ headers }), [200])).body
      .connections;
    const beforeLogins = (await accept(logins().list({ headers }), [200])).body
      .credentials;

    const kms = useSecretKmsProbe(() => {
      return Promise.reject(new Error("KMS unavailable"));
    });

    const invisibleConfigIds = [randomUUID(), peerConfig.id, otherOrgConfig.id];
    for (const configId of invisibleConfigIds) {
      const response = await accept(
        hosts().update({
          headers,
          params: { connectionId: host.id },
          body: {
            expectedGeneration: host.generation,
            transport: { type: "tailscale", configId },
            credential: inlineLogin(),
          },
        }),
        [404],
      );
      expect(response.body).toMatchObject({
        error: { code: "TAILSCALE_NOT_FOUND" },
      });
    }

    expect(kms.generateDataKeyCalls).toBe(0);
    await expect(
      accept(hosts().list({ headers }), [200]).then((response) => {
        return response.body.connections;
      }),
    ).resolves.toStrictEqual(beforeHosts);
    await expect(
      accept(logins().list({ headers }), [200]).then((response) => {
        return response.body.credentials;
      }),
    ).resolves.toStrictEqual(beforeLogins);

    await accept(
      hosts().update({
        headers,
        params: { connectionId: host.id },
        body: {
          expectedGeneration: host.generation,
          transport: { type: "tailscale", configId: ownConfig.id },
          credential: inlineLogin(),
        },
      }),
      [500],
    );

    expect(kms.generateDataKeyCalls).toBe(1);
    await expect(
      accept(hosts().list({ headers }), [200]).then((response) => {
        return response.body.connections;
      }),
    ).resolves.toStrictEqual(beforeHosts);
    await expect(
      accept(logins().list({ headers }), [200]).then((response) => {
        return response.body.credentials;
      }),
    ).resolves.toStrictEqual(beforeLogins);
  });
});
