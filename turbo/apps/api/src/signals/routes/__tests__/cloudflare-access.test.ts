import { createHash, randomUUID } from "node:crypto";

import { chatRemoteAccessContract } from "@okouai/api-contracts/contracts/chat-remote-access";
import { cloudflareAccessContract } from "@okouai/api-contracts/contracts/cloudflare-access";
import { runnerSshContract } from "@okouai/api-contracts/contracts/runner-ssh";
import { sshHostsContract } from "@okouai/api-contracts/contracts/ssh-access";
import { sshConnectionsContract } from "@okouai/api-contracts/contracts/ssh-connections";
import { sshCredentialsContract } from "@okouai/api-contracts/contracts/ssh-credentials";
import { createStore } from "ccstate";
import { beforeAll, describe, expect, it } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import {
  TEST_WITH_DOUBLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE,
  TEST_WITH_SINGLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE,
} from "../../../__tests__/test-timeouts";
import { env, mockOptionalEnv } from "../../../lib/env";
import { nowDate } from "../../../lib/time";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { chatRemoteAccessRoutes } from "../chat-remote-access";
import { cloudflareAccessRoutes } from "../cloudflare-access";
import { runnerSshRoutes } from "../runner-ssh";
import { sshAccessRoutes } from "../ssh-access";
import { sshConnectionsRoutes } from "../ssh-connections";
import { createBddApi, type ApiTestUser } from "./helpers/api-bdd";
import { createRunsApi } from "./helpers/api-bdd-runs";
import { createChatEventsFixture } from "./helpers/chat-events-fixture";
import { seedOrgMembership$ } from "./helpers/org-membership";
import { publicRunOwner } from "./helpers/public-run-owner";
import { channelsPublishedTo } from "./helpers/realtime-publications";
import { createRouteMocks } from "./helpers/route-test";
import { useSecretKmsProbe } from "./helpers/secret-kms-probe";
import { sshCredentialId } from "./helpers/ssh-credential";

const context = testContext();
const clerkDirectory = createStore();
const headers = Object.freeze({ authorization: "Bearer clerk-session" });

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
const remoteAccess = () => {
  return setupApp({ context, routes: chatRemoteAccessRoutes })(
    chatRemoteAccessContract,
  );
};
const runnerSsh = () => {
  return setupApp({ context, routes: runnerSshRoutes })(runnerSshContract);
};
const sshHosts = () => {
  return setupApp({ context, routes: sshAccessRoutes })(sshHostsContract);
};

function runnerHeaders() {
  return {
    authorization: `Bearer vm0_official_${env("OFFICIAL_RUNNER_SECRET")}`,
  };
}

function hostKeyFor(seed: string) {
  return {
    algorithm: "ssh-ed25519" as const,
    fingerprint: `SHA256:${createHash("sha256")
      .update(seed)
      .digest("base64")
      .replace(/=+$/u, "")}`,
  };
}

function readRealtimePublications() {
  const gets = context.mocks.ably.channelGet.mock;
  const publishes = context.mocks.ably.publish.mock;
  return publishes.calls.map((call, index) => {
    const publishedAt = publishes.invocationCallOrder[index] ?? 0;
    let channel = "";
    for (const [getIndex, order] of gets.invocationCallOrder.entries()) {
      if (order < publishedAt) {
        channel = String(gets.calls[getIndex]?.[0] ?? "");
      }
    }
    return { channel, topic: call[0], payload: call[1] };
  });
}

async function seedWorkspaceMember(
  role: Actor["role"],
  orgId = `org_${randomUUID()}`,
): Promise<Actor> {
  const created = actor(role, orgId);
  await clerkDirectory.set(
    seedOrgMembership$,
    {
      orgId: created.orgId,
      userId: created.userId,
      role: role === "org:admin" ? "admin" : "member",
    },
    context.signal,
  );
  return created;
}

async function enableSshDefault(user: Actor, connectionId: string) {
  signIn(user);
  await accept(
    remoteAccess().updateHostDefault({
      headers,
      params: { protocol: "ssh", connectionId },
      body: { enabled: true },
    }),
    [200],
  );
}

