import { randomUUID } from "node:crypto";

import { cloudflareAccessContract } from "@okouai/api-contracts/contracts/cloudflare-access";
import { sshConnectionsContract } from "@okouai/api-contracts/contracts/ssh-connections";
import { sshCredentialsContract } from "@okouai/api-contracts/contracts/ssh-credentials";
import { describe, expect, it } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { cloudflareAccessRoutes } from "../cloudflare-access";
import { sshConnectionsRoutes } from "../ssh-connections";
import { channelsPublishedTo } from "./helpers/realtime-publications";
import { createRouteMocks } from "./helpers/route-test";
import { sshCredentialId } from "./helpers/ssh-credential";

const context = testContext();
const headers = { authorization: "Bearer clerk-session" };

interface Actor {
  readonly userId: string;
  readonly orgId: string;
  readonly role: "org:admin" | "org:member";
}

function actor(role: Actor["role"], orgId = `org_${randomUUID()}`): Actor {
  return { userId: `user_${randomUUID()}`, orgId, role };
}

function signIn(user: Actor) {
  createRouteMocks(context).clerk.session(user.userId, user.orgId, user.role);
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
const logins = () => {
  return setupApp({ context, routes: sshConnectionsRoutes })(
    sshCredentialsContract,
  );
};

function accessCredentials() {
  return {
    clientId: `client-${randomUUID()}`,
    clientSecret: `secret-${randomUUID()}`,
  };
}

async function createConfig(
  user: Actor,
  scope: "personal" | "organization",
  id: string = randomUUID(),
) {
  signIn(user);
  const created = await accept(
    configs().create({
      headers,
      query: { view: "scoped" },
      body: {
        id,
        name: `Access ${id.slice(0, 8)}`,
        scope,
        credentials: accessCredentials(),
      },
    }),
    [201],
  );
  return created.body;
}

function inlinePassword(username: string) {
  return {
    create: {
      name: `${username} login`,
      username,
      authentication: {
        method: "password" as const,
        password: `password-${randomUUID()}`,
      },
    },
  };
}

function hostFields() {
  const id = randomUUID();
  return {
    id,
    displayName: `Host ${id.slice(0, 8)}`,
    host: `ssh-${id.slice(0, 8)}.example.test`,
    port: 443,
  };
}

async function bindHost(user: Actor, configId: string) {
  signIn(user);
  const created = await accept(
    hosts().create({
      headers,
      body: {
        ...hostFields(),
        credential: inlinePassword("deploy"),
        transport: { type: "cloudflare_access", configId },
      },
    }),
    [201],
  );
  return created.body;
}

async function listHosts(user: Actor) {
  signIn(user);
  const listed = await accept(hosts().list({ headers }), [200]);
  return listed.body.connections;
}

async function listLogins(user: Actor) {
  signIn(user);
  const listed = await accept(logins().list({ headers }), [200]);
  return listed.body.credentials;
}

async function listConfigs(user: Actor) {
  signIn(user);
  const listed = await accept(
    configs().list({ headers, query: { view: "scoped" } }),
    [200],
  );
  return listed.body.configs;
}

function accessConfigId(connection: object) {
  const transport =
    "transport" in connection ? connection.transport : undefined;
  if (
    typeof transport !== "object" ||
    transport === null ||
    !("configId" in transport) ||
    typeof transport.configId !== "string"
  ) {
    throw new Error("Expected a Cloudflare Access transport with a config ID");
  }
  return transport.configId;
}

function clearPublications() {
  context.mocks.ably.publish.mockClear();
  context.mocks.ably.channelGet.mockClear();
}

describe("Cloudflare Access owner configuration", () => {
  it("cloudflare-access-012 a second workspace user cannot reuse or reach another user's configuration ID", async () => {
    const owner = actor("org:admin");
    const other = actor("org:admin", owner.orgId);
    const config = await createConfig(owner, "personal");

    signIn(other);
    const conflict = await accept(
      configs().create({
        headers,
        query: { view: "scoped" },
        body: {
          id: config.id,
          name: "Borrowed Access",
          scope: "personal",
          credentials: accessCredentials(),
        },
      }),
      [409],
    );
    expect(conflict.body.error).toMatchObject({
      code: "CLOUDFLARE_ACCESS_RESOURCE_ID_CONFLICT",
      message:
        "This resource ID cannot be used for this Cloudflare Access configuration.",
    });
    await expect(listConfigs(other)).resolves.toStrictEqual([]);
    signIn(other);
    await accept(
      configs().update({
        headers,
        query: { view: "scoped" },
        params: { configId: config.id },
        body: { expectedRevision: 1, name: "Taken over" },
      }),
      [404],
    );
    await accept(
      configs().delete({
        headers,
        query: { view: "scoped" },
        params: { configId: config.id },
        body: { expectedRevision: 1 },
      }),
      [404],
    );
    await accept(
      hosts().create({
        headers,
        body: {
          ...hostFields(),
          credential: inlinePassword("deploy"),
          transport: { type: "cloudflare_access", configId: config.id },
        },
      }),
      [404],
    );
  });

  it("cloudflare-access-011 shares one configuration across hosts without secret readback and rejects stale or dependent deletion", async () => {
    const member = actor("org:member");
    const credentials = accessCredentials();
    signIn(member);
    const created = await accept(
      configs().create({
        headers,
        query: { view: "scoped" },
        body: {
          id: randomUUID(),
          name: "Shared Access",
          scope: "personal",
          credentials,
        },
      }),
      [201],
    );
    const config = created.body;
    const login = inlinePassword("deploy");
    const password = login.create.authentication.password;
    signIn(member);
    const first = await accept(
      hosts().create({
        headers,
        body: {
          ...hostFields(),
          credential: login,
          transport: { type: "cloudflare_access", configId: config.id },
        },
      }),
      [201],
    );
    signIn(member);
    const second = await accept(
      hosts().create({
        headers,
        body: {
          ...hostFields(),
          credential: { id: sshCredentialId(first.body) },
          transport: { type: "cloudflare_access", configId: config.id },
        },
      }),
      [201],
    );
    const bound = [first.body, second.body];
    const listed = await listConfigs(member);
    expect(listed).toMatchObject([{ id: config.id }]);
    expect(listed[0]?.sshHosts.map((host) => host.id).sort()).toStrictEqual(
      bound.map((host) => host.id).sort(),
    );
    const publicBodies = JSON.stringify([
      config,
      listed,
      bound,
      await listHosts(member),
    ]);
    for (const hidden of [
      credentials.clientId,
      credentials.clientSecret,
      password,
      "encrypted",
    ]) {
      expect(publicBodies).not.toContain(hidden);
    }

    signIn(member);
    const inUse = await accept(
      configs().delete({
        headers,
        query: { view: "scoped" },
        params: { configId: config.id },
        body: { expectedRevision: 1 },
      }),
      [409],
    );
    expect(inUse.body.error.code).toBe("CLOUDFLARE_ACCESS_IN_USE");
    const rename = (expectedRevision: number) => {
      return configs().update({
        headers,
        query: { view: "scoped" },
        params: { configId: config.id },
        body: { expectedRevision, name: "Renamed Access" },
      });
    };
    const renamed = await accept(rename(1), [200]);
    expect(renamed.body).toMatchObject({ revision: 2, generation: 1 });
    await accept(rename(1), [409]);
    for (const host of bound) {
      await accept(
        hosts().delete({
          headers,
          params: { connectionId: host.id },
          body: { expectedGeneration: host.generation },
        }),
        [204],
      );
    }
    const remove = (expectedRevision: number) => {
      return configs().delete({
        headers,
        query: { view: "scoped" },
        params: { configId: config.id },
        body: { expectedRevision },
      });
    };
    await accept(remove(1), [409]);
    await accept(remove(2), [204]);
    await expect(listConfigs(member)).resolves.toStrictEqual([]);
  });
});

describe("inline SSH resource creation", () => {
  it("cloudflare-access-001 creates hosts from saved and inline Access and logins and links each host to both", async () => {
    const member = actor("org:member");
    const saved = await createConfig(member, "personal");
    const protectedHost = await bindHost(member, saved.id);
    const savedLoginId = sshCredentialId(protectedHost);
    const secrets: string[] = [];

    const combinations = [
      {
        credential: { id: savedLoginId },
        transport: { type: "cloudflare_access" as const, configId: saved.id },
        newLogin: false,
        newAccess: false,
      },
      {
        credential: { id: savedLoginId },
        transport: {
          type: "cloudflare_access" as const,
          create: { name: "Inline Access", credentials: accessCredentials() },
        },
        newLogin: false,
        newAccess: true,
      },
      {
        credential: inlinePassword("operator"),
        transport: {
          type: "cloudflare_access" as const,
          create: { name: "Inline Access 2", credentials: accessCredentials() },
        },
        newLogin: true,
        newAccess: true,
      },
    ];

    for (const combination of combinations) {
      const transportCreate =
        "create" in combination.transport
          ? combination.transport.create
          : undefined;
      if (transportCreate) {
        secrets.push(
          transportCreate.credentials.clientId,
          transportCreate.credentials.clientSecret,
        );
      }
      if ("create" in combination.credential) {
        const authentication = combination.credential.create.authentication;
        secrets.push(authentication.password);
      }
      const [hostsBefore, loginsBefore, configsBefore] = [
        await listHosts(member),
        await listLogins(member),
        await listConfigs(member),
      ];
      clearPublications();
      signIn(member);

      const created = await accept(
        hosts().create({
          headers,
          body: {
            ...hostFields(),
            credential: combination.credential,
            transport: combination.transport,
          },
        }),
        [201],
      );

      const body = JSON.stringify(created.body);
      for (const secret of secrets) {
        expect(body).not.toContain(secret);
      }
      const configId = accessConfigId(created.body);
      expect(created.body).toMatchObject({
        transport: { type: "cloudflare_access", configId },
      });
      const userChannel = `user:${member.userId}`;
      expect(channelsPublishedTo(context.mocks, "ssh:changed")).toContain(
        userChannel,
      );
      const accessChannels = channelsPublishedTo(
        context.mocks,
        "cloudflare-access:changed",
      );
      if (combination.newAccess) {
        expect(accessChannels).toContain(userChannel);
      } else {
        expect(accessChannels).toStrictEqual([]);
      }

      const loginId = sshCredentialId(created.body);
      if (!combination.newLogin) {
        expect(loginId).toBe(savedLoginId);
      }
      if (!combination.newAccess) {
        expect(configId).toBe(saved.id);
      }
      const hostsAfter = await listHosts(member);
      const loginsAfter = await listLogins(member);
      const configsAfter = await listConfigs(member);
      expect(hostsAfter).toHaveLength(hostsBefore.length + 1);
      expect(loginsAfter).toHaveLength(
        loginsBefore.length + (combination.newLogin ? 1 : 0),
      );
      expect(configsAfter).toHaveLength(
        configsBefore.length + (combination.newAccess ? 1 : 0),
      );
      const login = loginsAfter.find((entry) => {
        return entry.id === loginId;
      });
      expect(login?.hosts.map((host) => host.id)).toContain(created.body.id);
      const config = configsAfter.find((entry) => {
        return entry.id === configId;
      });
      expect(config?.sshHosts.map((host) => host.id)).toContain(
        created.body.id,
      );
      for (const secret of secrets) {
        expect(
          JSON.stringify([hostsAfter, loginsAfter, configsAfter]),
        ).not.toContain(secret);
      }
    }
  });

  it("cloudflare-access-003 rejects invalid references, destinations and stale versions without creating anything", async () => {
    const foreignAdmin = actor("org:admin");
    const foreignConfig = await createConfig(foreignAdmin, "personal");
    const foreignHost = await bindHost(foreignAdmin, foreignConfig.id);
    const foreignLoginId = sshCredentialId(foreignHost);
    const member = actor("org:member");
    signIn(member);
    const existing = await accept(
      hosts().create({
        headers,
        body: {
          ...hostFields(),
          port: 22,
          credential: inlinePassword("deploy"),
          transport: { type: "direct" },
        },
      }),
      [201],
    );
    const current = await accept(
      hosts().update({
        headers,
        params: { connectionId: existing.body.id },
        body: {
          expectedGeneration: existing.body.generation,
          displayName: "Build host",
        },
      }),
      [200],
    );
    const [hostsBefore, loginsBefore, configsBefore] = [
      await listHosts(member),
      await listLogins(member),
      await listConfigs(member),
    ];
    const missingId = randomUUID();
    const inlineAccess = {
      type: "cloudflare_access" as const,
      create: { name: "Inline Access", credentials: accessCredentials() },
    };
    signIn(member);

    for (const loginId of [missingId, foreignLoginId]) {
      await accept(
        hosts().create({
          headers,
          body: {
            ...hostFields(),
            credential: { id: loginId },
            transport: inlineAccess,
          },
        }),
        [404],
      );
      await accept(
        hosts().update({
          headers,
          params: { connectionId: current.body.id },
          body: {
            expectedGeneration: current.body.generation,
            credential: { id: loginId },
          },
        }),
        [404],
      );
    }
    for (const configId of [missingId, foreignConfig.id]) {
      await accept(
        hosts().create({
          headers,
          body: {
            ...hostFields(),
            credential: inlinePassword("deploy"),
            transport: { type: "cloudflare_access", configId },
          },
        }),
        [404],
      );
      await accept(
        hosts().update({
          headers,
          params: { connectionId: current.body.id },
          body: {
            expectedGeneration: current.body.generation,
            port: 443,
            transport: { type: "cloudflare_access", configId },
          },
        }),
        [404],
      );
    }
    await accept(
      hosts().create({
        headers,
        body: {
          ...hostFields(),
          host: "127.0.0.1",
          credential: inlinePassword("deploy"),
          transport: inlineAccess,
        },
      }),
      [400],
    );
    await accept(
      hosts().update({
        headers,
        params: { connectionId: current.body.id },
        body: {
          expectedGeneration: current.body.generation,
          host: "127.0.0.1",
          port: 443,
          transport: inlineAccess,
        },
      }),
      [400],
    );
    await accept(
      hosts().create({
        headers,
        body: {
          ...hostFields(),
          port: 22,
          credential: inlinePassword("deploy"),
          transport: inlineAccess,
        },
      }),
      [400],
    );
    await accept(
      hosts().update({
        headers,
        params: { connectionId: current.body.id },
        body: {
          expectedGeneration: current.body.generation,
          port: 22,
          transport: inlineAccess,
        },
      }),
      [400],
    );
    await accept(
      hosts().update({
        headers,
        params: { connectionId: current.body.id },
        body: {
          expectedGeneration: existing.body.generation,
          displayName: "Stale rename",
        },
      }),
      [409],
    );

    await expect(listHosts(member)).resolves.toStrictEqual(hostsBefore);
    await expect(listLogins(member)).resolves.toStrictEqual(loginsBefore);
    await expect(listConfigs(member)).resolves.toStrictEqual(configsBefore);
  });
});

describe("organization Cloudflare Access", () => {
  it("cloudflare-access-006 members bind the shared configuration and see only their own hosts", async () => {
    const admin = actor("org:admin");
    const members = [
      actor("org:member", admin.orgId),
      actor("org:member", admin.orgId),
    ];
    const outsider = actor("org:admin");
    const shared = await createConfig(admin, "organization");
    expect(shared).toMatchObject({ scope: "organization", sshHosts: [] });
    const personal = await createConfig(admin, "personal");
    expect(personal).toMatchObject({
      scope: "personal",
      revision: 1,
      generation: 1,
      sshHosts: [],
      vncHosts: [],
    });
    signIn(admin);
    const adminList = await accept(
      configs().list({ headers, query: {} }),
      [200],
    );
    expect(
      adminList.body.configs.map((config) => config.id).sort(),
    ).toStrictEqual([shared.id, personal.id].sort());
    for (const config of [shared, personal]) {
      const renamed = await accept(
        configs().update({
          headers,
          query: { view: "scoped" },
          params: { configId: config.id },
          body: {
            expectedRevision: 1,
            name: `Renamed ${config.id.slice(0, 8)}`,
          },
        }),
        [200],
      );
      expect(renamed.body.revision).toBe(2);
    }

    for (const member of members) {
      const host = await bindHost(member, shared.id);
      const listed = await listConfigs(member);
      expect(listed).toMatchObject([
        { id: shared.id, scope: "organization", sshHosts: [{ id: host.id }] },
      ]);
      expect(listed[0]?.sshHosts).toHaveLength(1);
      expect(JSON.stringify(listed)).not.toContain("secret-");
    }

    const [member] = members;
    if (!member) {
      throw new Error("Expected a workspace member");
    }
    signIn(member);
    await accept(
      configs().update({
        headers,
        query: { view: "scoped" },
        params: { configId: shared.id },
        body: { expectedRevision: 2, name: "Member rename" },
      }),
      [403],
    );
    await accept(
      configs().delete({
        headers,
        query: { view: "scoped" },
        params: { configId: shared.id },
        body: { expectedRevision: 2 },
      }),
      [403],
    );
    await accept(
      configs().create({
        headers,
        query: { view: "scoped" },
        body: {
          id: randomUUID(),
          name: "Member organization Access",
          scope: "organization",
          credentials: accessCredentials(),
        },
      }),
      [403],
    );

    await expect(listConfigs(outsider)).resolves.toStrictEqual([]);
    signIn(outsider);
    await accept(
      hosts().create({
        headers,
        body: {
          ...hostFields(),
          credential: inlinePassword("deploy"),
          transport: { type: "cloudflare_access", configId: shared.id },
        },
      }),
      [404],
    );
  });
});
