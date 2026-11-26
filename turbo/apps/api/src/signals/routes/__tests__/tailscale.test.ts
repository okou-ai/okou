import { randomUUID } from "node:crypto";
import { sshConnectionsContract } from "@okouai/api-contracts/contracts/ssh-connections";
import { sshCredentialsContract } from "@okouai/api-contracts/contracts/ssh-credentials";
import { tailscaleContract } from "@okouai/api-contracts/contracts/tailscale";
import { createStore } from "ccstate";
import { describe, expect, it } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp, setupRawAppRequest } from "../../../__tests__/test-helpers";
import { sshConnectionsRoutes } from "../ssh-connections";
import { tailscaleRoutes } from "../tailscale";
import { seedOrgMembership$ } from "./helpers/org-membership";
import { createRouteMocks } from "./helpers/route-test";

const context = testContext();
const headers = Object.freeze({ authorization: "Bearer clerk-session" });
const clerkDirectory = createStore();

interface Actor {
  readonly userId: string;
  readonly orgId: string;
  readonly role: "admin" | "member";
}

async function member(
  options: { readonly orgId?: string; readonly role?: "admin" | "member" } = {},
): Promise<Actor> {
  const actor: Actor = {
    userId: `user_${randomUUID()}`,
    orgId: options.orgId ?? `org_${randomUUID()}`,
    role: options.role ?? "member",
  };
  await clerkDirectory.set(seedOrgMembership$, actor, context.signal);
  return actor;
}