async function launchActorRun(
  user: Actor,
  options: {
    readonly runnerGroup?: string;
    readonly runnerIdentity?: {
      readonly runnerId: string;
      readonly heartbeatGeneration: number;
    };
    readonly bootstrapOrg?: boolean;
    readonly grantTeam?: boolean;
  } = {},
) {
  const fixture = createChatEventsFixture(context);
  const bdd = createBddApi(context);
  const runs = createRunsApi(context);
  const apiUser: ApiTestUser = bdd.user({
    userId: user.userId,
    orgId: user.orgId,
    orgRole: user.role,
  });
  const owner = publicRunOwner(context, apiUser);
  fixture.chatCallbacks.acceptChatObjectStorage();
  runs.acceptStorageDownloads();
  runs.acceptTelemetryIngest();
  mockOptionalEnv("OPENROUTER_API_KEY", undefined);
  fixture.chatCallbacks.disableVapid();

  const runnerGroup =
    options.runnerGroup ??
    (await runs.configureRunnerGroup({
      maxConcurrent: 4,
      ...(options.runnerIdentity
        ? { runnerIdentity: options.runnerIdentity }
        : {}),
    }));
  if (options.bootstrapOrg !== false) {
    await owner.run(() => {
      return bdd.bootstrapLimitedFreeOnboarding(apiUser);
    });
    if (options.grantTeam) {
      await runs.grantProEntitlement(apiUser, { tier: "team" });
    }
  } else {
    await owner.run(() => {
      return bdd.completeOnboarding(apiUser);
    });
  }

  const launched = await owner.run(() => {
    return fixture.sendChatRun(apiUser, {
      prompt: "Access my Cloudflare Access SSH host",
      model: null,
    });
  });
  const execution = await owner.executionInput(launched.runId);
  const dispatched = runs.dispatchedRun(launched.runId);
  const okouToken = execution.platformEnvironment.OKOU_TOKEN;
  if (!okouToken) {
    throw new Error("Expected OKOU_TOKEN in Run execution input");
  }
  return {
    runId: launched.runId,
    threadId: launched.threadId,
    runnerGroup,
    agentHeaders: { authorization: `Bearer ${okouToken}` },
    runnerIdentity: {
      runnerId: dispatched.runnerId,
      heartbeatGeneration: dispatched.heartbeatGeneration,
    },
  };
}

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
  beforeAll(() => {
    setupApp({
      context,
      routes: [
        ...cloudflareAccessRoutes,
        ...sshConnectionsRoutes,
        ...chatRemoteAccessRoutes,
        ...runnerSshRoutes,
        ...sshAccessRoutes,
      ],
    });
  });

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
    expect(
      listed[0]?.sshHosts
        .map((host) => {
          return host.id;
        })
        .sort(),
    ).toStrictEqual(
      bound
        .map((host) => {
          return host.id;
        })
        .sort(),
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
      expect(
        login?.hosts.map((host) => {
          return host.id;
        }),
      ).toContain(created.body.id);
      const config = configsAfter.find((entry) => {
        return entry.id === configId;
      });
      expect(
        config?.sshHosts.map((host) => {
          return host.id;
        }),
      ).toContain(created.body.id);
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
      adminList.body.configs
        .map((config) => {
          return config.id;
        })
        .sort(),
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

  it(
    "cloudflare-access-005 lists retained hosts as needing rebind and recovers only after an explicit choice",
    { timeout: TEST_WITH_DOUBLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
    async () => {
      useSecretKmsProbe();
      const admin = await seedWorkspaceMember("org:admin");
      const member = await seedWorkspaceMember("org:member", admin.orgId);
      const firstCreds = accessCredentials();
      signIn(admin);
      const first = (
        await accept(
          configs().create({
            headers,
            query: { view: "scoped" },
            body: {
              id: randomUUID(),
              name: "Shared Access One",
              scope: "organization",
              credentials: firstCreds,
            },
          }),
          [201],
        )
      ).body;
      const second = await createConfig(admin, "organization");

      const host = await bindHost(member, first.id);
      const loginId = sshCredentialId(host);
      await enableSshDefault(member, host.id);
      const run = await launchActorRun(member, {
        runnerIdentity: {
          runnerId: randomUUID(),
          heartbeatGeneration: 2,
        },
      });
      const key = hostKeyFor(`ca-005-${host.id}`);
      const pin = await accept(
        runnerSsh().pin({
          headers: runnerHeaders(),
          params: { runId: run.runId },
          body: {
            connectionId: host.id,
            runnerIdentity: run.runnerIdentity,
            expectedGeneration: host.generation,
            observedHostKey: key,
          },
        }),
        [200],
      );
      expect(pin.body).toStrictEqual({
        outcome: "pinned",
        generation: host.generation + 1,
      });

      signIn(admin);
      const preview1 = (
        await accept(
          configs().impactPreview({
            headers,
            params: { configId: first.id },
            query: { operation: "convert" },
          }),
          [200],
        )
      ).body;
      expect(preview1.otherHostCount).toBe(1);
      await accept(
        configs().convertToPersonal({
          headers,
          params: { configId: first.id },
          body: {
            expectedRevision: preview1.expectedRevision,
            impactSnapshot: preview1.impactSnapshot,
          },
        }),
        [200],
      );

      const [retained] = await listHosts(member);
      expect(retained).toMatchObject({
        id: host.id,
        host: host.host,
        port: host.port,
        credentialId: loginId,
        learnedHostKey: key,
        generation: host.generation + 2,
        transport: { type: "cloudflare_access", needsRebind: true },
      });
      expect(JSON.stringify(retained)).not.toContain(first.id);
      expect(JSON.stringify(retained)).not.toContain(firstCreds.clientSecret);

      signIn(member);
      const genAfterConvert = host.generation + 2;
      const withoutTransport = await accept(
        hosts().update({
          headers,
          params: { connectionId: host.id },
          body: {
            expectedGeneration: genAfterConvert,
            displayName: "Missing transport edit",
          },
        }),
        [400],
      );
      expect(withoutTransport.body.error.code).toBe("SSH_INVALID_INPUT");

      const unknownConfig = await accept(
        hosts().update({
          headers,
          params: { connectionId: host.id },
          body: {
            expectedGeneration: genAfterConvert,
            transport: { type: "cloudflare_access", configId: randomUUID() },
          },
        }),
        [404],
      );
      expect(unknownConfig.body.error.code).toBe("CLOUDFLARE_ACCESS_NOT_FOUND");

      const rebound = (
        await accept(
          hosts().update({
            headers,
            params: { connectionId: host.id },
            body: {
              expectedGeneration: genAfterConvert,
              transport: { type: "cloudflare_access", configId: second.id },
            },
          }),
          [200],
        )
      ).body;
      expect(rebound).toMatchObject({
        id: host.id,
        host: host.host,
        port: host.port,
        credentialId: loginId,
        learnedHostKey: key,
        transport: { type: "cloudflare_access", configId: second.id },
      });

      signIn(admin);
      const preview2 = (
        await accept(
          configs().impactPreview({
            headers,
            params: { configId: second.id },
            query: { operation: "convert" },
          }),
          [200],
        )
      ).body;
      await accept(
        configs().convertToPersonal({
          headers,
          params: { configId: second.id },
          body: {
            expectedRevision: preview2.expectedRevision,
            impactSnapshot: preview2.impactSnapshot,
          },
        }),
        [200],
      );

      signIn(member);
      const switchedDirect = (
        await accept(
          hosts().update({
            headers,
            params: { connectionId: host.id },
            body: {
              expectedGeneration: rebound.generation + 1,
              port: 22,
              transport: { type: "direct" },
            },
          }),
          [200],
        )
      ).body;
      expect(switchedDirect).toMatchObject({
        id: host.id,
        host: host.host,
        credentialId: loginId,
        learnedHostKey: key,
      });
      expect("transport" in switchedDirect).toBeFalsy();
    },
  );

  it(
    "cloudflare-access-007 rotates every member host and blocks referenced deletion",
    { timeout: TEST_WITH_DOUBLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
    async () => {
      useSecretKmsProbe();
      const admin = await seedWorkspaceMember("org:admin");
      const memberA = await seedWorkspaceMember("org:member", admin.orgId);
      const memberB = await seedWorkspaceMember("org:member", admin.orgId);
      const shared = await createConfig(admin, "organization");

      const hostA = await bindHost(memberA, shared.id);
      const hostB = await bindHost(memberB, shared.id);
      await enableSshDefault(memberA, hostA.id);
      await enableSshDefault(memberB, hostB.id);

      const runA = await launchActorRun(memberA, { grantTeam: true });
      const runB = await launchActorRun(memberB, {
        runnerGroup: runA.runnerGroup,
        bootstrapOrg: false,
      });

      signIn(admin);
      await accept(
        configs().delete({
          headers,
          query: { view: "scoped" },
          params: { configId: shared.id },
          body: { expectedRevision: shared.revision },
        }),
        [409],
      );

      await flushWaitUntilForTest();
      clearPublications();

      signIn(admin);
      const rotated = (
        await accept(
          configs().update({
            headers,
            query: { view: "scoped" },
            params: { configId: shared.id },
            body: {
              expectedRevision: shared.revision,
              credentials: accessCredentials(),
            },
          }),
          [200],
        )
      ).body;
      await flushWaitUntilForTest();

      expect(rotated).toMatchObject({
        id: shared.id,
        scope: "organization",
        generation: 2,
        revision: 2,
        sshHosts: [],
      });

      const publications = readRealtimePublications();
      expect(
        publications.filter((entry) => {
          return entry.topic === "cloudflare-access:changed";
        }),
      ).toHaveLength(1);
      expect(
        publications.filter((entry) => {
          return entry.topic === "ssh:changed";
        }),
      ).toHaveLength(2);
      expect(
        publications.filter((entry) => {
          return entry.topic === "ssh-authority-invalidated";
        }),
      ).toStrictEqual(
        expect.arrayContaining([
          {
            channel: `runner-group:${runA.runnerGroup}`,
            topic: "ssh-authority-invalidated",
            payload: { runId: runA.runId, connectionId: hostA.id },
          },
          {
            channel: `runner-group:${runA.runnerGroup}`,
            topic: "ssh-authority-invalidated",
            payload: { runId: runB.runId, connectionId: hostB.id },
          },
        ]),
      );

      const [afterA] = await listHosts(memberA);
      const [afterB] = await listHosts(memberB);
      expect(afterA?.generation).toBe(hostA.generation + 1);
      expect(afterB?.generation).toBe(hostB.generation + 1);

      signIn(memberA);
      await accept(
        hosts().delete({
          headers,
          params: { connectionId: hostA.id },
          body: { expectedGeneration: hostA.generation + 1 },
        }),
        [204],
      );
      signIn(memberB);
      await accept(
        hosts().delete({
          headers,
          params: { connectionId: hostB.id },
          body: { expectedGeneration: hostB.generation + 1 },
        }),
        [204],
      );

      signIn(admin);
      await accept(
        configs().delete({
          headers,
          query: { view: "scoped" },
          params: { configId: shared.id },
          body: { expectedRevision: 2 },
        }),
        [204],
      );
    },
  );
});

describe("protected SSH authority", () => {
  it(
    "cloudflare-access-014 preserves chat host authority across Access config updates",
    { timeout: TEST_WITH_SINGLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
    async () => {
      useSecretKmsProbe();
      const member = await seedWorkspaceMember("org:member");
      const primary = await createConfig(member, "personal");
      const secondary = await createConfig(member, "personal");
      const primaryHost = await bindHost(member, primary.id);
      await bindHost(member, secondary.id);
      await enableSshDefault(member, primaryHost.id);
      const run = await launchActorRun(member);

      signIn(member);
      const renamed = await accept(
        configs().update({
          headers,
          query: { view: "scoped" },
          params: { configId: primary.id },
          body: { expectedRevision: 1, name: "Renamed primary" },
        }),
        [200],
      );
      expect(renamed.status).toBe(200);
      const afterRename = await accept(
        runnerSsh().resolve({
          headers: runnerHeaders(),
          params: { runId: run.runId },
          body: {
            connectionId: primaryHost.id,
            runnerIdentity: run.runnerIdentity,
          },
        }),
        [200],
      );
      expect(afterRename.body.outcome).toBe("resolved_access");

      signIn(member);
      const rotatedCreds = accessCredentials();
      const rotated = await accept(
        configs().update({
          headers,
          query: { view: "scoped" },
          params: { configId: primary.id },
          body: { expectedRevision: 2, credentials: rotatedCreds },
        }),
        [200],
      );
      expect(rotated.status).toBe(200);
      const afterRotate = await accept(
        runnerSsh().resolve({
          headers: runnerHeaders(),
          params: { runId: run.runId },
          body: {
            connectionId: primaryHost.id,
            runnerIdentity: run.runnerIdentity,
          },
        }),
        [200],
      );
      expect(afterRotate.body).toMatchObject({
        outcome: "resolved_access",
        access: {
          configId: primary.id,
          generation: 2,
          clientId: rotatedCreds.clientId,
          clientSecret: rotatedCreds.clientSecret,
        },
      });
    },
  );

  it(
    "cloudflare-access-015 treats a protected host awaiting rebind as unavailable, never Direct",
    { timeout: TEST_WITH_SINGLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
    async () => {
      const kms = useSecretKmsProbe();
      const admin = await seedWorkspaceMember("org:admin");
      const member = await seedWorkspaceMember("org:member", admin.orgId);
      const sharedCreds = accessCredentials();
      signIn(admin);
      const shared = (
        await accept(
          configs().create({
            headers,
            query: { view: "scoped" },
            body: {
              id: randomUUID(),
              name: "Shared convert target",
              scope: "organization",
              credentials: sharedCreds,
            },
          }),
          [201],
        )
      ).body;

      const protectedHost = await bindHost(member, shared.id);
      signIn(member);
      const directHost = (
        await accept(
          hosts().create({
            headers,
            body: {
              ...hostFields(),
              port: 22,
              credential: inlinePassword("direct"),
              transport: { type: "direct" },
            },
          }),
          [201],
        )
      ).body;
      await enableSshDefault(member, protectedHost.id);
      await enableSshDefault(member, directHost.id);
      const run = await launchActorRun(member);

      const initialResolve = await accept(
        runnerSsh().resolve({
          headers: runnerHeaders(),
          params: { runId: run.runId },
          body: {
            connectionId: protectedHost.id,
            runnerIdentity: run.runnerIdentity,
          },
        }),
        [200],
      );
      expect(initialResolve.body.outcome).toBe("resolved_access");

      signIn(admin);
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
      expect(preview.otherHostCount).toBe(1);
      await accept(
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

      const memberHosts = await listHosts(member);
      const detached = memberHosts.find((entry) => {
        return entry.id === protectedHost.id;
      });
      expect(detached).toMatchObject({
        id: protectedHost.id,
        generation: protectedHost.generation + 1,
        transport: { type: "cloudflare_access", needsRebind: true },
      });

      const decryptsBefore = kms.decryptCalls;
      const [resolved, pinned, observed] = await Promise.all([
        accept(
          runnerSsh().resolve({
            headers: runnerHeaders(),
            params: { runId: run.runId },
            body: {
              connectionId: protectedHost.id,
              runnerIdentity: run.runnerIdentity,
            },
          }),
          [200],
        ),
        accept(
          runnerSsh().pin({
            headers: runnerHeaders(),
            params: { runId: run.runId },
            body: {
              connectionId: protectedHost.id,
              runnerIdentity: run.runnerIdentity,
              expectedGeneration: protectedHost.generation + 1,
              observedHostKey: hostKeyFor(`ca-015-${protectedHost.id}`),
            },
          }),
          [200],
        ),
        accept(
          runnerSsh().observe({
            headers: runnerHeaders(),
            params: { runId: run.runId },
            body: {
              connectionId: protectedHost.id,
              runnerIdentity: run.runnerIdentity,
              expectedGeneration: protectedHost.generation + 1,
              expectedCreatedAt: protectedHost.createdAt,
              observedAt: nowDate().toISOString(),
              failureReason: null,
            },
          }),
          [200],
        ),
      ]);
      expect(resolved.body).toStrictEqual({ outcome: "unavailable" });
      expect(pinned.body).toStrictEqual({ outcome: "unavailable" });
      expect(observed.body).toStrictEqual({ outcome: "unavailable" });
      expect(kms.decryptCalls).toBe(decryptsBefore);

      const inventoryBefore = await accept(
        sshHosts().list({ headers: run.agentHeaders }),
        [200],
      );
      expect(inventoryBefore.body.hosts).toStrictEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: directHost.id,
            availability: { status: "ready" },
          }),
          expect.objectContaining({
            id: protectedHost.id,
            availability: { status: "blocked", reason: "needs_rebind" },
          }),
        ]),
      );
      expect(JSON.stringify(inventoryBefore.body)).not.toContain(
        sharedCreds.clientSecret,
      );

      signIn(member);
      await accept(
        hosts().delete({
          headers,
          params: { connectionId: directHost.id },
          body: { expectedGeneration: directHost.generation },
        }),
        [204],
      );
      const inventoryAfter = await accept(
        sshHosts().list({ headers: run.agentHeaders }),
        [200],
      );
      expect(inventoryAfter.body.hosts).toStrictEqual([
        expect.objectContaining({
          id: protectedHost.id,
          availability: { status: "blocked", reason: "needs_rebind" },
        }),
      ]);
      expect(kms.decryptCalls).toBe(decryptsBefore);
    },
  );

  it(
    "cloudflare-access-016 resolves a same-organization shared Access row for another member",
    { timeout: TEST_WITH_SINGLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
    async () => {
      useSecretKmsProbe();
      const admin = await seedWorkspaceMember("org:admin");
      const member = await seedWorkspaceMember("org:member", admin.orgId);
      const shared = await createConfig(admin, "organization");
      const host = await bindHost(member, shared.id);
      await enableSshDefault(member, host.id);
      const run = await launchActorRun(member, {
        runnerIdentity: {
          runnerId: randomUUID(),
          heartbeatGeneration: 2,
        },
      });

      const [resolved, inventory] = await Promise.all([
        accept(
          runnerSsh().resolve({
            headers: runnerHeaders(),
            params: { runId: run.runId },
            body: {
              connectionId: host.id,
              runnerIdentity: run.runnerIdentity,
            },
          }),
          [200],
        ),
        accept(sshHosts().list({ headers: run.agentHeaders }), [200]),
      ]);
      expect(resolved.body).toMatchObject({
        outcome: "resolved_access",
        access: expect.objectContaining({ configId: shared.id }),
      });
      expect(inventory.body.hosts).toStrictEqual([
        expect.objectContaining({ id: host.id }),
      ]);
    },
  );

  it(
    "cloudflare-access-017 uses chat-enabled protected hosts for a later Agent",
    { timeout: TEST_WITH_DOUBLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
    async () => {
      useSecretKmsProbe();
      const member = await seedWorkspaceMember("org:member");
      const personal = await createConfig(member, "personal");
      const host = await bindHost(member, personal.id);
      await enableSshDefault(member, host.id);

      const firstRun = await launchActorRun(member, { grantTeam: true });
      const laterRun = await launchActorRun(member, {
        runnerGroup: firstRun.runnerGroup,
        bootstrapOrg: false,
      });

      const [resolved, inventory] = await Promise.all([
        accept(
          runnerSsh().resolve({
            headers: runnerHeaders(),
            params: { runId: laterRun.runId },
            body: {
              connectionId: host.id,
              runnerIdentity: laterRun.runnerIdentity,
            },
          }),
          [200],
        ),
        accept(sshHosts().list({ headers: laterRun.agentHeaders }), [200]),
      ]);
      expect(resolved.body).toMatchObject({
        outcome: "resolved_access",
        access: expect.objectContaining({ configId: personal.id }),
      });
      expect(inventory.body.hosts).toStrictEqual([
        expect.objectContaining({ id: host.id }),
      ]);
    },
  );

  it(
    "cloudflare-access-018 uses only the Run owner's protected hosts across members of the same workspace",
    { timeout: TEST_WITH_DOUBLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
    async () => {
      useSecretKmsProbe();
      const firstMember = await seedWorkspaceMember("org:admin");
      const secondMember = await seedWorkspaceMember(
        "org:member",
        firstMember.orgId,
      );
      const firstConfig = await createConfig(firstMember, "personal");
      const secondConfig = await createConfig(secondMember, "personal");
      const firstHost = await bindHost(firstMember, firstConfig.id);
      const secondHost = await bindHost(secondMember, secondConfig.id);
      await enableSshDefault(secondMember, secondHost.id);

      const firstRun = await launchActorRun(firstMember, { grantTeam: true });
      const secondRun = await launchActorRun(secondMember, {
        runnerGroup: firstRun.runnerGroup,
        bootstrapOrg: false,
      });

      const [ownResolve, foreignResolve, inventory] = await Promise.all([
        accept(
          runnerSsh().resolve({
            headers: runnerHeaders(),
            params: { runId: secondRun.runId },
            body: {
              connectionId: secondHost.id,
              runnerIdentity: secondRun.runnerIdentity,
            },
          }),
          [200],
        ),
        accept(
          runnerSsh().resolve({
            headers: runnerHeaders(),
            params: { runId: secondRun.runId },
            body: {
              connectionId: firstHost.id,
              runnerIdentity: secondRun.runnerIdentity,
            },
          }),
          [200],
        ),
        accept(sshHosts().list({ headers: secondRun.agentHeaders }), [200]),
      ]);
      expect(ownResolve.body).toMatchObject({
        outcome: "resolved_access",
        access: expect.objectContaining({ configId: secondConfig.id }),
      });
      expect(foreignResolve.body).toStrictEqual({ outcome: "unavailable" });
      expect(inventory.body.hosts).toStrictEqual([
        expect.objectContaining({ id: secondHost.id }),
      ]);

      const [resolvedAgain, pinned] = await Promise.all([
        accept(
          runnerSsh().resolve({
            headers: runnerHeaders(),
            params: { runId: secondRun.runId },
            body: {
              connectionId: secondHost.id,
              runnerIdentity: secondRun.runnerIdentity,
            },
          }),
          [200],
        ),
        accept(
          runnerSsh().pin({
            headers: runnerHeaders(),
            params: { runId: secondRun.runId },
            body: {
              connectionId: secondHost.id,
              runnerIdentity: secondRun.runnerIdentity,
              expectedGeneration: secondHost.generation,
              observedHostKey: hostKeyFor(`ca-018-${secondHost.id}`),
            },
          }),
          [200],
        ),
      ]);
      expect(resolvedAgain.body.outcome).toBe("resolved_access");
      expect(pinned.body).toStrictEqual({
        outcome: "pinned",
        generation: secondHost.generation + 1,
      });
    },
  );

  it(
    "cloudflare-access-019 preserves key authentication separately from the Access token",
    { timeout: TEST_WITH_SINGLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
    async () => {
      useSecretKmsProbe();
      const member = await seedWorkspaceMember("org:member");
      const creds = accessCredentials();
      signIn(member);
      const personal = (
        await accept(
          configs().create({
            headers,
            query: { view: "scoped" },
            body: {
              id: randomUUID(),
              name: "Key auth Access",
              scope: "personal",
              credentials: creds,
            },
          }),
          [201],
        )
      ).body;
      const host = await bindHost(member, personal.id);
      await enableSshDefault(member, host.id);
      const run = await launchActorRun(member, {
        runnerIdentity: {
          runnerId: randomUUID(),
          heartbeatGeneration: 2,
        },
      });

      const privateKey = `-----BEGIN OPENSSH PRIVATE KEY-----\nkey-${randomUUID()}\n-----END OPENSSH PRIVATE KEY-----`;
      const passphrase = "  padded-passphrase-value  \n";
      signIn(member);
      const updated = await accept(
        hosts().update({
          headers,
          params: { connectionId: host.id },
          body: {
            expectedGeneration: host.generation,
            credential: {
              create: {
                name: "Inline key login",
                username: "keyops",
                authentication: {
                  method: "private_key",
                  privateKey,
                  passphrase,
                },
              },
            },
          },
        }),
        [200],
      );
      expect(updated.status).toBe(200);

      const resolved = await accept(
        runnerSsh().resolve({
          headers: runnerHeaders(),
          params: { runId: run.runId },
          body: {
            connectionId: host.id,
            runnerIdentity: run.runnerIdentity,
          },
        }),
        [200],
      );
      expect(resolved.body).toMatchObject({
        outcome: "resolved_access",
        username: "keyops",
        authentication: {
          method: "private_key",
          privateKey,
          passphrase,
        },
        access: {
          configId: personal.id,
          generation: 1,
          clientId: creds.clientId,
          clientSecret: creds.clientSecret,
        },
      });
    },
  );

  it(
    "cloudflare-access-024 hands off two independent credentials only to the winning Runner",
    { timeout: TEST_WITH_SINGLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
    async () => {
      useSecretKmsProbe();
      const member = await seedWorkspaceMember("org:member");
      const creds = accessCredentials();
      signIn(member);
      const personal = (
        await accept(
          configs().create({
            headers,
            query: { view: "scoped" },
            body: {
              id: randomUUID(),
              name: "Winning runner Access",
              scope: "personal",
              credentials: creds,
            },
          }),
          [201],
        )
      ).body;
      const password = `pw-${randomUUID()}`;
      const host = (
        await accept(
          hosts().create({
            headers,
            body: {
              ...hostFields(),
              credential: {
                create: {
                  name: "Deploy password",
                  username: "deploy",
                  authentication: { method: "password", password },
                },
              },
              transport: { type: "cloudflare_access", configId: personal.id },
            },
          }),
          [201],
        )
      ).body;
      await enableSshDefault(member, host.id);
      const run = await launchActorRun(member, {
        runnerIdentity: {
          runnerId: randomUUID(),
          heartbeatGeneration: 2,
        },
      });

      signIn(member);
      const [
        winning,
        otherRunner,
        olderHeartbeat,
        memberSession,
        agentTokenAttempt,
        inventory,
      ] = await Promise.all([
        accept(
          runnerSsh().resolve({
            headers: runnerHeaders(),
            params: { runId: run.runId },
            body: {
              connectionId: host.id,
              runnerIdentity: run.runnerIdentity,
            },
          }),
          [200],
        ),
        accept(
          runnerSsh().resolve({
            headers: runnerHeaders(),
            params: { runId: run.runId },
            body: {
              connectionId: host.id,
              runnerIdentity: {
                runnerId: randomUUID(),
                heartbeatGeneration: run.runnerIdentity.heartbeatGeneration,
              },
            },
          }),
          [200],
        ),
        accept(
          runnerSsh().resolve({
            headers: runnerHeaders(),
            params: { runId: run.runId },
            body: {
              connectionId: host.id,
              runnerIdentity: {
                runnerId: run.runnerIdentity.runnerId,
                heartbeatGeneration: run.runnerIdentity.heartbeatGeneration - 1,
              },
            },
          }),
          [200],
        ),
        accept(
          runnerSsh().resolve({
            headers,
            params: { runId: run.runId },
            body: {
              connectionId: host.id,
              runnerIdentity: run.runnerIdentity,
            },
          }),
          [401],
        ),
        accept(
          runnerSsh().resolve({
            headers: run.agentHeaders,
            params: { runId: run.runId },
            body: {
              connectionId: host.id,
              runnerIdentity: run.runnerIdentity,
            },
          }),
          [401],
        ),
        accept(sshHosts().list({ headers: run.agentHeaders }), [200]),
      ]);

      expect(winning.body).toMatchObject({
        outcome: "resolved_access",
        port: 443,
        generation: 1,
        username: "deploy",
        authentication: { method: "password", password },
        access: {
          configId: personal.id,
          generation: 1,
          clientId: creds.clientId,
          clientSecret: creds.clientSecret,
        },
      });
      expect(otherRunner.body).toStrictEqual({ outcome: "unavailable" });
      expect(olderHeartbeat.body).toStrictEqual({ outcome: "unavailable" });
      expect(memberSession.status).toBe(401);
      expect(agentTokenAttempt.status).toBe(401);
      expect(inventory.body.hosts).toStrictEqual([
        expect.objectContaining({
          id: host.id,
          port: 443,
          username: "deploy",
          learnedHostKey: null,
          availability: { status: "ready" },
        }),
      ]);
    },
  );

  it(
    "cloudflare-access-028 preserves precise Access-stage evidence instead of misclassifying SSH authentication",
    { timeout: TEST_WITH_SINGLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
    async () => {
      useSecretKmsProbe();
      const member = await seedWorkspaceMember("org:member");
      const personal = await createConfig(member, "personal");
      const host = await bindHost(member, personal.id);
      await enableSshDefault(member, host.id);
      const run = await launchActorRun(member, {
        runnerIdentity: {
          runnerId: randomUUID(),
          heartbeatGeneration: 2,
        },
      });

      const observed = await accept(
        runnerSsh().observe({
          headers: runnerHeaders(),
          params: { runId: run.runId },
          body: {
            connectionId: host.id,
            runnerIdentity: run.runnerIdentity,
            expectedGeneration: host.generation,
            expectedCreatedAt: host.createdAt,
            observedAt: nowDate().toISOString(),
            failureReason: "access_rejected",
          },
        }),
        [200],
      );
      expect(observed.body).toStrictEqual({ outcome: "recorded" });

      signIn(member);
      const listed = (await accept(hosts().observations({ headers }), [200]))
        .body.observations;
      expect(listed[0]).toMatchObject({
        connectionId: host.id,
        failureReason: "access_rejected",
      });
    },
  );
});
