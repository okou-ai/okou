import { randomUUID } from "node:crypto";

import {
  cloudflareAccessContract,
  type DeleteCloudflareAccessRequest,
} from "@okouai/api-contracts/contracts/cloudflare-access";
import { sshConnectionsContract } from "@okouai/api-contracts/contracts/ssh-connections";
import { sshCredentialsContract } from "@okouai/api-contracts/contracts/ssh-credentials";
import { chatRemoteAccessContract } from "@okouai/api-contracts/contracts/chat-remote-access";
import { runnerSshContract } from "@okouai/api-contracts/contracts/runner-ssh";
import { createStore, state } from "ccstate";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  onTestFinished,
  test,
} from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { mockEnv } from "../../../lib/env";
import { nowDate } from "../../../lib/time";
import { cloudflareAccessRoutes } from "../cloudflare-access";
import { chatRemoteAccessRoutes } from "../chat-remote-access";
import { runnerSshRoutes } from "../runner-ssh";
import { createClaimedSshRuntimeApi } from "./helpers/claimed-ssh-runtime";
import { sshConnectionsRoutes } from "../ssh-connections";
import { seedOrgMembership$ } from "./helpers/org-membership";
import { useSecretKmsProbe } from "./helpers/secret-kms-probe";
import { joinAll } from "../../utils";

const context = testContext();
const store = createStore();
const query = Object.freeze({ view: "scoped" as const });
const identities$ = state<
  ReadonlyMap<
    string,
    { userId: string; orgId: string; orgRole: "org:admin" | "org:member" }
  >
>(new Map());
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
const credentials = () => {
  return setupApp({ context, routes: sshConnectionsRoutes })(
    sshCredentialsContract,
  );
};
const login = Object.freeze({
  name: "Concurrent login",
  username: "deploy",
  authentication: {
    method: "password" as const,
    password: "synthetic-password",
  },
});

function authenticateSessions() {
  context.mocks.clerk.authenticateRequest.mockImplementation(
    (request: unknown) => {
      if (!(request instanceof Request)) {
        throw new Error("Expected a Clerk authentication request");
      }
      const identity = store
        .get(identities$)
        .get(request.headers.get("authorization") ?? "");
      if (!identity) {
        throw new Error("Unknown case-owned session");
      }
      return Promise.resolve({
        isAuthenticated: true,
        toAuth: () => {
          return identity;
        },
      });
    },
  );
}

const runnerSecret = "e".repeat(64);
const runnerHeaders = Object.freeze({
  authorization: `Bearer vm0_official_${runnerSecret}`,
});
const hostKey = Object.freeze({
  algorithm: "ssh-ed25519" as const,
  fingerprint: `SHA256:${Buffer.alloc(32, 3).toString("base64").replace(/=+$/u, "")}`,
});
const ordinary = createClaimedSshRuntimeApi(context, {
  runnerHeaders,
  authenticate: authenticateSessions,
});

beforeEach(() => {
  store.set(identities$, new Map());
  useSecretKmsProbe();
  authenticateSessions();
  mockEnv("OFFICIAL_RUNNER_SECRET", runnerSecret);
  context.mocks.s3.send.mockResolvedValue({ Contents: [] });
});

async function actor(
  orgId = `org_access_concurrency_${randomUUID()}`,
  role: "admin" | "member" = "admin",
) {
  const identity = { orgId, userId: `user_access_concurrency_${randomUUID()}` };
  const headers = { authorization: `Bearer clerk-session-${identity.userId}` };
  const identities = new Map(store.get(identities$));
  identities.set(headers.authorization, {
    ...identity,
    orgRole: `org:${role}`,
  });
  store.set(identities$, identities);
  await store.set(seedOrgMembership$, { ...identity, role }, context.signal);
  return { ...identity, headers };
}

async function sharedConfig(owner: Awaited<ReturnType<typeof actor>>) {
  return (
    await accept(
      configs().create({
        headers: owner.headers,
        query,
        body: {
          id: randomUUID(),
          scope: "organization",
          name: "Concurrent gateway",
          credentials: {
            clientId: "synthetic-id",
            clientSecret: "synthetic-secret",
          },
        },
      }),
      [201],
    )
  ).body;
}

function createHost(
  owner: Awaited<ReturnType<typeof actor>>,
  configId?: string,
) {
  return hosts().create({
    headers: owner.headers,
    body: {
      id: randomUUID(),
      displayName: "Concurrent host",
      host: "ssh.example.com",
      port: configId ? 443 : 22,
      credential: { create: login },
      ...(configId
        ? { transport: { type: "cloudflare_access" as const, configId } }
        : {}),
    },
  });
}

test.each(["user", "organization", "scope"] as const)(
  "rejects competing %s ownership of one configuration ID without replacing the winner",
  async (dimension) => {
    const first = await actor();
    const second =
      dimension === "scope"
        ? first
        : await actor(dimension === "user" ? first.orgId : undefined);
    const id = randomUUID();
    const requests = [
      {
        headers: first.headers,
        query,
        body: {
          id,
          scope: dimension === "organization" ? "organization" : "personal",
          name: "First owner gateway",
          credentials: { clientId: "first-id", clientSecret: "first-secret" },
        },
      },
      {
        headers: second.headers,
        query,
        body: {
          id,
          scope: dimension === "user" ? "personal" : "organization",
          name: "Second owner gateway",
          credentials: { clientId: "second-id", clientSecret: "second-secret" },
        },
      },
    ] as const;
    const results = await Promise.all(
      requests.map((request) => {
        return accept(configs().create(request), [201, 409]);
      }),
    );
    expect(
      results
        .map(({ status }) => {
          return status;
        })
        .sort(),
    ).toStrictEqual([201, 409]);
    const created = results.find((result) => {
      return result.status === 201;
    });
    if (!created) {
      throw new Error("Expected one created configuration");
    }
    for (const [index, result] of results.entries()) {
      const request = requests[index];
      if (!request) {
        throw new Error("Missing competing creation request");
      }
      if (result.status === 409) {
        expect(result.body.error).toStrictEqual({
          code: "CLOUDFLARE_ACCESS_RESOURCE_ID_CONFLICT",
          message:
            "This resource ID cannot be used for this Cloudflare Access configuration.",
        });
        await accept(configs().create(request), [409]);
      }
      expect(
        (
          await accept(
            configs().list({ headers: request.headers, query }),
            [200],
          )
        ).body.configs,
      ).toStrictEqual(
        result.status === 201 || dimension === "scope" ? [created.body] : [],
      );
    }
  },
);

