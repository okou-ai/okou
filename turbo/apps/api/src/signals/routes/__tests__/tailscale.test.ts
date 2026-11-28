import { createHash, randomUUID } from "node:crypto";
import { chatRemoteAccessContract } from "@okouai/api-contracts/contracts/chat-remote-access";
import { runnerSshContract } from "@okouai/api-contracts/contracts/runner-ssh";
import { sshConnectionsContract } from "@okouai/api-contracts/contracts/ssh-connections";
import { sshCredentialsContract } from "@okouai/api-contracts/contracts/ssh-credentials";
import { tailscaleContract } from "@okouai/api-contracts/contracts/tailscale";
import { createStore } from "ccstate";
import { beforeAll, describe, expect, it } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp, setupRawAppRequest } from "../../../__tests__/test-helpers";
import {
  TEST_WITH_DOUBLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE,
  TEST_WITH_SINGLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE,
} from "../../../__tests__/test-timeouts";
import { env, mockOptionalEnv } from "../../../lib/env";
import { nowDate } from "../../../lib/time";
import { createDeferredPromise } from "../../utils";
import { chatRemoteAccessRoutes } from "../chat-remote-access";
import { runnerSshRoutes } from "../runner-ssh";
import { sshConnectionsRoutes } from "../ssh-connections";
import { tailscaleRoutes } from "../tailscale";
import { createBddApi, type ApiTestUser } from "./helpers/api-bdd";
import { createRunsApi } from "./helpers/api-bdd-runs";
import { createChatEventsFixture } from "./helpers/chat-events-fixture";
import { seedOrgMembership$ } from "./helpers/org-membership";
import { publicRunOwner } from "./helpers/public-run-owner";
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
const remoteAccess = () => {
  return setupApp({ context, routes: chatRemoteAccessRoutes })(
    chatRemoteAccessContract,
  );
};
const runnerSsh = () => {
  return setupApp({ context, routes: runnerSshRoutes })(runnerSshContract);
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

function pinnedGeneration(body: {
  readonly outcome: string;
  readonly generation?: number;
}): number {
  if (body.outcome !== "pinned" || typeof body.generation !== "number") {
    throw new Error(`Expected pinned outcome, received ${body.outcome}`);
  }
  return body.generation;
}

async function launchMemberRun(actor: Actor) {
  const fixture = createChatEventsFixture(context);
  const bdd = createBddApi(context);
  const runs = createRunsApi(context);
  const apiUser: ApiTestUser = bdd.user({
    userId: actor.userId,
    orgId: actor.orgId,
    orgRole: actor.role === "admin" ? "org:admin" : "org:member",
  });
  const owner = publicRunOwner(context, apiUser);
  fixture.chatCallbacks.acceptChatObjectStorage();
  runs.acceptStorageDownloads();
  runs.acceptTelemetryIngest();
  mockOptionalEnv("OPENROUTER_API_KEY", undefined);
  fixture.chatCallbacks.disableVapid();

  await Promise.all([
    runs.configureRunnerGroup(),
    owner.run(() => {
      return bdd.bootstrapLimitedFreeOnboarding(apiUser);
    }),
  ]);
  const launched = await owner.run(() => {
    return fixture.sendChatRun(apiUser, {
      prompt: "Connect to my Tailscale SSH host",
      model: null,
    });
  });
  await owner.executionInput(launched.runId);
  const dispatched = runs.dispatchedRun(launched.runId);
  return {
    runId: launched.runId,
    threadId: launched.threadId,
    runnerIdentity: {
      runnerId: dispatched.runnerId,
      heartbeatGeneration: dispatched.heartbeatGeneration,
    },
  };
}

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
  beforeAll(() => {
    setupApp({
      context,
      routes: [
        ...tailscaleRoutes,
        ...sshConnectionsRoutes,
        ...chatRemoteAccessRoutes,
        ...runnerSshRoutes,
      ],
    });
  });

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

  it(
    "tailscale-002 resolves only authorized Tailscale SSH identity and preserves pin/config-generation fences",
    { timeout: TEST_WITH_DOUBLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
    async () => {
      useSecretKmsProbe();
      const actor = await member();
      signIn(actor);
      const credentials = oauthClient();
      const config = (
        await accept(
          tailscale().create({
            headers,
            body: {
              id: randomUUID(),
              name: "Identity tailnet",
              credentials,
              tags: ["tag:okou"],
            },
          }),
          [201],
        )
      ).body;
      const host = (
        await accept(
          hosts().create({
            headers,
            body: {
              id: randomUUID(),
              displayName: "Tailscale SSH node",
              host: "peer",
              port: 22,
              username: "test-user",
              transport: { type: "tailscale_ssh", configId: config.id },
            },
          }),
          [201],
        )
      ).body;

      const run = await launchMemberRun(actor);

      const beforeEnable = await accept(
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
      expect(beforeEnable.body).toStrictEqual({ outcome: "unavailable" });

      signIn(actor);
      await accept(
        remoteAccess().updateHostDefault({
          headers,
          params: { protocol: "ssh", connectionId: host.id },
          body: { enabled: true },
        }),
        [200],
      );

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
        outcome: "resolved_tailscale_ssh",
        host: "peer",
        port: 22,
        username: "test-user",
        generation: host.generation,
        learnedHostKey: null,
        tailscale: {
          configId: config.id,
          generation: 1,
          clientId: credentials.clientId,
          clientSecret: credentials.clientSecret,
          tags: ["tag:okou"],
        },
      });
      expect("authentication" in resolved.body).toBeFalsy();

      const key = hostKeyFor(`ts-002-${host.id}`);
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

      signIn(actor);
      await accept(
        tailscale().update({
          headers,
          params: { configId: config.id },
          body: {
            expectedRevision: config.revision,
            tags: ["tag:next"],
          },
        }),
        [200],
      );

      const resolvedAfterTag = await accept(
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
      expect(resolvedAfterTag.body).toMatchObject({
        outcome: "resolved_tailscale_ssh",
        generation: host.generation + 2,
        learnedHostKey: key,
        tailscale: {
          configId: config.id,
          generation: 2,
          tags: ["tag:next"],
        },
      });

      signIn(actor);
      const reset = (
        await accept(
          hosts().resetHostKey({
            headers,
            params: { connectionId: host.id },
            body: { expectedGeneration: host.generation + 2 },
          }),
          [200],
        )
      ).body;
      expect(reset.learnedHostKey).toBeNull();
      expect("credentialId" in reset).toBeFalsy();
      expect((await inventory()).logins).toStrictEqual([]);
    },
  );

  it(
    "tailscale-026 uses current winning process/host/chat/config authority and the shared host generation fence without a backend rollout flag",
    { timeout: TEST_WITH_SINGLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
    async () => {
      const kms = useSecretKmsProbe();
      const actor = await member();
      signIn(actor);
      const credentials = oauthClient();
      const config = (
        await accept(
          tailscale().create({
            headers,
            body: {
              id: randomUUID(),
              name: "Authority tailnet",
              credentials,
              tags: ["tag:okou"],
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
              id: randomUUID(),
              displayName: "Authority box",
              host: "100.64.0.26",
              port: 2222,
              credential: {
                create: {
                  name: "Authority login",
                  username: "ops",
                  authentication: { method: "password", password },
                },
              },
              transport: { type: "tailscale", configId: config.id },
            },
          }),
          [201],
        )
      ).body;

      const run = await launchMemberRun(actor);

      const decryptsBeforeDisabled = kms.decryptCalls;
      const beforeEnable = await accept(
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
      expect(beforeEnable.body).toStrictEqual({ outcome: "unavailable" });
      expect(kms.decryptCalls).toBe(decryptsBeforeDisabled);

      signIn(actor);
      await accept(
        remoteAccess().updateHostDefault({
          headers,
          params: { protocol: "ssh", connectionId: host.id },
          body: { enabled: true },
        }),
        [200],
      );

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
        outcome: "resolved_tailscale",
        host: "100.64.0.26",
        port: 2222,
        username: "ops",
        generation: host.generation,
        authentication: { method: "password", password },
        tailscale: {
          configId: config.id,
          generation: 1,
          clientId: credentials.clientId,
          clientSecret: credentials.clientSecret,
          tags: ["tag:okou"],
        },
      });

      const decryptsBeforeInvalid = kms.decryptCalls;
      signIn(actor);
      const [unknownConn, otherRunner, newerGen, memberAuth] =
        await Promise.all([
          accept(
            runnerSsh().resolve({
              headers: runnerHeaders(),
              params: { runId: run.runId },
              body: {
                connectionId: randomUUID(),
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
                  heartbeatGeneration:
                    run.runnerIdentity.heartbeatGeneration + 1,
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
        ]);
      expect(unknownConn.body).toStrictEqual({ outcome: "unavailable" });
      expect(otherRunner.body).toStrictEqual({ outcome: "unavailable" });
      expect(newerGen.body).toStrictEqual({ outcome: "unavailable" });
      expect(memberAuth.status).toBe(401);
      expect(kms.decryptCalls).toBe(decryptsBeforeInvalid);

      const key = hostKeyFor(`ts-026-${host.id}`);
      const wrongPin = await accept(
        runnerSsh().pin({
          headers: runnerHeaders(),
          params: { runId: run.runId },
          body: {
            connectionId: host.id,
            runnerIdentity: run.runnerIdentity,
            expectedGeneration: host.generation + 10,
            observedHostKey: key,
          },
        }),
        [200],
      );
      expect(wrongPin.body).toStrictEqual({
        outcome: "configuration_changed",
      });

      const rightPin = await accept(
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
      const pinnedGen = pinnedGeneration(rightPin.body);
      expect(pinnedGen).toBe(host.generation + 1);

      const firstObservation = await accept(
        runnerSsh().observe({
          headers: runnerHeaders(),
          params: { runId: run.runId },
          body: {
            connectionId: host.id,
            runnerIdentity: run.runnerIdentity,
            expectedGeneration: pinnedGen,
            expectedCreatedAt: host.createdAt,
            observedAt: nowDate().toISOString(),
            failureReason: null,
          },
        }),
        [200],
      );
      expect(firstObservation.body).toStrictEqual({ outcome: "recorded" });

      signIn(actor);
      const observationsBeforeTag = (
        await accept(hosts().observations({ headers }), [200])
      ).body.observations;
      expect(observationsBeforeTag).toHaveLength(1);
      expect(observationsBeforeTag[0]?.connectionId).toBe(host.id);

      const updatedConfig = (
        await accept(
          tailscale().update({
            headers,
            params: { configId: config.id },
            body: {
              expectedRevision: config.revision,
              tags: ["tag:next"],
            },
          }),
          [200],
        )
      ).body;
      expect(updatedConfig.generation).toBe(2);

      const [storedHost] = (await inventory()).hosts;
      expect(storedHost).toMatchObject({
        id: host.id,
        generation: host.generation + 2,
        learnedHostKey: key,
      });
      const observationsAfterTag = (
        await accept(hosts().observations({ headers }), [200])
      ).body.observations;
      expect(observationsAfterTag).toStrictEqual([]);

      const [stalePin, staleObservation, refreshedResolve] = await Promise.all([
        accept(
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
        ),
        accept(
          runnerSsh().observe({
            headers: runnerHeaders(),
            params: { runId: run.runId },
            body: {
              connectionId: host.id,
              runnerIdentity: run.runnerIdentity,
              expectedGeneration: pinnedGen,
              expectedCreatedAt: host.createdAt,
              observedAt: nowDate().toISOString(),
              failureReason: null,
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
              runnerIdentity: run.runnerIdentity,
            },
          }),
          [200],
        ),
      ]);
      expect(stalePin.body).toStrictEqual({
        outcome: "configuration_changed",
      });
      expect(staleObservation.body).toStrictEqual({ outcome: "ignored" });
      expect(refreshedResolve.body).toMatchObject({
        outcome: "resolved_tailscale",
        generation: host.generation + 2,
        tailscale: expect.objectContaining({
          generation: 2,
          tags: ["tag:next"],
        }),
      });

      signIn(actor);
      await accept(
        remoteAccess().setThreadOverride({
          headers,
          params: {
            threadId: run.threadId,
            protocol: "ssh",
            connectionId: host.id,
          },
          body: { enabled: false },
        }),
        [200],
      );
      const decryptsBeforeRevoked = kms.decryptCalls;
      const revokedResolve = await accept(
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
      expect(revokedResolve.body).toStrictEqual({ outcome: "unavailable" });
      expect(kms.decryptCalls).toBe(decryptsBeforeRevoked);

      signIn(actor);
      await accept(
        remoteAccess().clearThreadOverride({
          headers,
          params: {
            threadId: run.threadId,
            protocol: "ssh",
            connectionId: host.id,
          },
        }),
        [200],
      );
      const restoredResolve = await accept(
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
      expect(restoredResolve.body).toMatchObject({
        outcome: "resolved_tailscale",
        tailscale: expect.objectContaining({
          generation: 2,
          tags: ["tag:next"],
        }),
      });
    },
  );

  async function verifyPrivateKeyJitRevocation(passphrase: string | null) {
    const hold: { callNumber: number | undefined } = {
      callNumber: undefined,
    };
    const entered = createDeferredPromise<void>(context.signal);
    const released = createDeferredPromise<void>(context.signal);
    const kms = useSecretKmsProbe(undefined, (_request, callNumber) => {
      if (callNumber !== hold.callNumber) {
        return undefined;
      }
      return (async () => {
        entered.resolve();
        await released.promise;
        return Buffer.from("0123456789abcdef0123456789abcdef", "utf8");
      })();
    });

    const actor = await member();
    signIn(actor);
    const credentials = oauthClient();
    const config = (
      await accept(
        tailscale().create({
          headers,
          body: {
            id: randomUUID(),
            name: "Private key tailnet",
            credentials,
            tags: ["tag:okou"],
          },
        }),
        [201],
      )
    ).body;
    const privateKey = `-----BEGIN OPENSSH PRIVATE KEY-----\nkey-${randomUUID()}\n-----END OPENSSH PRIVATE KEY-----`;
    const host = (
      await accept(
        hosts().create({
          headers,
          body: {
            id: randomUUID(),
            displayName: "Key peer",
            host: "peer",
            port: 2222,
            credential: {
              create: {
                name: "Key login",
                username: "key-user",
                authentication: {
                  method: "private_key",
                  privateKey,
                  passphrase,
                },
              },
            },
            transport: { type: "tailscale", configId: config.id },
          },
        }),
        [201],
      )
    ).body;
    await accept(
      remoteAccess().updateHostDefault({
        headers,
        params: { protocol: "ssh", connectionId: host.id },
        body: { enabled: true },
      }),
      [200],
    );
    const run = await launchMemberRun(actor);

    signIn(actor);
    const listed = await inventory();
    const serializedInventory = JSON.stringify(listed);
    expect(serializedInventory).not.toContain(credentials.clientId);
    expect(serializedInventory).not.toContain(credentials.clientSecret);
    expect(serializedInventory).not.toContain(privateKey);
    if (passphrase !== null) {
      expect(serializedInventory).not.toContain(passphrase);
    }

    const decryptsBeforeFirst = kms.decryptCalls;
    const firstResolve = await accept(
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
    const decryptsPerResolve = kms.decryptCalls - decryptsBeforeFirst;
    expect(decryptsPerResolve).toBeGreaterThan(0);
    expect(firstResolve.body).toStrictEqual({
      outcome: "resolved_tailscale",
      host: "peer",
      port: 2222,
      username: "key-user",
      generation: host.generation,
      learnedHostKey: null,
      authentication: {
        method: "private_key",
        privateKey,
        passphrase,
      },
      tailscale: {
        configId: config.id,
        generation: 1,
        clientId: credentials.clientId,
        clientSecret: credentials.clientSecret,
        tags: ["tag:okou"],
      },
    });

    hold.callNumber = kms.decryptCalls + decryptsPerResolve;
    const secondResolvePromise = accept(
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
    await entered.promise;
    signIn(actor);
    await accept(
      remoteAccess().setThreadOverride({
        headers,
        params: {
          threadId: run.threadId,
          protocol: "ssh",
          connectionId: host.id,
        },
        body: { enabled: false },
      }),
      [200],
    );
    released.resolve();
    const secondResolve = await secondResolvePromise;
    expect(secondResolve.body).toStrictEqual(firstResolve.body);

    const decryptsBeforeThird = kms.decryptCalls;
    const thirdResolve = await accept(
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
    expect(kms.decryptCalls).toBe(decryptsBeforeThird);
    return {
      first: firstResolve.body,
      second: secondResolve.body,
      third: thirdResolve.body,
    };
  }

  it(
    "tailscale-029 protects private-key JIT with passphrase null using the admitted snapshot, then denies fresh resolution after revocation",
    { timeout: TEST_WITH_SINGLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
    async () => {
      const outcome = await verifyPrivateKeyJitRevocation(null);
      expect(outcome.second).toStrictEqual(outcome.first);
      expect(outcome.third).toStrictEqual({ outcome: "unavailable" });
    },
  );

  it(
    "tailscale-030 protects private-key JIT with a canary passphrase using the admitted snapshot, then denies fresh resolution after revocation",
    { timeout: TEST_WITH_SINGLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
    async () => {
      const outcome = await verifyPrivateKeyJitRevocation(
        " private-passphrase-canary\n",
      );
      expect(outcome.second).toStrictEqual(outcome.first);
      expect(outcome.third).toStrictEqual({ outcome: "unavailable" });
    },
  );
});
