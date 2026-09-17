import { randomUUID } from "node:crypto";
import { expect, test } from "vitest";
import { sshConnectionsContract } from "@okouai/api-contracts/contracts/ssh-connections";
import { sshCredentialsContract } from "@okouai/api-contracts/contracts/ssh-credentials";
import { cloudflareAccessContract } from "@okouai/api-contracts/contracts/cloudflare-access";
import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { createDeferredPromise } from "../../utils";
import { sshConnectionsRoutes } from "../ssh-connections";
import { cloudflareAccessRoutes } from "../cloudflare-access";
import { useSecretKmsProbe } from "./helpers/secret-kms-probe";
import { createRouteMocks } from "./helpers/route-test";

const context = testContext();
const mocks = createRouteMocks(context);
const headers = Object.freeze({ authorization: "Bearer clerk-session" });
const routes = Object.freeze([
  ...sshConnectionsRoutes,
  ...cloudflareAccessRoutes,
]);
const connections = () => {
  return setupApp({ context, routes })(sshConnectionsContract);
};
const credentials = () => {
  return setupApp({ context, routes })(sshCredentialsContract);
};
const access = () => {
  return setupApp({ context, routes })(cloudflareAccessContract);
};
const login = Object.freeze({
  name: "Deploy",
  username: "deploy",
  authentication: { method: "password" as const, password: "secret-password" },
});
const protection = Object.freeze({
  name: "Access",
  credentials: { clientId: "test.access", clientSecret: "secret-token" },
});
type Kind = "host" | "credential" | "access";

function owner(existing?: { orgId?: string; userId?: string }) {
  const value = {
    orgId: existing?.orgId ?? `org_retry_${randomUUID()}`,
    userId: existing?.userId ?? `user_retry_${randomUUID()}`,
  };
  mocks.clerk.session(value.userId, value.orgId);
  return value;
}
async function create(kind: Kind, id: string, name = "Original") {
  if (kind === "credential") {
    return await credentials().create({
      headers,
      body: { ...login, id, name },
    });
  }
  if (kind === "access") {
    return await access().create({
      headers,
      body: { ...protection, id, name },
    });
  }
  return await connections().create({
    headers,
    body: {
      id,
      displayName: name,
      host: "ssh.example.com",
      port: 443,
      credential: { create: login },
      transport: { type: "cloudflare_access", create: protection },
    },
  });
}
async function resources() {
  return {
    hosts: (await accept(connections().list({ headers }), [200])).body
      .connections,
    credentials: (await accept(credentials().list({ headers }), [200])).body
      .credentials,
    access: (await accept(access().list({ headers }), [200])).body.configs,
  };
}

test.each<Kind>(["host", "credential", "access"])(
  "concurrent %s retries acknowledge the same resource without duplicate writes",
  async (kind) => {
    useSecretKmsProbe();
    owner();
    const id = randomUUID();
    const results = await Promise.all([
      create(kind, id),
      create(kind, id.toUpperCase()),
    ]);
    expect(
      results
        .map((result) => {
          return result.status;
        })
        .sort(),
    ).toStrictEqual([201, 204]);
    const before = await resources();
    expect(before.hosts).toHaveLength(kind === "host" ? 1 : 0);
    expect(before.credentials).toHaveLength(kind === "access" ? 0 : 1);
    expect(before.access).toHaveLength(kind === "credential" ? 0 : 1);
    const repeated = await accept(create(kind, id, "Changed input"), [204]);
    expect(repeated.body).toBeUndefined();
    await expect(resources()).resolves.toStrictEqual(before);
  },
);

test("a delayed original request and its retry create only one set of inline resources", async () => {
  const entered = createDeferredPromise<void>(context.signal);
  const release = createDeferredPromise<void>(context.signal);
  useSecretKmsProbe(async (request, call) => {
    if (call === 1) {
      entered.resolve();
      await release.promise;
    }
    return {
      keyId: request.keyId,
      plaintext: Buffer.from("0123456789abcdef0123456789abcdef"),
      encryptedDataKey: Buffer.from(`encrypted-data-key:${request.keyId}`),
    };
  });
  owner();
  const id = randomUUID();
  const pending = create("host", id);
  await entered.promise;
  const retried = await create("host", id);
  release.resolve();
  expect(retried.status).toBe(201);
  await accept(pending, [204]);
  const current = await resources();
  expect(current.hosts).toHaveLength(1);
  expect(current.hosts[0]?.id).toBe(id);
  expect(current.credentials).toHaveLength(1);
  expect(current.access).toHaveLength(1);
});