function signIn(actor: Actor) {
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

function oauthClient() {
  return {
    clientId: `client-${randomUUID()}`,
    clientSecret: `secret-${randomUUID()}`,
  };
}

function inlineNetwork(credentials = oauthClient()) {
  return {
    name: `Inline tailnet ${randomUUID().slice(0, 8)}`,
    credentials,
    tags: ["tag:okou"],
  };
}

async function createConfig(
  options: {
    readonly id?: string;
    readonly scope?: "personal" | "organization";
  } = {},
) {
  const id = options.id ?? randomUUID();
  return (
    await accept(
      tailscale().create({
        headers,
        body: {
          id,
          name: `Tailnet ${id.slice(0, 8)}`,
          credentials: oauthClient(),
          tags: ["tag:okou"],
          ...(options.scope ? { scope: options.scope } : {}),
        },
      }),
      [201],
    )
  ).body;
}

/** A host bound to a saved network through a newly created inline login. */
async function boundHost(configId: string, host = "100.64.0.10", port = 22) {
  return (
    await accept(
      hosts().create({
        headers,
        body: {
          id: randomUUID(),
          displayName: `Host ${randomUUID().slice(0, 8)}`,
          host,
          port,
          credential: inlineLogin(),
          transport: { type: "tailscale", configId },
        },
      }),
      [201],
    )
  ).body;
}

/** Everything the signed-in member can see about hosts, logins and networks. */
async function inventory() {
  const [hostList, loginList, configList] = await Promise.all([
    accept(hosts().list({ headers }), [200]),
    accept(logins().list({ headers }), [200]),
    accept(tailscale().list({ headers }), [200]),
  ]);
  return {
    hosts: hostList.body.connections,
    logins: loginList.body.credentials,
    configs: configList.body.configs,
  };
}

describe("Tailscale configuration and saved-host authority", () => {
  it("tailscale-009 rejects the non-peer target 10.0.0.1 without saving resources", async () => {
    signIn(await member());
    const before = await inventory();

    await accept(
      hosts().create({
        headers,
        body: {
          id: randomUUID(),
          displayName: "Private address",
          host: "10.0.0.1",
          credential: inlineLogin(),
          transport: { type: "tailscale", create: inlineNetwork() },
        },
      }),
      [400],
    );

    await expect(inventory()).resolves.toStrictEqual(before);
  });

  it("tailscale-018 rejects the non-peer target https://peer without saving resources", async () => {
    signIn(await member());
    const before = await inventory();

    await accept(
      hosts().create({
        headers,
        body: {
          id: randomUUID(),
          displayName: "URL target",
          host: "https://peer",
          credential: inlineLogin(),
          transport: { type: "tailscale", create: inlineNetwork() },
        },
      }),
      [400],
    );

    await expect(inventory()).resolves.toStrictEqual(before);
  });

  it("tailscale-023 keeps the peer.tail-test.ts.net. binding when the host is renamed", async () => {
    signIn(await member());
    const config = await createConfig();
    const host = await boundHost(config.id, "peer.tail-test.ts.net.", 2222);

    const renamed = await accept(
      hosts().update({
        headers,
        params: { connectionId: host.id },
        body: { expectedGeneration: host.generation, displayName: "Renamed" },
      }),
      [200],
    );

    expect(renamed.body).toMatchObject({
      displayName: "Renamed",
      port: 2222,
      transport: { type: "tailscale", configId: config.id },
    });
  });

  it("tailscale-024 keeps the 100.64.0.1 binding when the host is renamed", async () => {
    signIn(await member());
    const config = await createConfig();
    const host = await boundHost(config.id, "100.64.0.1", 2222);

    const renamed = await accept(
      hosts().update({
        headers,
        params: { connectionId: host.id },
        body: { expectedGeneration: host.generation, displayName: "Renamed" },
      }),
      [200],
    );

    expect(renamed.body).toMatchObject({
      displayName: "Renamed",
      port: 2222,
      transport: { type: "tailscale", configId: config.id },
    });
  });

  it("tailscale-025 keeps the fd7a:115c:a1e0::1 binding when the host is renamed", async () => {
    signIn(await member());
    const config = await createConfig();
    const host = await boundHost(config.id, "fd7a:115c:a1e0::1", 2222);

    const renamed = await accept(
      hosts().update({
        headers,
        params: { connectionId: host.id },
        body: { expectedGeneration: host.generation, displayName: "Renamed" },
      }),
      [200],
    );

    expect(renamed.body).toMatchObject({
      displayName: "Renamed",
      port: 2222,
      transport: { type: "tailscale", configId: config.id },
    });
  });

  it("tailscale-034 rejects scope conversion, empty tags and malformed credentials in a config update", async () => {
    signIn(await member());
    const config = await createConfig();
    const request = setupRawAppRequest({ context, routes: tailscaleRoutes });
    const patch = (body: Record<string, unknown>) => {
      return request(`/api/tailscale/configs/${config.id}`, {
        method: "PATCH",
        headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify({ expectedRevision: 1, ...body }),
      });
    };

    const responses = await Promise.all([
      patch({ scope: "organization" }),
      patch({ tags: [] }),
      patch({
        credentials: {
          clientId: `client-${randomUUID()}`,
          clientSecret: `\nsecret-${randomUUID()}`,
        },
      }),
    ]);

    expect(
      responses.map((response) => {
        return response.status;
      }),
    ).toStrictEqual([400, 400, 400]);
    const { configs } = await inventory();
    expect(configs).toStrictEqual([
      expect.objectContaining({ id: config.id, revision: 1, generation: 1 }),
    ]);
  });

  it("tailscale-004 keeps OAuth write-only through explicit-ID replay, rename, credential replacement and delete", async () => {
    signIn(await member());
    const id = randomUUID();
    const original = oauthClient();
    const created = await accept(
      tailscale().create({
        headers,
        body: {
          id,
          name: "Tailnet",
          credentials: original,
          tags: ["tag:okou"],
        },
      }),
      [201],
    );
    const replay = oauthClient();
    const repeated = await accept(
      tailscale().create({
        headers,
        body: { id, name: "Tailnet", credentials: replay, tags: ["tag:okou"] },
      }),
      [204],
    );
    const renamed = await accept(
      tailscale().update({
        headers,
        params: { configId: id },
        body: { expectedRevision: 1, name: "Renamed tailnet" },
      }),
      [200],
    );
    const replacement = oauthClient();
    const replaced = await accept(
      tailscale().update({
        headers,
        params: { configId: id },
        body: { expectedRevision: 2, credentials: replacement },
      }),
      [200],
    );
    await accept(
      tailscale().update({
        headers,
        params: { configId: id },
        body: { expectedRevision: 2, name: "Stale rename" },
      }),
      [409],
    );
    const listed = await inventory();

    expect(created.body).toMatchObject({
      revision: 1,
      generation: 1,
      scope: "personal",
      sshHosts: [],
      vncHosts: [],
    });
    expect(repeated.status).toBe(204);
    expect(renamed.body).toMatchObject({ revision: 2, generation: 1 });
    expect(replaced.body).toMatchObject({ revision: 3, generation: 2 });
    const disclosed = JSON.stringify([
      created.body,
      renamed.body,
      replaced.body,
      listed,
    ]);
    for (const secret of [original, replay, replacement].flatMap((client) => {
      return [client.clientId, client.clientSecret];
    })) {
      expect(disclosed).not.toContain(secret);
    }
    expect(disclosed).not.toMatch(/clientId|clientSecret|credentials/u);
    expect(listed.configs).toStrictEqual([replaced.body]);

    await accept(
      tailscale().delete({
        headers,
        params: { configId: id },
        body: { expectedRevision: 3 },
      }),
      [204],
    );
  });

  it("tailscale-001 creates a credential-free Tailscale SSH host and enforces its transitions", async () => {
    const owner = await member();
    const peer = await member({ orgId: owner.orgId });
    signIn(owner);
    const config = await createConfig();
    const hostId = randomUUID();
    const created = await accept(
      hosts().create({
        headers,
        body: {
          id: hostId,
          displayName: "Tailscale SSH",
          host: "peer",
          username: "ubuntu",
          transport: { type: "tailscale_ssh", configId: config.id },
        },
      }),
      [201],
    );
    expect(created.body).toMatchObject({
      username: "ubuntu",
      port: 22,
      transport: { type: "tailscale_ssh", configId: config.id },
    });
    expect(created.body).not.toHaveProperty("credentialId");
    expect(created.body).not.toHaveProperty("credentialName");
    expect((await inventory()).logins).toStrictEqual([]);

    const update = (
      expectedGeneration: number,
      body: Omit<
        NonNullable<Parameters<ReturnType<typeof hosts>["update"]>[0]>["body"],
        "expectedGeneration"
      >,
    ) => {
      return hosts().update({
        headers,
        params: { connectionId: hostId },
        body: { expectedGeneration, ...body },
      });
    };
    const generation = created.body.generation;
    await accept(update(generation, { port: 2222 }), [400]);
    await accept(update(generation, { credential: inlineLogin() }), [400]);
    await accept(update(generation, { transport: { type: "direct" } }), [400]);

    const deploy = await accept(
      update(generation, { username: "deploy" }),
      [200],
    );
    expect(deploy.body).toMatchObject({
      username: "deploy",
      transport: { type: "tailscale_ssh", configId: config.id },
    });

    const converted = await accept(
      update(deploy.body.generation, {
        port: 2022,
        credential: inlineLogin(),
        transport: { type: "tailscale", configId: config.id },
      }),
      [200],
    );
    expect(converted.body).toMatchObject({
      port: 2022,
      credentialId: expect.any(String),
      transport: { type: "tailscale", configId: config.id },
    });

    const back = await accept(
      update(converted.body.generation, {
        port: 22,
        username: "ubuntu",
        transport: { type: "tailscale_ssh", configId: config.id },
      }),
      [200],
    );
    expect(back.body).toMatchObject({
      port: 22,
      username: "ubuntu",
      transport: { type: "tailscale_ssh", configId: config.id },
    });
    expect(back.body).not.toHaveProperty("credentialId");
    expect((await inventory()).logins).toHaveLength(1);

    signIn(peer);
    await accept(
      hosts().create({
        headers,
        body: {
          id: randomUUID(),
          displayName: "Borrowed network",
          host: "peer",
          username: "ubuntu",
          transport: { type: "tailscale_ssh", configId: config.id },
        },
      }),
      [404],
    );
    expect((await inventory()).hosts).toStrictEqual([]);
  });

  it("tailscale-003 keeps an inline Tailscale SSH network login-free through adoption and rebind", async () => {
    const owner = await member({ role: "admin" });
    const admin = await member({ orgId: owner.orgId, role: "admin" });
    signIn(owner);
    const hostId = randomUUID();
    await accept(
      hosts().create({
        headers,
        body: {
          id: hostId,
          displayName: "Inline SSH network",
          host: "peer",
          username: "ubuntu",
          transport: { type: "tailscale_ssh", create: inlineNetwork() },
        },
      }),
      [201],
    );
    const created = await inventory();
    expect(created.logins).toStrictEqual([]);
    expect(created.configs).toHaveLength(1);
    const network = created.configs[0]!;

    const promoted = await accept(
      tailscale().convertToOrganization({
        headers,
        params: { configId: network.id },
        body: { expectedRevision: network.revision },
      }),
      [200],
    );
    signIn(admin);
    const preview = await accept(
      tailscale().impactPreview({
        headers,
        params: { configId: network.id },
        query: { operation: "convert" },
      }),
      [200],
    );
    await accept(
      tailscale().convertToPersonal({
        headers,
        params: { configId: network.id },
        body: {
          expectedRevision: promoted.body.revision,
          impactSnapshot: preview.body.impactSnapshot,
        },
      }),
      [200],
    );

    signIn(owner);
    const orphaned = await inventory();
    expect(orphaned.hosts).toStrictEqual([
      expect.objectContaining({
        id: hostId,
        username: "ubuntu",
        transport: { type: "tailscale_ssh", needsRebind: true },
      }),
    ]);
    const replacement = await createConfig();
    const rebound = await accept(
      hosts().update({
        headers,
        params: { connectionId: hostId },
        body: {
          expectedGeneration: orphaned.hosts[0]!.generation,
          transport: { type: "tailscale_ssh", configId: replacement.id },
        },
      }),
      [200],
    );
    expect(rebound.body).toMatchObject({
      username: "ubuntu",
      port: 22,
      transport: { type: "tailscale_ssh", configId: replacement.id },
    });
    expect((await inventory()).logins).toStrictEqual([]);
  });

  it("tailscale-005 limits shared management to admins and hides personal networks and other members' hosts", async () => {
    const admin = await member({ role: "admin" });
    const regular = await member({ orgId: admin.orgId });
    const outsider = await member();
    signIn(admin);
    const shared = await createConfig({ scope: "organization" });
    const personal = await createConfig();

    signIn(regular);
    const host = await boundHost(shared.id);
    const memberView = await inventory();
    expect(memberView.configs).toStrictEqual([
      expect.objectContaining({
        id: shared.id,
        sshHosts: [{ id: host.id, displayName: host.displayName }],
      }),
    ]);
    await accept(
      tailscale().update({
        headers,
        params: { configId: shared.id },
        body: { expectedRevision: shared.revision, name: "Member rename" },
      }),
      [403],
    );
    await accept(
      tailscale().create({
        headers,
        body: {
          id: randomUUID(),
          name: "Member shared",
          credentials: oauthClient(),
          tags: ["tag:okou"],
          scope: "organization",
        },
      }),
      [403],
    );
    const afterForbidden = await inventory();
    expect(
      afterForbidden.configs.map((config) => {
        return config.id;
      }),
    ).not.toContain(personal.id);
    await accept(
      hosts().create({
        headers,
        body: {
          id: randomUUID(),
          displayName: "Admin personal network",
          host: "100.64.0.11",
          credential: inlineLogin(),
          transport: { type: "tailscale", configId: personal.id },
        },
      }),
      [404],
    );
    expect((await inventory()).logins).toHaveLength(1);

    signIn(admin);
    const adminView = await inventory();
    expect(adminView.configs).toContainEqual(
      expect.objectContaining({ id: shared.id, sshHosts: [] }),
    );
    const referenced = await accept(
      tailscale().delete({
        headers,
        params: { configId: shared.id },
        body: { expectedRevision: shared.revision },
      }),
      [409],
    );
    expect(JSON.stringify(referenced.body)).not.toContain(host.id);

    signIn(outsider);
    expect((await inventory()).configs).toStrictEqual([]);

    signIn(regular);
    await accept(
      hosts().delete({
        headers,
        params: { connectionId: host.id },
        body: { expectedGeneration: host.generation },
      }),
      [204],
    );
    signIn(admin);
    await accept(
      tailscale().delete({
        headers,
        params: { configId: shared.id },
        body: { expectedRevision: shared.revision },
      }),
      [204],
    );
  });

  it("tailscale-006 binds saved and inline networks and logins atomically on create", async () => {
    signIn(await member());
    const config = await createConfig();
    const first = await boundHost(config.id);
    if (!("credentialId" in first)) {
      throw new Error("Expected a login-backed host");
    }
    const steps = [
      {
        credential: { id: first.credentialId },
        transport: { type: "tailscale" as const, configId: config.id },
        configs: 0,
        logins: 0,
      },
      {
        credential: { id: first.credentialId },
        transport: { type: "tailscale" as const, create: inlineNetwork() },
        configs: 1,
        logins: 0,
      },
      {
        credential: inlineLogin(),
        transport: { type: "tailscale" as const, create: inlineNetwork() },
        configs: 1,
        logins: 1,
      },
    ];
    for (const step of steps) {
      const before = await inventory();
      const secret = step.transport.create?.credentials.clientSecret;
      const created = await accept(
        hosts().create({
          headers,
          body: {
            id: randomUUID(),
            displayName: `Peer ${randomUUID().slice(0, 8)}`,
            host: "100.64.2.3",
            port: 65_535,
            credential: step.credential,
            transport: step.transport,
          },
        }),
        [201],
      );
      expect(created.body).toMatchObject({
        port: 65_535,
        transport: { type: "tailscale" },
      });
      if (secret) {
        expect(JSON.stringify(created.body)).not.toContain(secret);
      }
      const after = await inventory();
      expect(after.configs).toHaveLength(before.configs.length + step.configs);
      expect(after.logins).toHaveLength(before.logins.length + step.logins);
    }
  });

  it("tailscale-007 binds saved and inline networks and logins atomically on update", async () => {
    signIn(await member());
    const config = await createConfig();
    const host = await boundHost(config.id);
    if (!("credentialId" in host)) {
      throw new Error("Expected a login-backed host");
    }
    const steps = [
      {
        credential: inlineLogin(),
        transport: { type: "tailscale" as const, configId: config.id },
        configs: 0,
        logins: 1,
      },
      {
        credential: { id: host.credentialId },
        transport: { type: "tailscale" as const, create: inlineNetwork() },
        configs: 1,
        logins: 0,
      },
      {
        credential: inlineLogin(),
        transport: { type: "tailscale" as const, create: inlineNetwork() },
        configs: 1,
        logins: 1,
      },
    ];
    let generation = host.generation;
    for (const step of steps) {
      const before = await inventory();
      const secret = step.transport.create?.credentials.clientSecret;
      const updated = await accept(
        hosts().update({
          headers,
          params: { connectionId: host.id },
          body: {
            expectedGeneration: generation,
            host: "100.64.2.3",
            port: 65_535,
            credential: step.credential,
            transport: step.transport,
          },
        }),
        [200],
      );
      expect(updated.body).toMatchObject({
        port: 65_535,
        transport: { type: "tailscale" },
      });
      if (secret) {
        expect(JSON.stringify(updated.body)).not.toContain(secret);
      }
      const after = await inventory();
      expect(after.configs).toHaveLength(before.configs.length + step.configs);
      expect(after.logins).toHaveLength(before.logins.length + step.logins);
      generation = updated.body.generation;
    }

    const beforeStale = await inventory();
    await accept(
      hosts().update({
        headers,
        params: { connectionId: host.id },
        body: {
          expectedGeneration: host.generation,
          credential: inlineLogin(),
          transport: { type: "tailscale", create: inlineNetwork() },
        },
      }),
      [409],
    );
    await expect(inventory()).resolves.toStrictEqual(beforeStale);
  });

  it("tailscale-008 reconciles a host-create retry and rolls back a conflicting create", async () => {
    const owner = await member();
    const peer = await member({ orgId: owner.orgId });
    signIn(owner);
    const body = {
      id: randomUUID(),
      displayName: "Inline everything",
      host: "100.64.0.12",
      credential: inlineLogin(),
      transport: { type: "tailscale" as const, create: inlineNetwork() },
    };
    await accept(hosts().create({ headers, body }), [201]);
    const created = await inventory();

    await accept(hosts().create({ headers, body }), [204]);
    await expect(inventory()).resolves.toStrictEqual(created);

    await accept(
      hosts().create({ headers, body: { ...body, id: randomUUID() } }),
      [201],
    );
    expect((await inventory()).configs).toHaveLength(
      created.configs.length + 1,
    );

    signIn(peer);
    await accept(hosts().create({ headers, body }), [409]);
    await expect(inventory()).resolves.toStrictEqual({
      hosts: [],
      logins: [],
      configs: [],
    });
  });
});
