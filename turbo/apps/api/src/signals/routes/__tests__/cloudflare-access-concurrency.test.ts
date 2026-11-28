import { createHash, randomUUID } from "node:crypto";

import { chatRemoteAccessContract } from "@okouai/api-contracts/contracts/chat-remote-access";
import { cloudflareAccessContract } from "@okouai/api-contracts/contracts/cloudflare-access";
import { runnerSshContract } from "@okouai/api-contracts/contracts/runner-ssh";
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
import { sshConnectionsRoutes } from "../ssh-connections";
import { createBddApi, type ApiTestUser } from "./helpers/api-bdd";
import { createRunsApi } from "./helpers/api-bdd-runs";
import { createChatEventsFixture } from "./helpers/chat-events-fixture";
import { seedOrgMembership$ } from "./helpers/org-membership";
import { publicRunOwner } from "./helpers/public-run-owner";
import { useSecretKmsProbe } from "./helpers/secret-kms-probe";
import { inlineSshKey, sshCredentialId } from "./helpers/ssh-credential";

const context = testContext();
const clerkDirectory = createStore();

interface Actor {
  readonly userId: string;
  readonly orgId: string;
  readonly role: "org:admin" | "org:member";
}

function headersOf(actor: Actor) {
  return { authorization: `Bearer clerk-session-${actor.userId}` };
}

/**
 * Clerk resolves each bearer session to the identity it was issued for. Each
 * sign-in adds its session in front of the ones the case already issued; the
 * shared mocks are reset between cases.
 */