async function cleanupRenameFixtures(
  owner: Awaited<ReturnType<typeof actor>>,
  participants: readonly Awaited<ReturnType<typeof actor>>[],
) {
  // Finished callbacks run after shared mocks reset, with a live cleanup signal.
  authenticateSessions();
  for (const participant of participants) {
    await store.set(
      seedOrgMembership$,
      {
        ...participant,
        role: participant.userId === owner.userId ? "admin" : "member",
      },
      context.signal,
    );
  }
  // These fresh UUID actors own only this case's resources. Public inventories
  // also recover committed setup whose response or accept() failed.
  await joinAll(
    participants.map(async (participant) => {
      const connections = await accept(
        hosts().list({ headers: participant.headers }),
        [200],
      );
      await joinAll(
        connections.body.connections.map(({ id }) => {
          return accept(
            hosts().delete({
              headers: participant.headers,
              params: { connectionId: id },
            }),
            [204],
          );
        }),
      );
      const logins = await accept(
        credentials().list({ headers: participant.headers }),
        [200],
      );
      await joinAll(
        logins.body.credentials.map(({ id, revision }) => {
          return accept(
            credentials().delete({
              headers: participant.headers,
              params: { credentialId: id },
              body: { expectedRevision: revision },
            }),
            [204],
          );
        }),
      );
    }),
  );
  const configurations = await accept(
    configs().list({ headers: owner.headers, query }),
    [200],
  );
  await joinAll(
    configurations.body.configs.map(async ({ id, scope, revision }) => {
      let body: DeleteCloudflareAccessRequest = {
        expectedRevision: revision,
      };
      if (scope === "organization") {
        const preview = await accept(
          configs().impactPreview({
            headers: owner.headers,
            params: { configId: id },
            query: { operation: "delete" },
          }),
          [200],
        );
        body = {
          expectedRevision: preview.body.expectedRevision,
          impactSnapshot: preview.body.impactSnapshot,
        };
      }
      await accept(
        configs().delete({
          headers: owner.headers,
          params: { configId: id },
          query,
          body,
        }),
        [204],
      );
    }),
  );
}

test.each(["personal", "organization"] as const)(
  "accepts exactly one same-revision metadata rename for a %s configuration without changing host authority",
  async (scope) => {
    const owner = await actor();
    const participants = [owner];
    onTestFinished(async () => {
      await cleanupRenameFixtures(owner, participants);
    });
    const original = (
      await accept(
        configs().create({
          headers: owner.headers,
          query,
          body: {
            id: randomUUID(),
            scope,
            name: "Concurrent gateway",
            credentials: {
              clientId: "synthetic-id",
              clientSecret: "synthetic-secret",
            },
          },
        }),
        [201],
      )
    ).body;
    const own = (await accept(createHost(owner, original.id), [201])).body;
    const member = await actor(owner.orgId, "member");
    participants.push(member);
    await accept(
      createHost(member, scope === "organization" ? original.id : undefined),
      [201],
    );
    const beforeOwn = (
      await accept(hosts().list({ headers: owner.headers }), [200])
    ).body;
    const beforeMember = (
      await accept(hosts().list({ headers: member.headers }), [200])
    ).body;
    const beforeLogins = (
      await accept(credentials().list({ headers: owner.headers }), [200])
    ).body;

    const results = await joinAll(
      ["First rename", "Second rename"].map((name) => {
        return accept(
          configs().update({
            headers: owner.headers,
            params: { configId: original.id },
            query,
            body: { expectedRevision: original.revision, name },
          }),
          [200, 409],
        );
      }),
    );
    expect(
      results
        .map(({ status }) => {
          return status;
        })
        .sort(),
    ).toStrictEqual([200, 409]);
    const renamed = results.find((result) => {
      return result.status === 200;
    });
    const rejected = results.find((result) => {
      return result.status === 409;
    });
    if (!renamed || !rejected) {
      throw new Error("Expected one accepted and one rejected metadata rename");
    }
    expect(["First rename", "Second rename"]).toContain(renamed.body.name);
    expect(renamed.body).toMatchObject({
      id: original.id,
      scope,
      revision: original.revision + 1,
      generation: original.generation,
      sshHosts: [{ id: own.id, displayName: own.displayName }],
    });
    expect(rejected.body.error.code).toBe(
      "CLOUDFLARE_ACCESS_REVISION_CONFLICT",
    );
    expect(
      (await accept(configs().list({ headers: owner.headers, query }), [200]))
        .body.configs,
    ).toStrictEqual([renamed.body]);
    expect(
      (await accept(hosts().list({ headers: owner.headers }), [200])).body,
    ).toStrictEqual(beforeOwn);
    expect(
      (await accept(hosts().list({ headers: member.headers }), [200])).body,
    ).toStrictEqual(beforeMember);
    expect(
      (await accept(credentials().list({ headers: owner.headers }), [200]))
        .body,
    ).toStrictEqual(beforeLogins);
  },
);

test.each(["create", "update"] as const)(
  "admits selected %s after a metadata-only rename during external login preparation without advancing host authority",
  async (operation) => {
    const admin = await actor();
    const shared = await sharedConfig(admin);
    const own = (await accept(createHost(admin, shared.id), [201])).body;
    const member = await actor(admin.orgId, "member");
    const retained = (await accept(createHost(member, shared.id), [201])).body;
    const existing =
      operation === "update"
        ? (await accept(createHost(member), [201])).body
        : undefined;
    const beforeAdmin = (
      await accept(hosts().list({ headers: admin.headers }), [200])
    ).body;

    useSecretKmsProbe(async (request, callNumber) => {
      if (callNumber === 1) {
        const renamed = await accept(
          configs().update({
            headers: admin.headers,
            params: { configId: shared.id },
            query,
            body: {
              expectedRevision: shared.revision,
              name: "Renamed gateway",
            },
          }),
          [200],
        );
        expect(renamed.body).toMatchObject({
          name: "Renamed gateway",
          revision: shared.revision + 1,
          generation: shared.generation,
        });
        expect(renamed.body.sshHosts).toStrictEqual([
          { id: own.id, displayName: own.displayName },
        ]);
      }
      return {
        keyId: request.keyId,
        plaintext: Buffer.from("0123456789abcdef0123456789abcdef", "utf8"),
        encryptedDataKey: Buffer.from(
          `encrypted-data-key:${request.keyId}`,
          "utf8",
        ),
      };
    });
    const selected = existing
      ? await accept(
          hosts().update({
            headers: member.headers,
            params: { connectionId: existing.id },
            body: {
              expectedGeneration: existing.generation,
              port: 443,
              credential: { create: login },
              transport: { type: "cloudflare_access", configId: shared.id },
            },
          }),
          [200],
        )
      : await accept(createHost(member, shared.id), [201]);
    expect(selected.body).toMatchObject({
      generation: existing ? existing.generation + 1 : 1,
      port: 443,
      transport: { type: "cloudflare_access", configId: shared.id },
    });
    expect(
      (await accept(hosts().list({ headers: admin.headers }), [200])).body,
    ).toStrictEqual(beforeAdmin);
    expect(
      (await accept(hosts().list({ headers: member.headers }), [200])).body
        .connections,
    ).toContainEqual(retained);
    const visible = (
      await accept(configs().list({ headers: member.headers, query }), [200])
    ).body.configs;
    expect(visible).toHaveLength(1);
    expect(visible[0]).toMatchObject({
      id: shared.id,
      name: "Renamed gateway",
      revision: shared.revision + 1,
      generation: shared.generation,
      sshHosts: expect.arrayContaining([
        { id: retained.id, displayName: retained.displayName },
        { id: selected.body.id, displayName: selected.body.displayName },
      ]),
    });
    expect(visible[0]?.sshHosts).toHaveLength(2);
  },
);

