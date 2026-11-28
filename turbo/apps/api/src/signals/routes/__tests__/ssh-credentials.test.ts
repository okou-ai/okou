import { randomUUID } from "node:crypto";

import { sshConnectionsContract } from "@okouai/api-contracts/contracts/ssh-connections";
import { sshCredentialsContract } from "@okouai/api-contracts/contracts/ssh-credentials";
import { createStore } from "ccstate";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp, setupRawAppRequest } from "../../../__tests__/test-helpers";
import { sshConnectionsRoutes } from "../ssh-connections";
import { seedOrgMembership$ } from "./helpers/org-membership";
import { createRouteMocks } from "./helpers/route-test";
import { useSecretKmsProbe } from "./helpers/secret-kms-probe";
import { credentialBackedSshHost } from "./helpers/ssh-credential";
import { createDeferredPromise } from "../../utils";

const context = testContext();
const headers = Object.freeze({ authorization: "Bearer clerk-session" });

interface Actor {
  readonly userId: string;
  readonly orgId: string;
}

const clerkDirectory = createStore();

async function newActor(ids: Partial<Actor> = {}): Promise<Actor> {
  const actor = {
    userId: ids.userId ?? `user_${randomUUID()}`,
    orgId: ids.orgId ?? `org_${randomUUID()}`,
  };
  await clerkDirectory.set(
    seedOrgMembership$,
    { ...actor, role: "admin" },
    context.signal,
  );
  return actor;
}

function signIn(actor: Actor) {
  createRouteMocks(context).clerk.session(actor.userId, actor.orgId);
}

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

async function createPasswordLogin(
  name = "Deploy login",
  password = `pw-${randomUUID()}`,
) {
  return (
    await accept(
      credentials().create({
        headers,
        body: {
          id: randomUUID(),
          name,
          username: "deploy",
          authentication: { method: "password", password },
        },
      }),
      [201],
    )
  ).body;
}

function attachHost(credentialId: string, displayName: string, host: string) {
  return hosts().create({
    headers,
    body: {
      id: randomUUID(),
      displayName,
      host,
      credential: { id: credentialId },
    },
  });
}

async function listCredentials() {
  return (await accept(credentials().list({ headers }), [200])).body
    .credentials;
}

async function listHosts() {
  return (await accept(hosts().list({ headers }), [200])).body.connections;
}

function deleteCredential(credentialId: string, expectedRevision: number) {
  return credentials().delete({
    headers,
    params: { credentialId },
    body: { expectedRevision },
  });
}

function byId<T extends { readonly id: string }>(items: readonly T[]) {
  return [...items].sort((a, b) => {
    return a.id.localeCompare(b.id);
  });
}

function gate() {
  const deferred = createDeferredPromise<void>(context.signal);
  const open = () => {
    if (!deferred.settled()) {
      deferred.resolve();
    }
  };
  return { open, opened: deferred.promise };
}

function expectNoSecret(value: unknown, secret: string) {
  const text = JSON.stringify(value);
  expect(text).not.toContain(secret);
  expect(text).not.toContain("vm0secret:");
  expect(text).not.toContain("authentication");
  expect(text.toLowerCase()).not.toContain("encrypted");
}