function signedIn(role: Actor["role"], orgId = `org_${randomUUID()}`): Actor {
  const actor = { userId: `user_${randomUUID()}`, orgId, role };
  const authorization = headersOf(actor).authorization;
  const issued =
    context.mocks.clerk.authenticateRequest.getMockImplementation();
  context.mocks.clerk.authenticateRequest.mockImplementation(
    (request: unknown) => {
      const header =
        request instanceof Request
          ? (request.headers.get("authorization") ?? "")
          : "";
      if (header === authorization) {
        return Promise.resolve({
          isAuthenticated: true,
          toAuth: () => {
            return {
              userId: actor.userId,
              orgId: actor.orgId,
              orgRole: actor.role,
            };
          },
        });
      }
      if (issued) {
        return issued(request);
      }
      return Promise.resolve({
        isAuthenticated: false,
        toAuth: () => {
          return null;
        },
      });
    },
  );
  return actor;
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

function registerActorSession(actor: Actor): Actor {
  const authorization = headersOf(actor).authorization;
  const issued =
    context.mocks.clerk.authenticateRequest.getMockImplementation();
  context.mocks.clerk.authenticateRequest.mockImplementation(
    (request: unknown) => {
      const header =
        request instanceof Request
          ? (request.headers.get("authorization") ?? "")
          : "";
      if (header === authorization) {
        return Promise.resolve({
          isAuthenticated: true,
          toAuth: () => {
            return {
              userId: actor.userId,
              orgId: actor.orgId,
              orgRole: actor.role,
            };
          },
        });
      }
      if (issued) {
        return issued(request);
      }
      return Promise.resolve({
        isAuthenticated: false,
        toAuth: () => {
          return null;
        },
      });
    },
  );
  return actor;
}

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

function clearRealtimePublications() {
  context.mocks.ably.channelGet.mockClear();
  context.mocks.ably.publish.mockClear();
}

async function seedActor(role: Actor["role"], orgId = `org_${randomUUID()}`) {
  const actor: Actor = { userId: `user_${randomUUID()}`, orgId, role };
  await clerkDirectory.set(
    seedOrgMembership$,
    {
      orgId: actor.orgId,
      userId: actor.userId,
      role: role === "org:admin" ? "admin" : "member",
    },
    context.signal,
  );
  return registerActorSession(actor);
}

async function launchOwnerRun(
  ownerActor: Actor,
  extraActors: readonly Actor[] = [],
) {
  const fixture = createChatEventsFixture(context);
  const bdd = createBddApi(context);
  const runs = createRunsApi(context);
  const apiUser: ApiTestUser = bdd.user({
    userId: ownerActor.userId,
    orgId: ownerActor.orgId,
    orgRole: ownerActor.role,
  });
  const owner = publicRunOwner(context, apiUser);
  fixture.chatCallbacks.acceptChatObjectStorage();
  runs.acceptStorageDownloads();
  runs.acceptTelemetryIngest();
  mockOptionalEnv("OPENROUTER_API_KEY", undefined);
  fixture.chatCallbacks.disableVapid();

  const [runnerGroup] = await Promise.all([
    runs.configureRunnerGroup(),
    owner.run(() => {
      return bdd.bootstrapLimitedFreeOnboarding(apiUser);
    }),
  ]);
  const launched = await owner.run(() => {
    return fixture.sendChatRun(apiUser, {
      prompt: "Manage Cloudflare Access SSH host",
      model: null,
    });
  });
  await owner.executionInput(launched.runId);
  const dispatched = runs.dispatchedRun(launched.runId);

  // Re-layer per-actor Bearer headers on top of publicRunOwner's Clerk mock.
  registerActorSession(ownerActor);
  for (const extra of extraActors) {
    registerActorSession(extra);
  }
  await clerkDirectory.set(
    seedOrgMembership$,
    {
      orgId: ownerActor.orgId,
      userId: ownerActor.userId,
      role: ownerActor.role === "org:admin" ? "admin" : "member",
    },
    context.signal,
  );
  for (const extra of extraActors) {
    await clerkDirectory.set(
      seedOrgMembership$,
      {
        orgId: extra.orgId,
        userId: extra.userId,
        role: extra.role === "org:admin" ? "admin" : "member",
      },
      context.signal,
    );
  }

  return {
    runId: launched.runId,
    threadId: launched.threadId,
    runnerGroup,
    runnerIdentity: {
      runnerId: dispatched.runnerId,
      heartbeatGeneration: dispatched.heartbeatGeneration,
    },
  };
}

async function enableSshDefault(actor: Actor, connectionId: string) {
  await accept(
    remoteAccess().updateHostDefault({
      headers: headersOf(actor),
      params: { protocol: "ssh", connectionId },
      body: { enabled: true },
    }),
    [200],
  );
}

async function createPasswordLogin(actor: Actor, password: string) {
  return (
    await accept(
      logins().create({
        headers: headersOf(actor),
        body: {
          id: randomUUID(),
          name: `Login ${randomUUID().slice(0, 8)}`,
          username: "deploy",
          authentication: { method: "password", password },
        },
      }),
      [201],
    )
  ).body;
}

async function createAccessHostWithLogin(
  actor: Actor,
  configId: string | null,
  loginId: string,
) {
  return (
    await accept(
      hosts().create({
        headers: headersOf(actor),
        body: hostBody({ id: loginId }, configId),
      }),
      [201],
    )
  ).body;
}

function configBody(
  id: string,
  scope: "personal" | "organization",
  name = `Access ${randomUUID().slice(0, 8)}`,
) {
  return {
    id,
    name,
    scope,
    credentials: {
      clientId: `client-${randomUUID()}`,
      clientSecret: `secret-${randomUUID()}`,
    },
  };
}

async function createConfig(actor: Actor, scope: "personal" | "organization") {
  const created = await accept(
    configs().create({
      headers: headersOf(actor),
      query: { view: "scoped" },
      body: configBody(randomUUID(), scope),
    }),
    [201],
  );
  return created.body;
}

function hostBody(
  credential: ReturnType<typeof inlineSshKey> | { readonly id: string },
  configId: string | null,
) {
  const id = randomUUID();
  return {
    id,
    displayName: `Host ${id.slice(0, 8)}`,
    host: `ssh-${id.slice(0, 8)}.example.test`,
    port: configId === null ? 22 : 443,
    credential,
    transport:
      configId === null
        ? { type: "direct" as const }
        : { type: "cloudflare_access" as const, configId },
  };
}

async function createHost(actor: Actor, configId: string | null) {
  const created = await accept(
    hosts().create({
      headers: headersOf(actor),
      body: hostBody(inlineSshKey("deploy", `key-${randomUUID()}`), configId),
    }),
    [201],
  );
  return created.body;
}

async function listHosts(actor: Actor) {
  const listed = await accept(
    hosts().list({ headers: headersOf(actor) }),
    [200],
  );
  return listed.body.connections;
}

async function listLogins(actor: Actor) {
  const listed = await accept(
    logins().list({ headers: headersOf(actor) }),
    [200],
  );
  return listed.body.credentials;
}

async function listConfigs(actor: Actor) {
  const listed = await accept(
    configs().list({ headers: headersOf(actor), query: { view: "scoped" } }),
    [200],
  );
  return listed.body.configs;
}

function createRequest(actor: Actor, body: ReturnType<typeof configBody>) {
  return configs().create({
    headers: headersOf(actor),
    query: { view: "scoped" },
    body,
  });
}

async function raceCreates(
  first: Actor,
  second: Actor,
  scope: "personal" | "organization",
) {
  const configId = randomUUID();
  const bodies = new Map([
    [first, configBody(configId, scope, "First Access")],
    [second, configBody(configId, scope, "Second Access")],
  ]);
  const results = await Promise.all(
    [first, second].map(async (actor) => {
      const body = bodies.get(actor);
      if (!body) {
        throw new Error("Expected a prepared configuration body");
      }
      const response = await accept(createRequest(actor, body), [201, 409]);
      return { actor, body, response };
    }),
  );
  const winner = results.find((result) => {
    return result.response.status === 201;
  });
  const loser = results.find((result) => {
    return result.response.status === 409;
  });
  if (!winner || !loser) {
    throw new Error("Expected exactly one winner and one loser");
  }
  return { configId, winner, loser };
}

async function raceCreatesAndReplay(
  first: Actor,
  second: Actor,
  scope: "personal" | "organization",
) {
  const { configId, winner, loser } = await raceCreates(first, second, scope);
  const replay = await accept(createRequest(loser.actor, loser.body), [409]);
  return {
    configId,
    winnerName: winner.body.name,
    observed: {
      loser: loser.response.body,
      replay: replay.body,
      winnerConfigs: await listConfigs(winner.actor),
      loserConfigs: await listConfigs(loser.actor),
    },
  };
}

function expectedRace(
  configId: string,
  winnerName: string,
  scope: "personal" | "organization",
) {
  return {
    loser: {
      error: {
        code: "CLOUDFLARE_ACCESS_RESOURCE_ID_CONFLICT",
        message:
          "This resource ID cannot be used for this Cloudflare Access configuration.",
      },
    },
    replay: { error: { code: "CLOUDFLARE_ACCESS_RESOURCE_ID_CONFLICT" } },
    winnerConfigs: [{ id: configId, name: winnerName, scope }],
    loserConfigs: [],
  };
}

async function raceRenames(admin: Actor, configId: string) {
  const names = ["Renamed Access A", "Renamed Access B"];
  const results = await Promise.all(
    names.map((name) => {
      return accept(
        configs().update({
          headers: headersOf(admin),
          query: { view: "scoped" },
          params: { configId },
          body: { expectedRevision: 1, name },
        }),
        [200, 409],
      );
    }),
  );
  const renamed = results.find((result) => {
    return result.status === 200;
  });
  const conflict = results.find((result) => {
    return result.status === 409;
  });
  if (renamed?.status !== 200 || conflict?.status !== 409) {
    throw new Error("Expected exactly one rename and one revision conflict");
  }
  expect(names).toContain(renamed.body.name);
  expect(conflict.body.error.code).toBe("CLOUDFLARE_ACCESS_REVISION_CONFLICT");
  return renamed.body;
}

describe("Cloudflare Access concurrency", () => {
  beforeAll(() => {
    setupApp({
      context,
      routes: [
        ...cloudflareAccessRoutes,
        ...sshConnectionsRoutes,
        ...chatRemoteAccessRoutes,
        ...runnerSshRoutes,
      ],
    });
  });

  it("cloudflare-access-concurrency-001 competing members of one workspace cannot both own one personal configuration ID", async () => {
    const first = signedIn("org:admin");
    const second = signedIn("org:admin", first.orgId);

    const race = await raceCreatesAndReplay(first, second, "personal");

    expect(race.observed).toMatchObject(
      expectedRace(race.configId, race.winnerName, "personal"),
    );
  });

  it("cloudflare-access-concurrency-002 competing workspaces cannot both own one organization configuration ID", async () => {
    const first = signedIn("org:admin");
    const second = signedIn("org:admin");

    const race = await raceCreatesAndReplay(first, second, "organization");

    expect(race.observed).toMatchObject(
      expectedRace(race.configId, race.winnerName, "organization"),
    );
  });

  it("cloudflare-access-concurrency-004 only one same-revision rename of a personal configuration wins and hosts stay unchanged", async () => {
    const admin = signedIn("org:admin");
    const member = signedIn("org:member", admin.orgId);
    const config = await createConfig(admin, "personal");
    const adminHost = await createHost(admin, config.id);
    await createHost(member, null);
    const [adminHostsBefore, memberHostsBefore, adminLoginsBefore] =
      await Promise.all([
        listHosts(admin),
        listHosts(member),
        listLogins(admin),
      ]);

    const renamed = await raceRenames(admin, config.id);

    expect(renamed).toMatchObject({
      id: config.id,
      revision: config.revision + 1,
      generation: config.generation,
      sshHosts: [{ id: adminHost.id }],
    });
    await expect(listConfigs(admin)).resolves.toStrictEqual([renamed]);
    await expect(listHosts(admin)).resolves.toStrictEqual(adminHostsBefore);
    await expect(listHosts(member)).resolves.toStrictEqual(memberHostsBefore);
    await expect(listLogins(admin)).resolves.toStrictEqual(adminLoginsBefore);
  });

  it("cloudflare-access-concurrency-005 only one same-revision rename of an organization configuration wins and hosts stay unchanged", async () => {
    const admin = signedIn("org:admin");
    const member = signedIn("org:member", admin.orgId);
    const config = await createConfig(admin, "organization");
    const adminHost = await createHost(admin, config.id);
    await createHost(member, config.id);
    const [adminHostsBefore, memberHostsBefore, adminLoginsBefore] =
      await Promise.all([
        listHosts(admin),
        listHosts(member),
        listLogins(admin),
      ]);

    const renamed = await raceRenames(admin, config.id);

    expect(renamed).toMatchObject({
      id: config.id,
      revision: config.revision + 1,
      generation: config.generation,
    });
    expect(renamed.sshHosts).toStrictEqual([
      expect.objectContaining({ id: adminHost.id }),
    ]);
    await expect(listConfigs(admin)).resolves.toStrictEqual([renamed]);
    await expect(listHosts(admin)).resolves.toStrictEqual(adminHostsBefore);
    await expect(listHosts(member)).resolves.toStrictEqual(memberHostsBefore);
    await expect(listLogins(admin)).resolves.toStrictEqual(adminLoginsBefore);
  });

  it("cloudflare-access-concurrency-021 rotating credentials while deleting the host's independent login keeps the binding", async () => {
    const owner = signedIn("org:admin");
    const config = await createConfig(owner, "organization");
    const loginId = randomUUID();
    const login = await accept(
      logins().create({
        headers: headersOf(owner),
        body: {
          id: loginId,
          name: "deploy login",
          username: "deploy",
          authentication: {
            method: "private_key",
            privateKey: `key-${randomUUID()}`,
            passphrase: null,
          },
        },
      }),
      [201],
    );
    expect(login.body.revision).toBe(1);
    const created = await accept(
      hosts().create({
        headers: headersOf(owner),
        body: hostBody({ id: loginId }, config.id),
      }),
      [201],
    );
    const host = created.body;

    const [rotation, deletion] = await Promise.all([
      accept(
        configs().update({
          headers: headersOf(owner),
          query: { view: "scoped" },
          params: { configId: config.id },
          body: {
            expectedRevision: config.revision,
            credentials: {
              clientId: `client-${randomUUID()}`,
              clientSecret: `secret-${randomUUID()}`,
            },
          },
        }),
        [200],
      ),
      accept(
        logins().delete({
          headers: headersOf(owner),
          params: { credentialId: loginId },
          body: { expectedRevision: 1 },
        }),
        [409],
      ),
    ]);

    expect(rotation.body.generation).toBe(2);
    expect(deletion.body.error.code).toBe("SSH_CREDENTIAL_IN_USE");
    const [hostAfter] = await listHosts(owner);
    expect(hostAfter).toMatchObject({
      id: host.id,
      generation: host.generation + 1,
      transport: { type: "cloudflare_access", configId: config.id },
    });
    if (!hostAfter) {
      throw new Error("Expected the owner's host to remain");
    }
    expect(sshCredentialId(hostAfter)).toBe(loginId);
    const [loginAfter] = await listLogins(owner);
    expect(loginAfter).toMatchObject({
      id: loginId,
      revision: 1,
      username: "deploy",
    });
  });

  it("cloudflare-access-concurrency-024 a host needing rebind rejects an inline login without an explicit transport", async () => {
    const admin = signedIn("org:admin");
    const member = signedIn("org:member", admin.orgId);
    const config = await createConfig(admin, "organization");
    const memberHost = await createHost(member, config.id);
    const preview = await accept(
      configs().impactPreview({
        headers: headersOf(admin),
        params: { configId: config.id },
        query: { operation: "convert" },
      }),
      [200],
    );
    await accept(
      configs().convertToPersonal({
        headers: headersOf(admin),
        params: { configId: config.id },
        body: {
          expectedRevision: preview.body.expectedRevision,
          impactSnapshot: preview.body.impactSnapshot,
        },
      }),
      [200],
    );
    const [hostsBefore, loginsBefore] = await Promise.all([
      listHosts(member),
      listLogins(member),
    ]);
    const [needsRebind] = hostsBefore;
    expect(needsRebind).toMatchObject({
      id: memberHost.id,
      transport: { type: "cloudflare_access", needsRebind: true },
    });
    if (!needsRebind) {
      throw new Error("Expected the member's host to remain");
    }

    const rejected = await accept(
      hosts().update({
        headers: headersOf(member),
        params: { connectionId: memberHost.id },
        body: {
          expectedGeneration: needsRebind.generation,
          credential: inlineSshKey("operator", `key-${randomUUID()}`),
        },
      }),
      [400],
    );

    expect(rejected.body.error.code).toBe("SSH_INVALID_INPUT");
    await expect(listHosts(member)).resolves.toStrictEqual(hostsBefore);
    await expect(listLogins(member)).resolves.toStrictEqual(loginsBefore);
    await expect(listConfigs(member)).resolves.toStrictEqual([]);
  });

  it(
    "cloudflare-access-concurrency-025 keeps the first personal same-ID creation immutable across concurrent requests and changed-payload replays",
    { timeout: TEST_WITH_DOUBLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
    async () => {
      useSecretKmsProbe();
      const owner = await seedActor("org:admin");
      const member = await seedActor("org:member", owner.orgId);
      const run = await launchOwnerRun(owner, [member]);

      context.mocks.ably.publish.mockRejectedValue(
        new Error("Realtime unavailable"),
      );
      const configId = randomUUID();
      const firstBody = configBody(configId, "personal", "Personal First");
      const secondBody = configBody(configId, "personal", "Personal Second");
      const [resA, resB] = await Promise.all([
        accept(createRequest(owner, firstBody), [201, 204]),
        accept(createRequest(owner, secondBody), [201, 204]),
      ]);
      const winnerEntry =
        resA.status === 201
          ? { body: firstBody, response: resA }
          : { body: secondBody, response: resB };
      const otherStatus = resA.status === 201 ? resB.status : resA.status;
      expect(winnerEntry.response.status).toBe(201);
      expect(otherStatus).toBe(204);
      if (winnerEntry.response.status !== 201) {
        throw new Error("Expected winning 201 response");
      }
      expect(winnerEntry.response.body).toMatchObject({
        id: configId,
        name: winnerEntry.body.name,
        scope: "personal",
        revision: 1,
        generation: 1,
        sshHosts: [],
      });
      expect(JSON.stringify(winnerEntry.response.body)).not.toContain(
        winnerEntry.body.credentials.clientSecret,
      );

      await accept(
        createRequest(owner, configBody(configId, "personal", "Changed Retry")),
        [204],
      );
      await flushWaitUntilForTest();
      context.mocks.ably.publish.mockResolvedValue(undefined);

      await expect(listConfigs(owner)).resolves.toStrictEqual([
        winnerEntry.response.body,
      ]);
      await expect(listConfigs(member)).resolves.toStrictEqual([]);

      const host = await createHost(owner, configId);
      await enableSshDefault(owner, host.id);
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
        access: {
          configId,
          generation: 1,
          clientId: winnerEntry.body.credentials.clientId,
          clientSecret: winnerEntry.body.credentials.clientSecret,
        },
      });
    },
  );

  it(
    "cloudflare-access-concurrency-026 keeps the first organization same-ID creation immutable across concurrent requests and changed-payload replays",
    { timeout: TEST_WITH_DOUBLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
    async () => {
      useSecretKmsProbe();
      const owner = await seedActor("org:admin");
      const secondAdmin = await seedActor("org:admin", owner.orgId);
      const member = await seedActor("org:member", owner.orgId);
      const run = await launchOwnerRun(owner, [secondAdmin, member]);

      context.mocks.ably.publish.mockRejectedValue(
        new Error("Realtime unavailable"),
      );
      const configId = randomUUID();
      const ownerBody = configBody(configId, "organization", "Org First");
      const secondBody = configBody(configId, "organization", "Org Second");
      const [resOwner, resSecond] = await Promise.all([
        accept(createRequest(owner, ownerBody), [201, 204]),
        accept(createRequest(secondAdmin, secondBody), [201, 204]),
      ]);
      const winnerEntry =
        resOwner.status === 201
          ? { body: ownerBody, response: resOwner }
          : { body: secondBody, response: resSecond };
      const otherStatus =
        resOwner.status === 201 ? resSecond.status : resOwner.status;
      expect(winnerEntry.response.status).toBe(201);
      expect(otherStatus).toBe(204);
      if (winnerEntry.response.status !== 201) {
        throw new Error("Expected winning 201 response");
      }
      expect(winnerEntry.response.body).toMatchObject({
        id: configId,
        name: winnerEntry.body.name,
        scope: "organization",
        revision: 1,
        generation: 1,
        sshHosts: [],
      });
      expect(JSON.stringify(winnerEntry.response.body)).not.toContain(
        winnerEntry.body.credentials.clientSecret,
      );

      await accept(
        createRequest(
          secondAdmin,
          configBody(configId, "organization", "Org Changed Retry"),
        ),
        [204],
      );
      await accept(createRequest(member, winnerEntry.body), [403]);
      await flushWaitUntilForTest();
      context.mocks.ably.publish.mockResolvedValue(undefined);

      await expect(listConfigs(owner)).resolves.toStrictEqual([
        winnerEntry.response.body,
      ]);
      await expect(listConfigs(member)).resolves.toStrictEqual([
        winnerEntry.response.body,
      ]);

      const host = await createHost(owner, configId);
      await enableSshDefault(owner, host.id);
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
        access: {
          configId,
          generation: 1,
          clientId: winnerEntry.body.credentials.clientId,
          clientSecret: winnerEntry.body.credentials.clientSecret,
        },
      });
    },
  );

  it(
    "cloudflare-access-concurrency-027 preserves pin and observation authority across a concurrent metadata-only rename without rotating credentials",
    { timeout: TEST_WITH_DOUBLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
    async () => {
      useSecretKmsProbe();
      const owner = await seedActor("org:admin");
      const member = await seedActor("org:member", owner.orgId);
      const originalCreds = {
        clientId: `cf-id-${randomUUID()}`,
        clientSecret: `cf-sec-${randomUUID()}`,
      };
      const config = (
        await accept(
          configs().create({
            headers: headersOf(owner),
            query: { view: "scoped" },
            body: {
              id: randomUUID(),
              name: "Original Access",
              scope: "organization",
              credentials: originalCreds,
            },
          }),
          [201],
        )
      ).body;
      const password = `pw-${randomUUID()}`;
      const login = await createPasswordLogin(owner, password);
      const ownerHost = await createAccessHostWithLogin(
        owner,
        config.id,
        login.id,
      );
      await createHost(member, config.id);
      const [memberHostsBefore, ownerLoginsBefore] = await Promise.all([
        listHosts(member),
        listLogins(owner),
      ]);
      await enableSshDefault(owner, ownerHost.id);
      const run = await launchOwnerRun(owner, [member]);

      const key = hostKeyFor(`cf-027-${ownerHost.id}`);
      const [renamed, pinned, observed] = await Promise.all([
        accept(
          configs().update({
            headers: headersOf(owner),
            query: { view: "scoped" },
            params: { configId: config.id },
            body: {
              expectedRevision: config.revision,
              name: "Renamed Access",
            },
          }),
          [200],
        ),
        accept(
          runnerSsh().pin({
            headers: runnerHeaders(),
            params: { runId: run.runId },
            body: {
              connectionId: ownerHost.id,
              runnerIdentity: run.runnerIdentity,
              expectedGeneration: ownerHost.generation,
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
              connectionId: ownerHost.id,
              runnerIdentity: run.runnerIdentity,
              expectedGeneration: ownerHost.generation,
              expectedCreatedAt: ownerHost.createdAt,
              observedAt: nowDate().toISOString(),
              failureReason: null,
            },
          }),
          [200],
        ),
      ]);

      expect(renamed.body).toMatchObject({
        id: config.id,
        name: "Renamed Access",
        revision: config.revision + 1,
        generation: config.generation,
        sshHosts: [{ id: ownerHost.id, displayName: ownerHost.displayName }],
      });
      expect(pinned.body).toStrictEqual({
        outcome: "pinned",
        generation: ownerHost.generation + 1,
      });
      expect(["recorded", "ignored"]).toContain(observed.body.outcome);

      const [storedOwnerHost] = await listHosts(owner);
      expect(storedOwnerHost).toMatchObject({
        id: ownerHost.id,
        host: ownerHost.host,
        port: ownerHost.port,
        credentialId: login.id,
        generation: ownerHost.generation + 1,
        learnedHostKey: key,
        transport: { type: "cloudflare_access", configId: config.id },
      });
      await expect(listHosts(member)).resolves.toStrictEqual(memberHostsBefore);
      await expect(listLogins(owner)).resolves.toStrictEqual(ownerLoginsBefore);

      const resolved = await accept(
        runnerSsh().resolve({
          headers: runnerHeaders(),
          params: { runId: run.runId },
          body: {
            connectionId: ownerHost.id,
            runnerIdentity: run.runnerIdentity,
          },
        }),
        [200],
      );
      expect(resolved.body).toMatchObject({
        outcome: "resolved_access",
        host: ownerHost.host,
        port: ownerHost.port,
        username: "deploy",
        generation: ownerHost.generation + 1,
        learnedHostKey: key,
        authentication: { method: "password", password },
        access: {
          configId: config.id,
          generation: 1,
          clientId: originalCreds.clientId,
          clientSecret: originalCreds.clientSecret,
        },
      });
      const observations = (
        await accept(hosts().observations({ headers: headersOf(owner) }), [200])
      ).body.observations;
      expect(observations).toStrictEqual([]);
    },
  );

  it(
    "cloudflare-access-concurrency-029 publishes a create binding with a shared login while another host records Runner authority",
    { timeout: TEST_WITH_SINGLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
    async () => {
      useSecretKmsProbe();
      const owner = await seedActor("org:admin");
      const config = await createConfig(owner, "organization");
      const password = `pw-${randomUUID()}`;
      const login = await createPasswordLogin(owner, password);
      const firstHost = await createAccessHostWithLogin(
        owner,
        config.id,
        login.id,
      );
      await enableSshDefault(owner, firstHost.id);
      const run = await launchOwnerRun(owner);

      const key = hostKeyFor(`cf-029-${firstHost.id}`);
      const [secondHost, pinned, observed] = await Promise.all([
        accept(
          hosts().create({
            headers: headersOf(owner),
            body: hostBody({ id: login.id }, config.id),
          }),
          [201],
        ),
        accept(
          runnerSsh().pin({
            headers: runnerHeaders(),
            params: { runId: run.runId },
            body: {
              connectionId: firstHost.id,
              runnerIdentity: run.runnerIdentity,
              expectedGeneration: firstHost.generation,
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
              connectionId: firstHost.id,
              runnerIdentity: run.runnerIdentity,
              expectedGeneration: firstHost.generation,
              expectedCreatedAt: firstHost.createdAt,
              observedAt: nowDate().toISOString(),
              failureReason: null,
            },
          }),
          [200],
        ),
      ]);

      expect(sshCredentialId(secondHost.body)).toBe(login.id);
      expect(secondHost.body).toMatchObject({
        transport: { type: "cloudflare_access", configId: config.id },
      });
      expect(pinned.body).toStrictEqual({
        outcome: "pinned",
        generation: firstHost.generation + 1,
      });
      expect(["recorded", "ignored"]).toContain(observed.body.outcome);

      const resolved = await accept(
        runnerSsh().resolve({
          headers: runnerHeaders(),
          params: { runId: run.runId },
          body: {
            connectionId: firstHost.id,
            runnerIdentity: run.runnerIdentity,
          },
        }),
        [200],
      );
      expect(resolved.body).toMatchObject({
        outcome: "resolved_access",
        learnedHostKey: key,
        authentication: { method: "password", password },
        access: expect.objectContaining({ configId: config.id, generation: 1 }),
      });

      const [allHosts, allConfigs, allLogins] = await Promise.all([
        listHosts(owner),
        listConfigs(owner),
        listLogins(owner),
      ]);
      expect(allHosts).toContainEqual(secondHost.body);
      expect(allConfigs[0]).toMatchObject({
        id: config.id,
        revision: config.revision,
      });
      expect(
        allConfigs[0]?.sshHosts.map((entry) => {
          return entry.id;
        }),
      ).toStrictEqual(
        expect.arrayContaining([firstHost.id, secondHost.body.id]),
      );
      expect(allLogins).toHaveLength(1);
    },
  );

  it(
    "cloudflare-access-concurrency-030 publishes a rebind binding with a shared login while another host records Runner authority",
    { timeout: TEST_WITH_SINGLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
    async () => {
      useSecretKmsProbe();
      const owner = await seedActor("org:admin");
      const config = await createConfig(owner, "organization");
      const password = `pw-${randomUUID()}`;
      const login = await createPasswordLogin(owner, password);
      const firstHost = await createAccessHostWithLogin(
        owner,
        config.id,
        login.id,
      );
      const directHost = await createAccessHostWithLogin(owner, null, login.id);
      await enableSshDefault(owner, firstHost.id);
      const run = await launchOwnerRun(owner);

      const key = hostKeyFor(`cf-030-${firstHost.id}`);
      const [rebound, pinned, observed] = await Promise.all([
        accept(
          hosts().update({
            headers: headersOf(owner),
            params: { connectionId: directHost.id },
            body: {
              expectedGeneration: directHost.generation,
              port: 443,
              transport: { type: "cloudflare_access", configId: config.id },
            },
          }),
          [200],
        ),
        accept(
          runnerSsh().pin({
            headers: runnerHeaders(),
            params: { runId: run.runId },
            body: {
              connectionId: firstHost.id,
              runnerIdentity: run.runnerIdentity,
              expectedGeneration: firstHost.generation,
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
              connectionId: firstHost.id,
              runnerIdentity: run.runnerIdentity,
              expectedGeneration: firstHost.generation,
              expectedCreatedAt: firstHost.createdAt,
              observedAt: nowDate().toISOString(),
              failureReason: null,
            },
          }),
          [200],
        ),
      ]);

      expect(sshCredentialId(rebound.body)).toBe(login.id);
      expect(rebound.body).toMatchObject({
        transport: { type: "cloudflare_access", configId: config.id },
      });
      expect(pinned.body).toStrictEqual({
        outcome: "pinned",
        generation: firstHost.generation + 1,
      });
      expect(["recorded", "ignored"]).toContain(observed.body.outcome);

      const resolved = await accept(
        runnerSsh().resolve({
          headers: runnerHeaders(),
          params: { runId: run.runId },
          body: {
            connectionId: firstHost.id,
            runnerIdentity: run.runnerIdentity,
          },
        }),
        [200],
      );
      expect(resolved.body).toMatchObject({
        outcome: "resolved_access",
        learnedHostKey: key,
        authentication: { method: "password", password },
        access: expect.objectContaining({ configId: config.id, generation: 1 }),
      });

      const [allConfigs, allLogins] = await Promise.all([
        listConfigs(owner),
        listLogins(owner),
      ]);
      expect(allConfigs[0]).toMatchObject({
        id: config.id,
        revision: config.revision,
      });
      expect(
        allConfigs[0]?.sshHosts.map((entry) => {
          return entry.id;
        }),
      ).toStrictEqual(expect.arrayContaining([firstHost.id, directHost.id]));
      expect(allLogins).toHaveLength(1);
    },
  );

  it(
    "cloudflare-access-concurrency-031 notifies the affected Runner after reviewed deletion and preserves the detached Host",
    { timeout: TEST_WITH_SINGLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
    async () => {
      useSecretKmsProbe();
      const owner = await seedActor("org:admin");
      const otherAdmin = await seedActor("org:admin", owner.orgId);
      const config = await createConfig(owner, "organization");
      const ownerHost = await createHost(owner, config.id);
      await enableSshDefault(owner, ownerHost.id);
      const run = await launchOwnerRun(owner, [otherAdmin]);

      const preview = (
        await accept(
          configs().impactPreview({
            headers: headersOf(otherAdmin),
            params: { configId: config.id },
            query: { operation: "delete" },
          }),
          [200],
        )
      ).body;

      await flushWaitUntilForTest();
      clearRealtimePublications();

      await accept(
        configs().delete({
          headers: headersOf(otherAdmin),
          params: { configId: config.id },
          body: {
            expectedRevision: preview.expectedRevision,
            impactSnapshot: preview.impactSnapshot,
          },
        }),
        [204],
      );
      await flushWaitUntilForTest();

      const publications = readRealtimePublications();
      expect(
        publications.filter((entry) => {
          return entry.topic === "ssh-authority-invalidated";
        }),
      ).toStrictEqual([
        {
          channel: `runner-group:${run.runnerGroup}`,
          topic: "ssh-authority-invalidated",
          payload: { runId: run.runId, connectionId: ownerHost.id },
        },
      ]);
      expect(
        publications.filter((entry) => {
          return entry.topic === "vnc-authority-invalidated";
        }),
      ).toStrictEqual([]);

      const [detachedHost] = await listHosts(owner);
      expect(detachedHost).toMatchObject({
        id: ownerHost.id,
        generation: ownerHost.generation + 1,
        transport: { type: "cloudflare_access", needsRebind: true },
      });

      const resolved = await accept(
        runnerSsh().resolve({
          headers: runnerHeaders(),
          params: { runId: run.runId },
          body: {
            connectionId: ownerHost.id,
            runnerIdentity: run.runnerIdentity,
          },
        }),
        [200],
      );
      expect(resolved.body).toStrictEqual({ outcome: "unavailable" });
    },
  );

  it(
    "cloudflare-access-concurrency-032 commits network rotation completely or rejects concurrent Runner authority before a fresh request",
    { timeout: TEST_WITH_SINGLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
    async () => {
      useSecretKmsProbe();
      const owner = await seedActor("org:admin");
      const originalCreds = {
        clientId: `cf-orig-${randomUUID()}`,
        clientSecret: `cf-orig-sec-${randomUUID()}`,
      };
      const rotatedCreds = {
        clientId: `cf-rot-${randomUUID()}`,
        clientSecret: `cf-rot-sec-${randomUUID()}`,
      };
      const config = (
        await accept(
          configs().create({
            headers: headersOf(owner),
            query: { view: "scoped" },
            body: {
              id: randomUUID(),
              name: "Rotate network",
              scope: "organization",
              credentials: originalCreds,
            },
          }),
          [201],
        )
      ).body;
      const password = `pw-${randomUUID()}`;
      const login = await createPasswordLogin(owner, password);
      const protectedHost = await createAccessHostWithLogin(
        owner,
        config.id,
        login.id,
      );
      const siblingHost = await createAccessHostWithLogin(
        owner,
        config.id,
        login.id,
      );
      await enableSshDefault(owner, protectedHost.id);
      const run = await launchOwnerRun(owner);

      const key = hostKeyFor(`cf-032-${protectedHost.id}`);
      const [firstRotation, firstPin, observed] = await Promise.all([
        accept(
          configs().update({
            headers: headersOf(owner),
            query: { view: "scoped" },
            params: { configId: config.id },
            body: {
              expectedRevision: config.revision,
              credentials: rotatedCreds,
            },
          }),
          [200, 409],
        ),
        accept(
          runnerSsh().pin({
            headers: runnerHeaders(),
            params: { runId: run.runId },
            body: {
              connectionId: protectedHost.id,
              runnerIdentity: run.runnerIdentity,
              expectedGeneration: protectedHost.generation,
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
              connectionId: protectedHost.id,
              runnerIdentity: run.runnerIdentity,
              expectedGeneration: protectedHost.generation,
              expectedCreatedAt: protectedHost.createdAt,
              observedAt: nowDate().toISOString(),
              failureReason: null,
            },
          }),
          [200],
        ),
      ]);
      expect(["recorded", "ignored"]).toContain(observed.body.outcome);

      let committedRotation = firstRotation;
      if (firstRotation.status === 409) {
        expect(firstRotation.body.error.code).toBe(
          "CLOUDFLARE_ACCESS_REVISION_CONFLICT",
        );
        const beforeRetryResolve = await accept(
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
        expect(beforeRetryResolve.body).toMatchObject({
          outcome: "resolved_access",
          access: {
            configId: config.id,
            generation: 1,
            clientId: originalCreds.clientId,
            clientSecret: originalCreds.clientSecret,
          },
        });
        committedRotation = await accept(
          configs().update({
            headers: headersOf(owner),
            query: { view: "scoped" },
            params: { configId: config.id },
            body: {
              expectedRevision: config.revision,
              credentials: rotatedCreds,
            },
          }),
          [200],
        );
      }
      expect(committedRotation.status).toBe(200);
      expect(committedRotation.body).toMatchObject({
        revision: 2,
        generation: 2,
      });

      if (firstPin.body.outcome !== "pinned") {
        expect(firstPin.body).toStrictEqual({
          outcome: "configuration_changed",
        });
        const currentHosts = await listHosts(owner);
        const currentProtected = currentHosts.find((entry) => {
          return entry.id === protectedHost.id;
        });
        if (!currentProtected) {
          throw new Error("Expected protected host");
        }
        const repin = await accept(
          runnerSsh().pin({
            headers: runnerHeaders(),
            params: { runId: run.runId },
            body: {
              connectionId: protectedHost.id,
              runnerIdentity: run.runnerIdentity,
              expectedGeneration: currentProtected.generation,
              observedHostKey: key,
            },
          }),
          [200],
        );
        expect(repin.body).toStrictEqual({
          outcome: "pinned",
          generation: currentProtected.generation + 1,
        });
      }

      const [finalHosts, finalLogins, finalObservations] = await Promise.all([
        listHosts(owner),
        listLogins(owner),
        accept(hosts().observations({ headers: headersOf(owner) }), [200]),
      ]);
      const finalProtected = finalHosts.find((entry) => {
        return entry.id === protectedHost.id;
      });
      const finalSibling = finalHosts.find((entry) => {
        return entry.id === siblingHost.id;
      });
      expect(finalProtected).toMatchObject({
        id: protectedHost.id,
        host: protectedHost.host,
        port: protectedHost.port,
        credentialId: login.id,
        learnedHostKey: key,
        generation: protectedHost.generation + 2,
        transport: { type: "cloudflare_access", configId: config.id },
      });
      expect(finalSibling?.generation).toBe(siblingHost.generation + 1);
      expect(finalLogins[0]?.revision).toBe(1);
      expect(finalObservations.body.observations).toStrictEqual([]);

      const finalResolve = await accept(
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
      expect(finalResolve.body).toMatchObject({
        outcome: "resolved_access",
        learnedHostKey: key,
        authentication: { method: "password", password },
        access: {
          configId: config.id,
          generation: 2,
          clientId: rotatedCreds.clientId,
          clientSecret: rotatedCreds.clientSecret,
        },
      });
    },
  );

  it(
    "cloudflare-access-concurrency-033 commits login rotation completely or rejects concurrent Runner authority before a fresh request",
    { timeout: TEST_WITH_SINGLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
    async () => {
      useSecretKmsProbe();
      const owner = await seedActor("org:admin");
      const accessCreds = {
        clientId: `cf-keep-${randomUUID()}`,
        clientSecret: `cf-keep-sec-${randomUUID()}`,
      };
      const config = (
        await accept(
          configs().create({
            headers: headersOf(owner),
            query: { view: "scoped" },
            body: {
              id: randomUUID(),
              name: "Keep network",
              scope: "organization",
              credentials: accessCreds,
            },
          }),
          [201],
        )
      ).body;
      const originalPassword = `pw-orig-${randomUUID()}`;
      const rotatedPassword = `pw-rot-${randomUUID()}`;
      const login = await createPasswordLogin(owner, originalPassword);
      const protectedHost = await createAccessHostWithLogin(
        owner,
        config.id,
        login.id,
      );
      const siblingHost = await createAccessHostWithLogin(
        owner,
        config.id,
        login.id,
      );
      await enableSshDefault(owner, protectedHost.id);
      const run = await launchOwnerRun(owner);

      const key = hostKeyFor(`cf-033-${protectedHost.id}`);
      const [firstRotation, firstPin, observed] = await Promise.all([
        accept(
          logins().update({
            headers: headersOf(owner),
            params: { credentialId: login.id },
            body: {
              expectedRevision: login.revision,
              username: "rotated-deploy",
              authentication: {
                method: "password",
                password: rotatedPassword,
              },
            },
          }),
          [200, 409],
        ),
        accept(
          runnerSsh().pin({
            headers: runnerHeaders(),
            params: { runId: run.runId },
            body: {
              connectionId: protectedHost.id,
              runnerIdentity: run.runnerIdentity,
              expectedGeneration: protectedHost.generation,
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
              connectionId: protectedHost.id,
              runnerIdentity: run.runnerIdentity,
              expectedGeneration: protectedHost.generation,
              expectedCreatedAt: protectedHost.createdAt,
              observedAt: nowDate().toISOString(),
              failureReason: null,
            },
          }),
          [200],
        ),
      ]);
      expect(["recorded", "ignored"]).toContain(observed.body.outcome);

      let committedRotation = firstRotation;
      if (firstRotation.status === 409) {
        expect(firstRotation.body.error.code).toBe(
          "SSH_CREDENTIAL_REVISION_CONFLICT",
        );
        const beforeRetryResolve = await accept(
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
        expect(beforeRetryResolve.body).toMatchObject({
          outcome: "resolved_access",
          username: "deploy",
          authentication: { method: "password", password: originalPassword },
        });
        committedRotation = await accept(
          logins().update({
            headers: headersOf(owner),
            params: { credentialId: login.id },
            body: {
              expectedRevision: login.revision,
              username: "rotated-deploy",
              authentication: {
                method: "password",
                password: rotatedPassword,
              },
            },
          }),
          [200],
        );
      }
      expect(committedRotation.status).toBe(200);
      expect(committedRotation.body).toMatchObject({
        revision: 2,
        username: "rotated-deploy",
      });

      if (firstPin.body.outcome !== "pinned") {
        expect(firstPin.body).toStrictEqual({
          outcome: "configuration_changed",
        });
        const currentHosts = await listHosts(owner);
        const currentProtected = currentHosts.find((entry) => {
          return entry.id === protectedHost.id;
        });
        if (!currentProtected) {
          throw new Error("Expected protected host");
        }
        const repin = await accept(
          runnerSsh().pin({
            headers: runnerHeaders(),
            params: { runId: run.runId },
            body: {
              connectionId: protectedHost.id,
              runnerIdentity: run.runnerIdentity,
              expectedGeneration: currentProtected.generation,
              observedHostKey: key,
            },
          }),
          [200],
        );
        expect(repin.body).toStrictEqual({
          outcome: "pinned",
          generation: currentProtected.generation + 1,
        });
      }

      const [finalHosts, finalObservations] = await Promise.all([
        listHosts(owner),
        accept(hosts().observations({ headers: headersOf(owner) }), [200]),
      ]);
      const finalProtected = finalHosts.find((entry) => {
        return entry.id === protectedHost.id;
      });
      const finalSibling = finalHosts.find((entry) => {
        return entry.id === siblingHost.id;
      });
      expect(finalProtected).toMatchObject({
        id: protectedHost.id,
        username: "rotated-deploy",
        learnedHostKey: key,
        generation: protectedHost.generation + 2,
      });
      expect(finalSibling?.generation).toBe(siblingHost.generation + 1);
      expect(finalObservations.body.observations).toStrictEqual([]);

      const finalResolve = await accept(
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
      expect(finalResolve.body).toMatchObject({
        outcome: "resolved_access",
        username: "rotated-deploy",
        learnedHostKey: key,
        authentication: { method: "password", password: rotatedPassword },
        access: {
          configId: config.id,
          generation: 1,
          clientId: accessCreds.clientId,
          clientSecret: accessCreds.clientSecret,
        },
      });
    },
  );
});