test.each(["create", "update"] as const)(
  "rejects selected %s after scope conversion during external login preparation without an orphan login",
  async (operation) => {
    const admin = await actor();
    const shared = await sharedConfig(admin);
    const member = await actor(admin.orgId, "member");
    const existing = (await accept(createHost(member), [201])).body;
    const beforeHosts = (
      await accept(hosts().list({ headers: member.headers }), [200])
    ).body;
    const beforeLogins = (
      await accept(credentials().list({ headers: member.headers }), [200])
    ).body;
    const preview = (
      await accept(
        configs().impactPreview({
          headers: admin.headers,
          params: { configId: shared.id },
          query: { operation: "convert" },
        }),
        [200],
      )
    ).body;

    useSecretKmsProbe(async (request, callNumber) => {
      if (callNumber === 1) {
        await accept(
          configs().convertToPersonal({
            headers: admin.headers,
            params: { configId: shared.id },
            body: {
              expectedRevision: preview.expectedRevision,
              impactSnapshot: preview.impactSnapshot,
            },
          }),
          [200],
        );
      }
      return {
        keyId: request.keyId,
        plaintext: Buffer.from("0123456789abcdef0123456789abcdef", "utf8"),
        encryptedDataKey: Buffer.from(
          `encrypted-data-key:${request.keyId}`,
          "utf8",
        ),
      };
    });
    const selected =
      operation === "create"
        ? accept(createHost(member, shared.id), [404])
        : accept(
            hosts().update({
              headers: member.headers,
              params: { connectionId: existing.id },
              body: {
                expectedGeneration: existing.generation,
                port: 443,
                credential: { create: login },
                transport: { type: "cloudflare_access", configId: shared.id },
              },
            }),
            [404],
          );
    expect((await selected).body.error.code).toBe(
      "CLOUDFLARE_ACCESS_NOT_FOUND",
    );
    expect(
      (await accept(hosts().list({ headers: member.headers }), [200])).body,
    ).toStrictEqual(beforeHosts);
    expect(
      (await accept(credentials().list({ headers: member.headers }), [200]))
        .body,
    ).toStrictEqual(beforeLogins);
    expect(
      (await accept(configs().list({ headers: member.headers, query }), [200]))
        .body.configs,
    ).toStrictEqual([]);
    expect(
      (await accept(configs().list({ headers: admin.headers, query }), [200]))
        .body.configs,
    ).toContainEqual(
      expect.objectContaining({
        id: shared.id,
        scope: "personal",
        revision: 2,
        generation: 2,
      }),
    );
  },
);

test.each(["create", "update"] as const)(
  "fences a concurrent selected %s against conversion and requires fresh impact before detaching it",
  async (operation) => {
    const admin = await actor();
    const shared = await sharedConfig(admin);
    const member = await actor(admin.orgId, "member");
    const direct = (await accept(createHost(member), [201])).body;
    const preview = (
      await accept(
        configs().impactPreview({
          headers: admin.headers,
          params: { configId: shared.id },
          query: { operation: "convert" },
        }),
        [200],
      )
    ).body;
    const selected =
      operation === "create"
        ? accept(createHost(member, shared.id), [201, 404])
        : accept(
            hosts().update({
              headers: member.headers,
              params: { connectionId: direct.id },
              body: {
                expectedGeneration: direct.generation,
                port: 443,
                credential: { create: login },
                transport: { type: "cloudflare_access", configId: shared.id },
              },
            }),
            [200, 404],
          );
    const [bound, converted] = await Promise.all([
      selected,
      accept(
        configs().convertToPersonal({
          headers: admin.headers,
          params: { configId: shared.id },
          body: {
            expectedRevision: preview.expectedRevision,
            impactSnapshot: preview.impactSnapshot,
          },
        }),
        [200, 409],
      ),
    ]);
    if (converted.status === 200) {
      expect(bound.status).toBe(404);
      expect(
        (await accept(hosts().list({ headers: member.headers }), [200])).body
          .connections,
      ).toStrictEqual([direct]);
      expect(
        (await accept(credentials().list({ headers: member.headers }), [200]))
          .body.credentials,
      ).toHaveLength(1);
    } else {
      expect([
        "CLOUDFLARE_ACCESS_REVISION_CONFLICT",
        "CLOUDFLARE_ACCESS_IMPACT_CONFLICT",
      ]).toContain(converted.body.error.code);
      expect(bound.status).toBe(operation === "create" ? 201 : 200);
      if (bound.status === 404) {
        throw new Error("Expected a binding that changed the reviewed impact");
      }
      const saved = bound;
      expect(
        (await accept(configs().list({ headers: admin.headers, query }), [200]))
          .body.configs,
      ).toContainEqual(
        expect.objectContaining({
          id: shared.id,
          scope: "organization",
          revision: shared.revision,
          generation: shared.generation,
        }),
      );
      expect(
        (await accept(hosts().list({ headers: member.headers }), [200])).body
          .connections,
      ).toContainEqual(saved.body);
      const latest = (
        await accept(
          configs().impactPreview({
            headers: admin.headers,
            params: { configId: shared.id },
            query: { operation: "convert" },
          }),
          [200],
        )
      ).body;
      expect(latest.otherHostCount).toBe(1);
      await accept(
        configs().convertToPersonal({
          headers: admin.headers,
          params: { configId: shared.id },
          body: {
            expectedRevision: latest.expectedRevision,
            impactSnapshot: latest.impactSnapshot,
          },
        }),
        [200],
      );
      expect(
        (await accept(hosts().list({ headers: member.headers }), [200])).body
          .connections,
      ).toContainEqual(
        expect.objectContaining({
          id: saved.body.id,
          credentialId: saved.body.credentialId,
          host: saved.body.host,
          port: 443,
          generation: saved.body.generation + 1,
          transport: { type: "cloudflare_access", needsRebind: true },
        }),
      );
    }
    expect(
      (await accept(configs().list({ headers: member.headers, query }), [200]))
        .body.configs,
    ).toStrictEqual([]);
  },
);