describe("reusable SSH credential owner routes", () => {
  it("ssh-credentials-001 listing credentials without a session is unauthorized", async () => {
    const response = await accept(credentials().list({ headers: {} }), [401]);

    expect(response.body.error.code).toBe("UNAUTHORIZED");
  });

  it("ssh-credentials-002 a shared login lists its hosts without secrets and survives host deletion", async () => {
    signIn(await newActor());
    const password = `secret-${randomUUID()}`;

    const created = await accept(
      credentials().create({
        headers,
        body: {
          id: randomUUID(),
          name: " Operations ",
          username: " deploy ",
          authentication: { method: "password", password },
        },
      }),
      [201],
    );
    expect(created.body).toMatchObject({
      name: "Operations",
      username: "deploy",
      authMethod: "password",
      revision: 1,
      hosts: [],
    });
    expect(created.headers.get("cache-control")).toBe("no-store");

    const first = await accept(
      attachHost(created.body.id, "First", "first.example.com"),
      [201],
    );
    const second = await accept(
      attachHost(created.body.id, "Second", "second.example.com"),
      [201],
    );
    const listed = await listCredentials();
    expect(listed).toHaveLength(1);
    expect(byId(listed[0]?.hosts ?? [])).toStrictEqual(
      byId([
        { id: first.body.id, displayName: "First" },
        { id: second.body.id, displayName: "Second" },
      ]),
    );
    for (const body of [created.body, listed, first.body, second.body]) {
      expectNoSecret(body, password);
    }

    const blocked = await accept(deleteCredential(created.body.id, 1), [409]);
    expect(blocked.body.error.code).toBe("SSH_CREDENTIAL_IN_USE");

    for (const host of [first.body, second.body]) {
      await accept(
        hosts().delete({
          headers,
          params: { connectionId: host.id },
          body: { expectedGeneration: host.generation },
        }),
        [204],
      );
    }
    await expect(listCredentials()).resolves.toStrictEqual([created.body]);

    await accept(deleteCredential(created.body.id, 1), [204]);
    await expect(listCredentials()).resolves.toStrictEqual([]);
  });

  it("ssh-credentials-003 deleting a login while it is rotated keeps the rotated login in use", async () => {
    signIn(await newActor());
    const login = await createPasswordLogin();
    const host = await accept(
      attachHost(login.id, "Build box", "build.example.com"),
      [201],
    );

    const [rotated, deleted] = await Promise.all([
      credentials().update({
        headers,
        params: { credentialId: login.id },
        body: {
          expectedRevision: 1,
          username: "rotated-delete-user",
          authentication: {
            method: "password",
            password: `rotated-${randomUUID()}`,
          },
        },
      }),
      deleteCredential(login.id, 1),
    ]);

    const rotation = await accept(Promise.resolve(rotated), [200]);
    expect(rotation.body).toMatchObject({
      revision: 2,
      username: "rotated-delete-user",
      hosts: [{ id: host.body.id, displayName: "Build box" }],
    });
    await accept(Promise.resolve(deleted), [409]);
    await expect(listCredentials()).resolves.toStrictEqual([rotation.body]);
  });

  it("ssh-credentials-004 attaching a host while the login rotates leaves every host on the rotated login", async () => {
    signIn(await newActor());
    const login = await createPasswordLogin();
    const existing = await accept(
      attachHost(login.id, "Existing host", "first.example.com"),
      [201],
    );

    const [attached, rotated] = await Promise.all([
      attachHost(login.id, "New host", "second.example.com"),
      credentials().update({
        headers,
        params: { credentialId: login.id },
        body: { expectedRevision: 1, username: "rotated-user" },
      }),
    ]);
    const added = await accept(Promise.resolve(attached), [201]);
    await accept(Promise.resolve(rotated), [200]);

    const listedHosts = (await listHosts()).map(credentialBackedSshHost);
    expect(listedHosts).toHaveLength(2);
    const existingAfter = listedHosts.find((h) => {
      return h.id === existing.body.id;
    });
    const addedAfter = listedHosts.find((h) => {
      return h.id === added.body.id;
    });
    for (const host of [existingAfter, addedAfter]) {
      expect(host).toMatchObject({
        credentialId: login.id,
        username: "rotated-user",
      });
    }
    expect(existingAfter?.generation).toBe(2);
    expect([1, 2]).toContain(addedAfter?.generation);

    const [credential] = await listCredentials();
    expect(credential).toMatchObject({
      id: login.id,
      revision: 2,
      username: "rotated-user",
    });
    expect(byId(credential?.hosts ?? [])).toStrictEqual(
      byId([
        { id: existing.body.id, displayName: "Existing host" },
        { id: added.body.id, displayName: "New host" },
      ]),
    );
  });

  it("ssh-credentials-006 other users and organizations cannot see, edit, bind or delete a login", async () => {
    const kms = useSecretKmsProbe();
    const owner = await newActor();
    signIn(owner);
    const login = await createPasswordLogin();
    expect(kms.generateDataKeyCalls).toBe(1);

    const outsiders = [
      await newActor({ orgId: owner.orgId }),
      await newActor({ userId: owner.userId }),
    ];
    for (const outsider of outsiders) {
      signIn(outsider);
      await expect(listCredentials()).resolves.toStrictEqual([]);
      for (const credentialId of [login.id, randomUUID()]) {
        const update = await accept(
          credentials().update({
            headers,
            params: { credentialId },
            body: {
              expectedRevision: 1,
              authentication: {
                method: "password",
                password: `intruder-${randomUUID()}`,
              },
            },
          }),
          [404],
        );
        expect(update.body.error.code).toBe("SSH_CREDENTIAL_NOT_FOUND");
        const bind = await accept(
          attachHost(credentialId, "Borrowed", "borrowed.example.com"),
          [404],
        );
        expect(bind.body.error.code).toBe("SSH_CREDENTIAL_NOT_FOUND");
      }
      await accept(deleteCredential(login.id, 1), [404]);
      await expect(listHosts()).resolves.toStrictEqual([]);
    }

    expect(kms.generateDataKeyCalls).toBe(1);
  });

  it("ssh-credentials-007 malformed authentication is rejected without echoing the secret", async () => {
    const kms = useSecretKmsProbe();
    signIn(await newActor());
    const canary = `canary-${randomUUID()}`;
    const raw = setupRawAppRequest({ context, routes: sshConnectionsRoutes });
    const malformed = [
      { method: "password", password: canary, privateKey: canary },
      { method: "private_key", privateKey: canary, passphrase: "" },
      { method: "private_key", privateKey: canary, password: canary },
    ];

    for (const authentication of malformed) {
      const response = await raw("/api/ssh/credentials", {
        method: "POST",
        headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify({
          id: randomUUID(),
          name: "Broken login",
          username: "deploy",
          authentication,
        }),
      });
      expect(response.status).toBe(400);
      expect(JSON.stringify(response.body)).not.toContain(canary);
    }
    expect(kms.generateDataKeyCalls).toBe(0);
  });

  it("ssh-credentials-008 a stale edit finishing after a rename is rejected and the rename stays usable", async () => {
    const stalled = gate();
    const release = gate();
    const kms = useSecretKmsProbe((request, callNumber) => {
      if (callNumber !== 2) {
        return undefined;
      }
      stalled.open();
      return release.opened.then(() => {
        return {
          keyId: request.keyId,
          plaintext: Buffer.from("0123456789abcdef0123456789abcdef", "utf8"),
          encryptedDataKey: Buffer.from(`edk:${request.keyId}`, "utf8"),
        };
      });
    });
    signIn(await newActor());
    const login = await createPasswordLogin();

    const staleEdit = credentials().update({
      headers,
      params: { credentialId: login.id },
      body: {
        expectedRevision: 1,
        authentication: {
          method: "private_key",
          privateKey: `key-${randomUUID()}`,
          passphrase: null,
        },
      },
    });
    await stalled.opened;

    const renamed = await accept(
      credentials().update({
        headers,
        params: { credentialId: login.id },
        body: { expectedRevision: 1, name: "Concurrent winner" },
      }),
      [200],
    );
    expect(renamed.body).toMatchObject({
      name: "Concurrent winner",
      revision: 2,
      authMethod: "password",
    });

    release.open();
    const stale = await accept(staleEdit, [409]);
    expect(stale.body.error.code).toBe("SSH_CREDENTIAL_REVISION_CONFLICT");
    await expect(listCredentials()).resolves.toStrictEqual([renamed.body]);
    expect(kms.generateDataKeyCalls).toBe(2);

    const staleDelete = await accept(deleteCredential(login.id, 1), [409]);
    expect(staleDelete.body.error.code).toBe(
      "SSH_CREDENTIAL_REVISION_CONFLICT",
    );
    await accept(deleteCredential(login.id, 2), [204]);
  });
});