test.each(["orgId", "userId"] as const)(
  "same-ID creation never acknowledges another owner sharing the %s",
  async (shared) => {
    useSecretKmsProbe();
    const first = owner();
    const id = randomUUID();
    for (const kind of ["host", "credential", "access"] as const) {
      await accept(create(kind, id), [201]);
    }
    owner({ [shared]: first[shared] });
    for (const kind of ["host", "credential", "access"] as const) {
      const denied = await accept(create(kind, id), [409]);
      expect(denied.body).toStrictEqual({
        error: {
          code: "SSH_RESOURCE_ID_CONFLICT",
          message:
            "This resource ID cannot be used for this SSH configuration.",
        },
      });
    }
    await expect(resources()).resolves.toStrictEqual({
      hosts: [],
      credentials: [],
      access: [],
    });
    mocks.clerk.session(first.userId, first.orgId);
    await accept(create("host", id), [204]);
    expect((await resources()).hosts).toHaveLength(1);
  },
);

test("an owner whose delayed create loses an ID race has no orphan inline resources", async () => {
  const entered = createDeferredPromise<void>(context.signal);
  const release = createDeferredPromise<void>(context.signal);
  useSecretKmsProbe(async (request, call) => {
    if (call === 1) {
      entered.resolve();
      await release.promise;
    }
    return {
      keyId: request.keyId,
      plaintext: Buffer.from("0123456789abcdef0123456789abcdef"),
      encryptedDataKey: Buffer.from(`encrypted-data-key:${request.keyId}`),
    };
  });
  const first = owner();
  const id = randomUUID();
  const delayed = create("host", id);
  await entered.promise;
  owner({ orgId: first.orgId });
  const winner = await create("host", id.toUpperCase());
  release.resolve();
  expect(winner.status).toBe(201);
  const denied = await accept(delayed, [409]);
  expect(denied.body.error.code).toBe("SSH_RESOURCE_ID_CONFLICT");
  mocks.clerk.session(first.userId, first.orgId);
  await expect(resources()).resolves.toStrictEqual({
    hosts: [],
    credentials: [],
    access: [],
  });
});

test("a known invalid create can be corrected without consuming its resource ID", async () => {
  useSecretKmsProbe();
  owner();
  const id = randomUUID();
  await accept(
    connections().create({
      headers,
      body: {
        id,
        displayName: "Invalid",
        host: "https://ssh.example.com",
        credential: { create: login },
      },
    }),
    [400],
  );
  await expect(resources()).resolves.toStrictEqual({
    hosts: [],
    credentials: [],
    access: [],
  });
  await accept(create("host", id), [201]);
});

test("host edit retries retain the expected generation and do not repeat inline creation", async () => {
  useSecretKmsProbe();
  owner();
  const created = await accept(
    connections().create({
      headers,
      body: {
        id: randomUUID(),
        displayName: "Original",
        host: "ssh.example.com",
        credential: { create: login },
      },
    }),
    [201],
  );
  const edit = {
    expectedGeneration: 1,
    credential: { create: { ...login, name: "Replacement" } },
    port: 443,
    transport: { type: "cloudflare_access" as const, create: protection },
  };
  const params = { connectionId: created.body.id };
  const results = await Promise.all([
    connections().update({ headers, params, body: edit }),
    connections().update({ headers, params, body: edit }),
  ]);
  expect(
    results
      .map((result) => {
        return result.status;
      })
      .sort(),
  ).toStrictEqual([200, 409]);
  const retry = await accept(
    connections().update({ headers, params, body: edit }),
    [409],
  );
  expect(retry.body.error.code).toBe("SSH_GENERATION_CONFLICT");
  const current = await resources();
  expect(current.hosts[0]).toMatchObject({
    generation: 2,
    credentialName: "Replacement",
  });
  expect(current.credentials).toHaveLength(2);
  expect(current.access).toHaveLength(1);
});