test("requires a fresh deletion preview for a first concurrent member binding", async () => {
  const admin = await actor();
  const shared = await sharedConfig(admin);
  const member = await actor(admin.orgId, "member");
  const preview = (
    await accept(
      configs().impactPreview({
        headers: admin.headers,
        params: { configId: shared.id },
        query: { operation: "delete" },
      }),
      [200],
    )
  ).body;
  const [bound, deleted] = await Promise.all([
    accept(createHost(member, shared.id), [201, 404]),
    accept(
      configs().delete({
        headers: admin.headers,
        params: { configId: shared.id },
        body: {
          expectedRevision: preview.expectedRevision,
          impactSnapshot: preview.impactSnapshot,
        },
      }),
      [204, 409],
    ),
  ]);
  if (deleted.status === 204) {
    expect(bound.status).toBe(404);
    expect(
      (await accept(hosts().list({ headers: member.headers }), [200])).body
        .connections,
    ).toStrictEqual([]);
    expect(
      (await accept(credentials().list({ headers: member.headers }), [200]))
        .body.credentials,
    ).toStrictEqual([]);
  } else {
    expect([
      "CLOUDFLARE_ACCESS_REVISION_CONFLICT",
      "CLOUDFLARE_ACCESS_IMPACT_CONFLICT",
    ]).toContain(deleted.body.error.code);
    const saved = await accept(Promise.resolve(bound), [201]);
    expect(
      (await accept(configs().list({ headers: admin.headers, query }), [200]))
        .body.configs,
    ).toContainEqual(
      expect.objectContaining({
        id: shared.id,
        scope: "organization",
        revision: shared.revision,
        generation: shared.generation,
      }),
    );
    expect(
      (await accept(hosts().list({ headers: member.headers }), [200])).body
        .connections,
    ).toContainEqual(saved.body);
    const latest = (
      await accept(
        configs().impactPreview({
          headers: admin.headers,
          params: { configId: shared.id },
          query: { operation: "delete" },
        }),
        [200],
      )
    ).body;
    expect(latest.otherHostCount).toBe(1);
    await accept(
      configs().delete({
        headers: admin.headers,
        params: { configId: shared.id },
        body: {
          expectedRevision: latest.expectedRevision,
          impactSnapshot: latest.impactSnapshot,
        },
      }),
      [204],
    );
    expect(
      (await accept(hosts().list({ headers: member.headers }), [200])).body
        .connections,
    ).toContainEqual(
      expect.objectContaining({
        id: saved.body.id,
        credentialId: saved.body.credentialId,
        generation: saved.body.generation + 1,
        port: 443,
        transport: { type: "cloudflare_access", needsRebind: true },
      }),
    );
  }
  expect(
    (await accept(configs().list({ headers: member.headers, query }), [200]))
      .body.configs,
  ).toStrictEqual([]);
});

test("promotes a configuration with a concurrent first binding or an explicit new request after conflict", async () => {
  const owner = await actor();
  const personal = (
    await accept(
      configs().create({
        headers: owner.headers,
        query,
        body: {
          id: randomUUID(),
          scope: "personal",
          name: "Personal gateway",
          credentials: {
            clientId: "synthetic-id",
            clientSecret: "synthetic-secret",
          },
        },
      }),
      [201],
    )
  ).body;
  const [bound, promoted] = await Promise.all([
    accept(createHost(owner, personal.id), [201]),
    accept(
      configs().convertToOrganization({
        headers: owner.headers,
        params: { configId: personal.id },
        body: { expectedRevision: personal.revision },
      }),
      [200, 409],
    ),
  ]);
  if (promoted.status === 409) {
    expect(promoted.body.error.code).toBe(
      "CLOUDFLARE_ACCESS_REVISION_CONFLICT",
    );
    expect(
      (await accept(configs().list({ headers: owner.headers, query }), [200]))
        .body.configs,
    ).toContainEqual(
      expect.objectContaining({
        id: personal.id,
        scope: "personal",
        revision: personal.revision,
        generation: personal.generation,
      }),
    );
    expect(
      (await accept(hosts().list({ headers: owner.headers }), [200])).body
        .connections,
    ).toStrictEqual([bound.body]);
  }
  const completed =
    promoted.status === 409
      ? await accept(
          configs().convertToOrganization({
            headers: owner.headers,
            params: { configId: personal.id },
            body: { expectedRevision: personal.revision },
          }),
          [200],
        )
      : promoted;
  expect(completed.body).toMatchObject({
    scope: "organization",
    revision: personal.revision + 1,
    generation: personal.generation + 1,
  });
  const included = completed.body.sshHosts.some(({ id }) => {
    return id === bound.body.id;
  });
  expect(
    (await accept(hosts().list({ headers: owner.headers }), [200])).body
      .connections,
  ).toContainEqual({
    ...bound.body,
    generation: bound.body.generation + (included ? 1 : 0),
    // Promotion updates included hosts; only an unincluded host is unchanged.
    updatedAt: included ? expect.any(String) : bound.body.updatedAt,
  });
  expect(
    (await accept(configs().list({ headers: owner.headers, query }), [200]))
      .body.configs,
  ).toContainEqual(
    expect.objectContaining({
      id: personal.id,
      scope: "organization",
      revision: personal.revision + 1,
      generation: personal.generation + 1,
      sshHosts: [{ id: bound.body.id, displayName: bound.body.displayName }],
    }),
  );
});

test.each(["first", "late"] as const)(
  "includes %s concurrent bindings in current rotation authority without losing existing hosts",
  async (timing) => {
    const owner = await actor();
    const shared = await sharedConfig(owner);
    const existing =
      timing === "late"
        ? (await accept(createHost(owner, shared.id), [201])).body
        : undefined;
    const [rotated, first, second] = await Promise.all([
      accept(
        configs().update({
          headers: owner.headers,
          query,
          params: { configId: shared.id },
          body: {
            expectedRevision: shared.revision,
            credentials: {
              clientId: "rotated-id",
              clientSecret: "rotated-secret",
            },
          },
        }),
        [200, 409],
      ),
      accept(createHost(owner, shared.id), [201]),
      accept(createHost(owner, shared.id), [201]),
    ]);
    if (rotated.status === 409) {
      // An arriving binding may expand the single attempt's locked set. That
      // conflict must leave authority untouched, not silently replay a write.
      expect(rotated.body.error.code).toBe(
        "CLOUDFLARE_ACCESS_REVISION_CONFLICT",
      );
      const unchanged = (
        await accept(configs().list({ headers: owner.headers, query }), [200])
      ).body.configs;
      expect(unchanged).toContainEqual(
        expect.objectContaining({ id: shared.id, revision: 1, generation: 1 }),
      );
      const unchangedHosts = (
        await accept(hosts().list({ headers: owner.headers }), [200])
      ).body.connections;
      for (const saved of unchangedHosts) {
        expect(saved.generation).toBe(1);
        expect(saved).toMatchObject({
          transport: { type: "cloudflare_access", configId: shared.id },
        });
      }
      // The caller reviews the unchanged configuration after both saves finish
      // and explicitly makes a new request; this is not an automatic retry.
      await accept(
        configs().update({
          headers: owner.headers,
          query,
          params: { configId: shared.id },
          body: {
            expectedRevision: shared.revision,
            credentials: {
              clientId: "rotated-id",
              clientSecret: "rotated-secret",
            },
          },
        }),
        [200],
      );
    } else {
      expect(rotated.body).toMatchObject({ revision: 2, generation: 2 });
    }
    const listed = (
      await accept(hosts().list({ headers: owner.headers }), [200])
    ).body.connections;
    for (const created of [first.body, second.body]) {
      const saved = listed.find(({ id }) => {
        return id === created.id;
      });
      expect(saved).toMatchObject({
        credentialId: created.credentialId,
        host: created.host,
        port: 443,
        transport: { type: "cloudflare_access", configId: shared.id },
      });
      expect([created.generation, created.generation + 1]).toContain(
        saved?.generation,
      );
    }
    if (existing) {
      expect(listed).toContainEqual(
        expect.objectContaining({
          id: existing.id,
          generation: existing.generation + 1,
        }),
      );
    }
    const current = (
      await accept(configs().list({ headers: owner.headers, query }), [200])
    ).body.configs;
    expect(current).toContainEqual(
      expect.objectContaining({
        id: shared.id,
        revision: 2,
        generation: 2,
        sshHosts: expect.arrayContaining([
          expect.objectContaining({ id: first.body.id }),
          expect.objectContaining({ id: second.body.id }),
        ]),
      }),
    );
  },
);

