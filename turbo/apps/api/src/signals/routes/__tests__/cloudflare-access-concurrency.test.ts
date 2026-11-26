import { randomUUID } from "node:crypto";

import { cloudflareAccessContract } from "@okouai/api-contracts/contracts/cloudflare-access";
import { sshConnectionsContract } from "@okouai/api-contracts/contracts/ssh-connections";
import { sshCredentialsContract } from "@okouai/api-contracts/contracts/ssh-credentials";
import { describe, expect, it } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { cloudflareAccessRoutes } from "../cloudflare-access";
import { sshConnectionsRoutes } from "../ssh-connections";
import { inlineSshKey, sshCredentialId } from "./helpers/ssh-credential";

const context = testContext();

interface Actor {
  readonly userId: string;
  readonly orgId: string;
  readonly role: "org:admin" | "org:member";
}

const sessions = new Map<string, Actor>();

/** Clerk resolves each bearer session to the identity it was issued for. */
function installSessions() {
  context.mocks.clerk.authenticateRequest.mockImplementation(
    (request: unknown) => {
      const header =
        request instanceof Request
          ? (request.headers.get("authorization") ?? "")
          : "";
      const actor = sessions.get(header);
      if (!actor) {
        return Promise.resolve({ isAuthenticated: false, toAuth: () => null });
      }
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
    },
  );
}

function headersOf(actor: Actor) {
  return { authorization: `Bearer clerk-session-${actor.userId}` };
}

function signedIn(role: Actor["role"], orgId = `org_${randomUUID()}`): Actor {
  const actor = { userId: `user_${randomUUID()}`, orgId, role };
  sessions.set(headersOf(actor).authorization, actor);
  installSessions();
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
});