test.each(["rotate", "convert", "delete"] as const)(
  "preserves revision authority when metadata rename races configuration %s",
  async (operation) => {
    const admin = await actor();
    const shared = await sharedConfig(admin);
    const member = await actor(admin.orgId, "member");
    const host = (await accept(createHost(member, shared.id), [201])).body;
    const beforeLogins = (
      await accept(credentials().list({ headers: member.headers }), [200])
    ).body;
    const preview = (
      await accept(
        configs().impactPreview({
          headers: admin.headers,
          params: { configId: shared.id },
          query: { operation: operation === "delete" ? "delete" : "convert" },
        }),
        [200],
      )
    ).body;
    const changing =
      operation === "rotate"
        ? accept(
            configs().update({
              headers: admin.headers,
              params: { configId: shared.id },
              query,
              body: {
                expectedRevision: shared.revision,
                credentials: {
                  clientId: "rotated-id",
                  clientSecret: "rotated-secret",
                },
              },
            }),
            [200, 409],
          )
        : operation === "convert"
          ? accept(
              configs().convertToPersonal({
                headers: admin.headers,
                params: { configId: shared.id },
                body: {
                  expectedRevision: preview.expectedRevision,
                  impactSnapshot: preview.impactSnapshot,
                },
              }),
              [200, 409],
            )
          : accept(
              configs().delete({
                headers: admin.headers,
                params: { configId: shared.id },
                body: {
                  expectedRevision: preview.expectedRevision,
                  impactSnapshot: preview.impactSnapshot,
                },
              }),
              [204, 409],
            );
    const [renamed, changed] = await Promise.all([
      accept(
        configs().update({
          headers: admin.headers,
          params: { configId: shared.id },
          query,
          body: { expectedRevision: shared.revision, name: "Renamed gateway" },
        }),
        [200, 404, 409],
      ),
      changing,
    ]);
    const current = (
      await accept(configs().list({ headers: admin.headers, query }), [200])
    ).body.configs;
    const saved = (
      await accept(hosts().list({ headers: member.headers }), [200])
    ).body.connections;
    if (renamed.status === 200) {
      if (changed.status !== 409) {
        throw new Error("Expected stale configuration authority to conflict");
      }
      expect(changed.body.error.code).toBe(
        "CLOUDFLARE_ACCESS_REVISION_CONFLICT",
      );
      expect(current).toHaveLength(1);
      expect(current[0]).toMatchObject({
        name: "Renamed gateway",
        scope: "organization",
        revision: shared.revision + 1,
        generation: shared.generation,
        sshHosts: [],
      });
      expect(saved).toStrictEqual([host]);
    } else {
      expect(renamed.body.error.code).toBe(
        renamed.status === 404
          ? "CLOUDFLARE_ACCESS_NOT_FOUND"
          : "CLOUDFLARE_ACCESS_REVISION_CONFLICT",
      );
      expect(changed.status).toBe(operation === "delete" ? 204 : 200);
      if (operation === "delete") {
        expect(current).toStrictEqual([]);
      } else {
        expect(current).toHaveLength(1);
        expect(current[0]).toMatchObject({
          name: shared.name,
          scope: operation === "convert" ? "personal" : "organization",
          revision: shared.revision + 1,
          generation: shared.generation + 1,
        });
      }
      expect(saved).toHaveLength(1);
      expect(saved[0]).toMatchObject({
        id: host.id,
        credentialId: host.credentialId,
        host: host.host,
        port: host.port,
        generation: host.generation + 1,
        transport:
          operation === "rotate"
            ? { type: "cloudflare_access", configId: shared.id }
            : { type: "cloudflare_access", needsRebind: true },
      });
    }
    expect(
      (await accept(credentials().list({ headers: member.headers }), [200]))
        .body,
    ).toStrictEqual(beforeLogins);
  },
);

test.each(["delete", "detach"] as const)(
  "retains reference-fence safety when a bound host concurrently leaves through %s",
  async (operation) => {
    const owner = await actor();
    const shared = await sharedConfig(owner);
    const host = (await accept(createHost(owner, shared.id), [201])).body;
    const beforeLogins = (
      await accept(credentials().list({ headers: owner.headers }), [200])
    ).body;
    const departing =
      operation === "delete"
        ? accept(
            hosts().delete({
              headers: owner.headers,
              params: { connectionId: host.id },
            }),
            [204],
          )
        : accept(
            hosts().update({
              headers: owner.headers,
              params: { connectionId: host.id },
              body: {
                expectedGeneration: host.generation,
                port: 22,
                transport: { type: "direct" },
              },
            }),
            [200, 409],
          );
    const [rotated, departed] = await Promise.all([
      accept(
        configs().update({
          headers: owner.headers,
          params: { configId: shared.id },
          query,
          body: {
            expectedRevision: shared.revision,
            credentials: {
              clientId: "rotated-id",
              clientSecret: "rotated-secret",
            },
          },
        }),
        [200],
      ),
      departing,
    ]);
    expect(rotated.body).toMatchObject({
      revision: shared.revision + 1,
      generation: shared.generation + 1,
    });
    const listed = (
      await accept(hosts().list({ headers: owner.headers }), [200])
    ).body.connections;
    const current = (
      await accept(configs().list({ headers: owner.headers, query }), [200])
    ).body.configs;
    if (departed.status === 409) {
      expect(departed.body.error.code).toBe("SSH_GENERATION_CONFLICT");
      expect(listed).toContainEqual(
        expect.objectContaining({
          id: host.id,
          generation: host.generation + 1,
          transport: { type: "cloudflare_access", configId: shared.id },
        }),
      );
      expect(current[0]?.sshHosts).toStrictEqual([
        { id: host.id, displayName: host.displayName },
      ]);
    } else {
      expect(current[0]?.sshHosts).toStrictEqual([]);
      if (operation === "delete") {
        expect(listed).toStrictEqual([]);
      } else {
        expect(listed).toContainEqual(
          expect.objectContaining({
            id: host.id,
            credentialId: host.credentialId,
            generation: host.generation + 1,
            port: 22,
          }),
        );
        expect(listed[0]).not.toHaveProperty("transport");
      }
    }
    expect(
      (await accept(credentials().list({ headers: owner.headers }), [200]))
        .body,
    ).toStrictEqual({
      credentials: beforeLogins.credentials.map((credential) => {
        return {
          ...credential,
          hosts: operation === "delete" ? [] : credential.hosts,
        };
      }),
    });
  },
);

test("serializes configuration rotation with independent-login deletion without losing the binding", async () => {
  const owner = await actor();
  const shared = await sharedConfig(owner);
  const host = (await accept(createHost(owner, shared.id), [201])).body;
  const [rotated, deleted] = await Promise.all([
    accept(
      configs().update({
        headers: owner.headers,
        query,
        params: { configId: shared.id },
        body: {
          expectedRevision: 1,
          credentials: {
            clientId: "rotated-id",
            clientSecret: "rotated-secret",
          },
        },
      }),
      [200],
    ),
    accept(
      credentials().delete({
        headers: owner.headers,
        params: { credentialId: host.credentialId },
        body: { expectedRevision: 1 },
      }),
      [409],
    ),
  ]);
  expect(rotated.body.generation).toBe(2);
  expect(deleted.body.error.code).toBe("SSH_CREDENTIAL_IN_USE");
  expect(
    (await accept(hosts().list({ headers: owner.headers }), [200])).body
      .connections,
  ).toContainEqual(
    expect.objectContaining({
      id: host.id,
      credentialId: host.credentialId,
      generation: host.generation + 1,
      transport: { type: "cloudflare_access", configId: shared.id },
    }),
  );
  expect(
    (await accept(credentials().list({ headers: owner.headers }), [200])).body
      .credentials,
  ).toContainEqual(
    expect.objectContaining({
      id: host.credentialId,
      revision: 1,
      username: "deploy",
    }),
  );
});

test.each(["delete", "demote"] as const)(
  "rejects a binding after selected Access %s during KMS without creating a login",
  async (operation) => {
    const admin = await actor();
    const shared = await sharedConfig(admin);
    const member = await actor(admin.orgId, "member");
    const direct = (await accept(createHost(member), [201])).body;
    const before = (
      await accept(credentials().list({ headers: member.headers }), [200])
    ).body;
    const preview = (
      await accept(
        configs().impactPreview({
          headers: admin.headers,
          params: { configId: shared.id },
          query: { operation: "convert" },
        }),
        [200],
      )
    ).body;
    useSecretKmsProbe(async (request, callNumber) => {
      if (callNumber === 1) {
        if (operation === "delete") {
          await accept(
            configs().delete({
              headers: admin.headers,
              params: { configId: shared.id },
              body: { expectedRevision: shared.revision },
            }),
            [204],
          );
        } else {
          await accept(
            configs().convertToPersonal({
              headers: admin.headers,
              params: { configId: shared.id },
              body: {
                expectedRevision: preview.expectedRevision,
                impactSnapshot: preview.impactSnapshot,
              },
            }),
            [200],
          );
        }
      }
      return {
        keyId: request.keyId,
        plaintext: Buffer.alloc(32, 7),
        encryptedDataKey: Buffer.from(`encrypted:${request.keyId}`, "utf8"),
      };
    });
    const rejected = await accept(
      hosts().update({
        headers: member.headers,
        params: { connectionId: direct.id },
        body: {
          expectedGeneration: direct.generation,
          port: 443,
          credential: { create: login },
          transport: { type: "cloudflare_access", configId: shared.id },
        },
      }),
      [404],
    );
    expect(rejected.body.error.code).toBe("CLOUDFLARE_ACCESS_NOT_FOUND");
    expect(
      (await accept(credentials().list({ headers: member.headers }), [200]))
        .body,
    ).toStrictEqual(before);
    expect(
      (await accept(hosts().list({ headers: member.headers }), [200])).body
        .connections,
    ).toStrictEqual([direct]);
    expect(
      (await accept(configs().list({ headers: member.headers, query }), [200]))
        .body.configs,
    ).toStrictEqual([]);
  },
);

test("creates neither inline resource when its owned host is deleted during KMS", async () => {
  const owner = await actor();
  const direct = (await accept(createHost(owner), [201])).body;
  const beforeLogins = (
    await accept(credentials().list({ headers: owner.headers }), [200])
  ).body.credentials;
  useSecretKmsProbe(async (request, callNumber) => {
    if (callNumber === 1) {
      await accept(
        hosts().delete({
          headers: owner.headers,
          params: { connectionId: direct.id },
        }),
        [204],
      );
    }
    return {
      keyId: request.keyId,
      plaintext: Buffer.alloc(32, 7),
      encryptedDataKey: Buffer.from(`encrypted:${request.keyId}`, "utf8"),
    };
  });
  const rejected = await accept(
    hosts().update({
      headers: owner.headers,
      params: { connectionId: direct.id },
      body: {
        expectedGeneration: direct.generation,
        port: 443,
        credential: { create: login },
        transport: {
          type: "cloudflare_access",
          create: {
            name: "Rejected gateway",
            credentials: {
              clientId: "rejected-id",
              clientSecret: "rejected-secret",
            },
          },
        },
      },
    }),
    [404],
  );
  expect(rejected.body.error.code).toBe("SSH_CONNECTION_NOT_FOUND");
  expect(
    (await accept(hosts().list({ headers: owner.headers }), [200])).body
      .connections,
  ).toStrictEqual([]);
  expect(
    (await accept(configs().list({ headers: owner.headers, query }), [200]))
      .body.configs,
  ).toStrictEqual([]);
  expect(
    (await accept(credentials().list({ headers: owner.headers }), [200])).body
      .credentials,
  ).toStrictEqual(
    beforeLogins.map((credential) => {
      return { ...credential, hosts: [] };
    }),
  );
});

test("rejects an inline login on a host needing rebind until a transport is explicitly selected", async () => {
  const admin = await actor();
  const shared = await sharedConfig(admin);
  const member = await actor(admin.orgId, "member");
  const bound = (await accept(createHost(member, shared.id), [201])).body;
  const preview = (
    await accept(
      configs().impactPreview({
        headers: admin.headers,
        params: { configId: shared.id },
        query: { operation: "convert" },
      }),
      [200],
    )
  ).body;
  await accept(
    configs().convertToPersonal({
      headers: admin.headers,
      params: { configId: shared.id },
      body: {
        expectedRevision: preview.expectedRevision,
        impactSnapshot: preview.impactSnapshot,
      },
    }),
    [200],
  );
  const beforeHosts = (
    await accept(hosts().list({ headers: member.headers }), [200])
  ).body;
  const beforeLogins = (
    await accept(credentials().list({ headers: member.headers }), [200])
  ).body;
  const rejected = await accept(
    hosts().update({
      headers: member.headers,
      params: { connectionId: bound.id },
      body: {
        expectedGeneration: bound.generation + 1,
        credential: { create: login },
      },
    }),
    [400],
  );
  expect(rejected.body.error.code).toBe("SSH_INVALID_INPUT");
  expect(
    (await accept(hosts().list({ headers: member.headers }), [200])).body,
  ).toStrictEqual(beforeHosts);
  expect(
    (await accept(credentials().list({ headers: member.headers }), [200])).body,
  ).toStrictEqual(beforeLogins);
  expect(
    (await accept(configs().list({ headers: member.headers, query }), [200]))
      .body.configs,
  ).toStrictEqual([]);
});

describe("protected host writes with authorized Runner authority", () => {
  afterEach(ordinary.cleanup);

  async function claimedHost() {
    const owner = await actor();
    const runtime = await ordinary.runtime(owner);
    const shared = await sharedConfig(owner);
    const host = (await accept(createHost(owner, shared.id), [201])).body;
    await accept(
      setupApp({ context, routes: chatRemoteAccessRoutes })(
        chatRemoteAccessContract,
      ).updateHostDefault({
        headers: owner.headers,
        params: { protocol: "ssh", connectionId: host.id },
        body: { enabled: true },
      }),
      [200],
    );
    const runner = setupApp({ context, routes: runnerSshRoutes })(
      runnerSshContract,
    );
    const request = {
      headers: runnerHeaders,
      params: { runId: runtime.runId },
      body: { connectionId: host.id, runnerIdentity: runtime.runnerIdentity },
    };
    return { owner, shared, host, runner, request };
  }

  it.each(["personal", "organization"] as const)(
    "keeps the first %s same-ID creation immutable across concurrent requests and changed-payload replays",
    async (scope) => {
      const owner = await actor();
      const runtime = await ordinary.runtime(owner);
      const second =
        scope === "organization" ? await actor(owner.orgId) : owner;
      const id = randomUUID();
      const payloads = [
        {
          id,
          scope,
          name: "First gateway",
          credentials: { clientId: "first-id", clientSecret: "first-secret" },
        },
        {
          id,
          scope,
          name: "Second gateway",
          credentials: { clientId: "second-id", clientSecret: "second-secret" },
        },
      ];
      context.mocks.ably.publish.mockRejectedValue(
        new Error("Realtime unavailable"),
      );
      const results = await Promise.all(
        payloads.map((body, index) => {
          return accept(
            configs().create({
              headers: index === 0 ? owner.headers : second.headers,
              query,
              body,
            }),
            [201, 204],
          );
        }),
      );
      expect(
        results
          .map(({ status }) => {
            return status;
          })
          .sort(),
      ).toStrictEqual([201, 204]);
      const created = results.find((result) => {
        return result.status === 201;
      });
      if (!created) {
        throw new Error("Expected one created configuration");
      }
      const original = payloads.find(({ name }) => {
        return name === created.body.name;
      });
      if (!original) {
        throw new Error("Expected the winning creation payload");
      }
      expect(created.body).toMatchObject({
        id,
        scope,
        revision: 1,
        generation: 1,
        sshHosts: [],
      });
      expect(JSON.stringify(created.body)).not.toContain(
        original.credentials.clientSecret,
      );
      await accept(
        configs().create({
          headers: second.headers,
          query,
          body: {
            id,
            scope,
            name: "Changed retry",
            credentials: { clientId: "retry-id", clientSecret: "retry-secret" },
          },
        }),
        [204],
      );
      expect(
        (await accept(configs().list({ headers: owner.headers, query }), [200]))
          .body.configs,
      ).toStrictEqual([created.body]);
      const member = await actor(owner.orgId, "member");
      expect(
        (
          await accept(
            configs().list({ headers: member.headers, query }),
            [200],
          )
        ).body.configs,
      ).toStrictEqual(scope === "organization" ? [created.body] : []);
      if (scope === "organization") {
        await accept(
          configs().create({ headers: member.headers, query, body: original }),
          [403],
        );
      }
      context.mocks.ably.publish.mockResolvedValue(undefined);
      const host = (await accept(createHost(owner, id), [201])).body;
      await accept(
        setupApp({ context, routes: chatRemoteAccessRoutes })(
          chatRemoteAccessContract,
        ).updateHostDefault({
          headers: owner.headers,
          params: { protocol: "ssh", connectionId: host.id },
          body: { enabled: true },
        }),
        [200],
      );
      const resolved = await accept(
        setupApp({ context, routes: runnerSshRoutes })(
          runnerSshContract,
        ).resolve({
          headers: runnerHeaders,
          params: { runId: runtime.runId },
          body: {
            connectionId: host.id,
            runnerIdentity: runtime.runnerIdentity,
          },
        }),
        [200],
      );
      expect(resolved.body).toMatchObject({
        outcome: "resolved_access",
        access: { configId: id, generation: 1, ...original.credentials },
      });
    },
  );

  it("preserves pin and observation authority across a concurrent metadata-only rename without rotating credentials", async () => {
    const { owner, shared, host, runner, request } = await claimedHost();
    const member = await actor(owner.orgId, "member");
    await accept(createHost(member, shared.id), [201]);
    const beforeOther = (
      await accept(hosts().list({ headers: member.headers }), [200])
    ).body;
    const beforeLogins = (
      await accept(credentials().list({ headers: owner.headers }), [200])
    ).body;
    const [renamed, pinned, observed] = await Promise.all([
      accept(
        configs().update({
          headers: owner.headers,
          params: { configId: shared.id },
          query,
          body: { expectedRevision: shared.revision, name: "Renamed gateway" },
        }),
        [200],
      ),
      accept(
        runner.pin({
          ...request,
          body: {
            ...request.body,
            expectedGeneration: host.generation,
            observedHostKey: hostKey,
          },
        }),
        [200],
      ),
      accept(
        runner.observe({
          ...request,
          body: {
            ...request.body,
            expectedGeneration: host.generation,
            observedAt: nowDate().toISOString(),
            failureReason: null,
          },
        }),
        [200],
      ),
    ]);
    expect(renamed.body).toMatchObject({
      name: "Renamed gateway",
      revision: shared.revision + 1,
      generation: shared.generation,
    });
    expect(renamed.body.sshHosts).toStrictEqual([
      { id: host.id, displayName: host.displayName },
    ]);
    expect(pinned.body).toStrictEqual({
      outcome: "pinned",
      generation: host.generation + 1,
    });
    expect(["recorded", "ignored"]).toContain(observed.body.outcome);
    expect(
      (await accept(hosts().list({ headers: owner.headers }), [200])).body
        .connections,
    ).toContainEqual(
      expect.objectContaining({
        id: host.id,
        credentialId: host.credentialId,
        host: host.host,
        port: host.port,
        generation: host.generation + 1,
        learnedHostKey: hostKey,
        transport: { type: "cloudflare_access", configId: shared.id },
      }),
    );
    expect(
      (await accept(hosts().list({ headers: member.headers }), [200])).body,
    ).toStrictEqual(beforeOther);
    expect((await accept(runner.resolve(request), [200])).body).toMatchObject({
      outcome: "resolved_access",
      generation: host.generation + 1,
      learnedHostKey: hostKey,
      username: login.username,
      authentication: {
        method: "password",
        password: login.authentication.password,
      },
      access: {
        configId: shared.id,
        generation: shared.generation,
        clientId: "synthetic-id",
        clientSecret: "synthetic-secret",
      },
    });
    expect(
      (await accept(hosts().observations({ headers: owner.headers }), [200]))
        .body.observations,
    ).toStrictEqual([]);
    expect(
      (await accept(credentials().list({ headers: owner.headers }), [200]))
        .body,
    ).toStrictEqual(beforeLogins);
  });

  it("rejects an edit delayed at KMS after Runner learns trust, without replacing the pin or leaving an inline login", async () => {
    const { owner, shared, host, runner, request } = await claimedHost();
    const beforeLogins = (
      await accept(credentials().list({ headers: owner.headers }), [200])
    ).body;
    const beforeConfigs = (
      await accept(configs().list({ headers: owner.headers, query }), [200])
    ).body;
    useSecretKmsProbe(async (kmsRequest, callNumber) => {
      if (callNumber === 1) {
        expect(
          (
            await accept(
              runner.pin({
                ...request,
                body: {
                  ...request.body,
                  expectedGeneration: host.generation,
                  observedHostKey: hostKey,
                },
              }),
              [200],
            )
          ).body,
        ).toMatchObject({ outcome: "pinned", generation: host.generation + 1 });
      }
      return {
        keyId: kmsRequest.keyId,
        plaintext: Buffer.from("0123456789abcdef0123456789abcdef", "utf8"),
        encryptedDataKey: Buffer.from(
          `encrypted-data-key:${kmsRequest.keyId}`,
          "utf8",
        ),
      };
    });
    const edited = await accept(
      hosts().update({
        headers: owner.headers,
        params: { connectionId: host.id },
        body: {
          expectedGeneration: host.generation,
          credential: {
            create: {
              ...login,
              authentication: {
                method: "password",
                password: "never-committed-password",
              },
            },
          },
          transport: {
            type: "cloudflare_access",
            create: {
              name: "Never committed gateway",
              credentials: {
                clientId: "never-committed-id",
                clientSecret: "never-committed-secret",
              },
            },
          },
        },
      }),
      [409],
    );
    expect(edited.body.error.code).toBe("SSH_GENERATION_CONFLICT");
    expect(
      (await accept(configs().list({ headers: owner.headers, query }), [200]))
        .body,
    ).toStrictEqual(beforeConfigs);
    expect(
      (await accept(credentials().list({ headers: owner.headers }), [200]))
        .body,
    ).toStrictEqual(beforeLogins);
    expect(
      (await accept(hosts().list({ headers: owner.headers }), [200])).body
        .connections,
    ).toContainEqual(
      expect.objectContaining({
        id: host.id,
        host: host.host,
        port: host.port,
        credentialId: host.credentialId,
        generation: host.generation + 1,
        learnedHostKey: hostKey,
        transport: { type: "cloudflare_access", configId: shared.id },
      }),
    );
    expect((await accept(runner.resolve(request), [200])).body).toMatchObject({
      outcome: "resolved_access",
      generation: host.generation + 1,
      learnedHostKey: hostKey,
      authentication: {
        method: "password",
        password: login.authentication.password,
      },
      access: { configId: shared.id, generation: shared.generation },
    });
  });

  it("serializes rotation with pin and observation, retaining learned trust and independent login", async () => {
    const { owner, shared, host, runner, request } = await claimedHost();
    const [rotated, pinned, observed] = await Promise.all([
      accept(
        configs().update({
          headers: owner.headers,
          query,
          params: { configId: shared.id },
          body: {
            expectedRevision: shared.revision,
            credentials: {
              clientId: "rotated-id",
              clientSecret: "rotated-secret",
            },
          },
        }),
        [200],
      ),
      accept(
        runner.pin({
          ...request,
          body: {
            ...request.body,
            expectedGeneration: host.generation,
            observedHostKey: hostKey,
          },
        }),
        [200],
      ),
      accept(
        runner.observe({
          ...request,
          body: {
            ...request.body,
            expectedGeneration: host.generation,
            observedAt: nowDate().toISOString(),
            failureReason: null,
          },
        }),
        [200],
      ),
    ]);
    expect(rotated.body).toMatchObject({ revision: 2, generation: 2 });
    expect(["pinned", "configuration_changed"]).toContain(pinned.body.outcome);
    expect(["recorded", "ignored"]).toContain(observed.body.outcome);
    const saved = (
      await accept(hosts().list({ headers: owner.headers }), [200])
    ).body.connections.find(({ id }) => {
      return id === host.id;
    });
    if (!saved) {
      throw new Error("Expected the retained protected SSH host");
    }
    expect(saved).toMatchObject({
      credentialId: host.credentialId,
      host: host.host,
      port: host.port,
      transport: { type: "cloudflare_access", configId: shared.id },
    });
    expect(saved.generation).toBe(
      host.generation + 1 + Number(pinned.body.outcome === "pinned"),
    );
    if (pinned.body.outcome === "pinned") {
      expect(saved.learnedHostKey).toStrictEqual(hostKey);
    } else {
      expect(saved.learnedHostKey).toBeNull();
      expect(
        (
          await accept(
            runner.pin({
              ...request,
              body: {
                ...request.body,
                expectedGeneration: saved.generation,
                observedHostKey: hostKey,
              },
            }),
            [200],
          )
        ).body,
      ).toMatchObject({ outcome: "pinned", generation: saved.generation + 1 });
    }
    expect((await accept(runner.resolve(request), [200])).body).toMatchObject({
      outcome: "resolved_access",
      username: login.username,
      authentication: {
        method: "password",
        password: login.authentication.password,
      },
      learnedHostKey: hostKey,
      access: {
        configId: shared.id,
        generation: 2,
        clientId: "rotated-id",
        clientSecret: "rotated-secret",
      },
    });
    expect(
      (await accept(hosts().observations({ headers: owner.headers }), [200]))
        .body.observations,
    ).toStrictEqual([]);
    expect(
      (await accept(credentials().list({ headers: owner.headers }), [200])).body
        .credentials,
    ).toContainEqual(
      expect.objectContaining({
        id: host.credentialId,
        revision: 1,
        username: login.username,
      }),
    );
  });
});
