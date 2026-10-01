import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { sshCredentialsContract } from "@okouai/api-contracts/contracts/ssh-credentials";
import { sshConnectionsContract } from "@okouai/api-contracts/contracts/ssh-connections";
import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp, setupRawAppRequest } from "../../../__tests__/test-helpers";
import { sshConnectionsRoutes } from "../ssh-connections";
import { createRouteMocks } from "./helpers/route-test";
import { useSecretKmsProbe } from "./helpers/secret-kms-probe";
import { createDeferredPromise } from "../../utils";

const context = testContext();
const mocks = createRouteMocks(context);
const headers = Object.freeze({ authorization: "Bearer clerk-session" });
function credentials() {
  return setupApp({ context, routes: sshConnectionsRoutes })(
    sshCredentialsContract,
  );
}
function connections() {
  return setupApp({ context, routes: sshConnectionsRoutes })(
    sshConnectionsContract,
  );
}
function owner(overrides: Partial<{ orgId: string; userId: string }> = {}) {
  const value = {
    orgId: `org_ssh_${randomUUID()}`,
    userId: `user_ssh_${randomUUID()}`,
    ...overrides,
  };
  mocks.clerk.session(value.userId, value.orgId);
  return value;
}
const passwordBody = {
  name: "  Operations  ",
  username: "  deploy  ",
  authentication: {
    method: "password" as const,
    password: "  password-canary\n",
  },
} as const;

describe("reusable SSH credential owner routes", () => {
  it("requires a session and rejects invalid input before encrypting secrets", async () => {
    const kms = useSecretKmsProbe();
    await accept(credentials().list({ headers: {} }), [401]);
    mocks.clerk.session(
      `user_invalid_${randomUUID()}`,
      `org_invalid_${randomUUID()}`,
    );
    const request = setupRawAppRequest({
      context,
      routes: sshConnectionsRoutes,
    });
    const invalid = await request("/api/ssh/credentials", {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ authentication: "invalid" }),
    });
    expect(invalid.status).toBe(400);
    expect(kms.generateDataKeyCalls).toBe(0);
  });

  it("shares named metadata, rejects referenced deletion, and preserves credentials after host deletion", async () => {
    useSecretKmsProbe();
    owner();
    const created = await accept(
      credentials().create({
        headers,
        body: { id: randomUUID(), ...passwordBody },
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
    const hosts = [];
    for (const displayName of ["First", "Second"]) {
      const result = await accept(
        connections().create({
          headers,
          body: {
            id: randomUUID(),
            displayName,
            host: "ssh.example.com",
            credential: { id: created.body.id },
          },
        }),
        [201],
      );
      hosts.push(result.body);
    }
    const listed = await accept(credentials().list({ headers }), [200]);
    expect(listed.body.credentials[0]?.hosts).toStrictEqual(
      expect.arrayContaining(
        hosts.map(({ id, displayName }) => {
          return { id, displayName };
        }),
      ),
    );
    for (const response of [created.body, listed.body, hosts]) {
      const serialized = JSON.stringify(response);
      for (const secret of [
        "password-canary",
        "encryptedPassword",
        "encryptedPrivateKey",
        "vm0secret:",
        "authentication",
      ]) {
        expect(serialized).not.toContain(secret);
      }
    }
    const params = { credentialId: created.body.id };
    expect(
      (
        await accept(
          credentials().delete({
            headers,
            params,
            body: { expectedRevision: 1 },
          }),
          [409],
        )
      ).body.error.code,
    ).toBe("SSH_CREDENTIAL_IN_USE");
    for (const host of hosts) {
      await accept(
        connections().delete({ headers, params: { connectionId: host.id } }),
        [204],
      );
    }
    expect(
      (await accept(credentials().list({ headers }), [200])).body.credentials,
    ).toStrictEqual([created.body]);
    await accept(
      credentials().delete({ headers, params, body: { expectedRevision: 1 } }),
      [204],
    );
    expect(
      (await accept(credentials().list({ headers }), [200])).body.credentials,
    ).toStrictEqual([]);
  });

  it("keeps every host on the current credential when attachment races rotation", async () => {
    useSecretKmsProbe();
    owner();
    const created = await accept(
      credentials().create({
        headers,
        body: { id: randomUUID(), ...passwordBody },
      }),
      [201],
    );
    const first = await accept(
      connections().create({
        headers,
        body: {
          id: randomUUID(),
          displayName: "Existing host",
          host: "first.example.com",
          credential: { id: created.body.id },
        },
      }),
      [201],
    );
    const [attached] = await Promise.all([
      accept(
        connections().create({
          headers,
          body: {
            id: randomUUID(),
            displayName: "New host",
            host: "second.example.com",
            credential: { id: created.body.id },
          },
        }),
        [201],
      ),
      accept(
        credentials().update({
          headers,
          params: { credentialId: created.body.id },
          body: { expectedRevision: 1, username: "rotated-user" },
        }),
        [200],
      ),
    ]);
    const listed = await accept(connections().list({ headers }), [200]);
    expect(listed.body.connections).toHaveLength(2);
    expect(listed.body.connections).toStrictEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: first.body.id,
          username: "rotated-user",
          generation: 2,
          credentialId: created.body.id,
        }),
        expect.objectContaining({
          id: attached.body.id,
          username: "rotated-user",
          // Attachment can commit before or after rotation's host UPDATE.
          // The host always resolves the current credential independently.
          generation: expect.toBeOneOf([1, 2]),
          credentialId: created.body.id,
        }),
      ]),
    );
    const current = await accept(credentials().list({ headers }), [200]);
    expect(current.body.credentials).toStrictEqual([
      expect.objectContaining({
        id: created.body.id,
        revision: 2,
        username: "rotated-user",
        hosts: expect.arrayContaining([
          { id: first.body.id, displayName: "Existing host" },
          { id: attached.body.id, displayName: "New host" },
        ]),
      }),
    ]);
  });

  it("resolves the current credential after concurrent low-frequency rotations", async () => {
    useSecretKmsProbe();
    owner();
    const created = await accept(
      credentials().create({
        headers,
        body: { id: randomUUID(), ...passwordBody },
      }),
      [201],
    );
    const host = await accept(
      connections().create({
        headers,
        body: {
          id: randomUUID(),
          displayName: "Shared",
          host: "ssh.example.com",
          credential: { id: created.body.id },
        },
      }),
      [201],
    );
    const results = await Promise.all(
      ["first-user", "second-user"].map((username) => {
        return accept(
          credentials().update({
            headers,
            params: { credentialId: created.body.id },
            body: { expectedRevision: 1, username },
          }),
          [200, 409],
        );
      }),
    );
    expect(
      results.some((result) => {
        return result.status === 200;
      }),
    ).toBeTruthy();
    const current = await accept(credentials().list({ headers }), [200]);
    const credential = current.body.credentials[0];
    expect(credential).toBeDefined();
    expect(credential?.username).toBeOneOf(["first-user", "second-user"]);
    const listed = await accept(connections().list({ headers }), [200]);
    expect(listed.body.connections).toStrictEqual([
      expect.objectContaining({
        id: host.body.id,
        credentialId: created.body.id,
        username: credential?.username,
      }),
    ]);
  });

  it("resolves the current credential after a host edit overlaps rotation", async () => {
    useSecretKmsProbe();
    owner();
    const created = await accept(
      credentials().create({
        headers,
        body: { id: randomUUID(), ...passwordBody },
      }),
      [201],
    );
    const host = await accept(
      connections().create({
        headers,
        body: {
          id: randomUUID(),
          displayName: "Original",
          host: "ssh.example.com",
          credential: { id: created.body.id },
        },
      }),
      [201],
    );
    const [edited] = await Promise.all([
      accept(
        connections().update({
          headers,
          params: { connectionId: host.body.id },
          body: { expectedGeneration: 1, displayName: "Edited" },
        }),
        [200, 409],
      ),
      accept(
        credentials().update({
          headers,
          params: { credentialId: created.body.id },
          body: { expectedRevision: 1, username: "rotated-user" },
        }),
        [200],
      ),
    ]);
    const listed = await accept(connections().list({ headers }), [200]);
    expect(listed.body.connections).toStrictEqual([
      expect.objectContaining({
        id: host.body.id,
        credentialId: created.body.id,
        username: "rotated-user",
        displayName: edited.status === 200 ? "Edited" : "Original",
        generation: edited.status === 200 ? 3 : 2,
      }),
    ]);
    const current = await accept(credentials().list({ headers }), [200]);
    expect(current.body.credentials).toStrictEqual([
      expect.objectContaining({ id: created.body.id, revision: 2 }),
    ]);
  });

  it("hides other users and organizations before KMS work or binding", async () => {
    const kms = useSecretKmsProbe();
    const first = owner();
    const created = await accept(
      credentials().create({
        headers,
        body: { id: randomUUID(), ...passwordBody },
      }),
      [201],
    );
    for (const other of [{ orgId: first.orgId }, { userId: first.userId }]) {
      owner(other);
      const params = { credentialId: created.body.id };
      expect(
        (await accept(credentials().list({ headers }), [200])).body.credentials,
      ).toStrictEqual([]);
      for (const credentialId of [created.body.id, randomUUID()]) {
        const update = await accept(
          credentials().update({
            headers,
            params: { credentialId },
            body: {
              expectedRevision: 1,
              authentication: passwordBody.authentication,
            },
          }),
          [404],
        );
        expect(update.body.error.code).toBe("SSH_CREDENTIAL_NOT_FOUND");
        const bind = await accept(
          connections().create({
            headers,
            body: {
              id: randomUUID(),
              displayName: "Denied",
              host: "ssh.example.com",
              credential: { id: credentialId },
            },
          }),
          [404],
        );
        expect(bind.body.error.code).toBe("SSH_CREDENTIAL_NOT_FOUND");
      }
      await accept(
        credentials().delete({
          headers,
          params,
          body: { expectedRevision: 1 },
        }),
        [404],
      );
      expect(
        (await accept(connections().list({ headers }), [200])).body.connections,
      ).toStrictEqual([]);
    }
    expect(kms.generateDataKeyCalls).toBe(1);
  });

  it("rejects malformed authentication without logging or echoing supplied secrets", async () => {
    const kms = useSecretKmsProbe();
    owner();
    const request = setupRawAppRequest({
      context,
      routes: sshConnectionsRoutes,
    });
    for (const authentication of [
      { method: "password", password: "" },
      { method: "password", password: "x".repeat(4097) },
      {
        method: "password",
        password: "secret-canary",
        privateKey: "secret-canary",
      },
      { method: "private_key", privateKey: "" },
      { method: "private_key", privateKey: "secret-canary", passphrase: "" },
      {
        method: "private_key",
        privateKey: "secret-canary",
        password: "secret-canary",
      },
    ]) {
      const response = await request("/api/ssh/credentials", {
        method: "POST",
        headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify({ ...passwordBody, authentication }),
      });
      expect(response.status).toBe(400);
      expect(JSON.stringify(response.body)).not.toContain("secret-canary");
    }
    expect(kms.generateDataKeyCalls).toBe(0);
  });

  it("publishes a delayed low-frequency edit and keeps the current credential usable", async () => {
    useSecretKmsProbe();
    owner();
    const created = await accept(
      credentials().create({
        headers,
        body: { id: randomUUID(), ...passwordBody },
      }),
      [201],
    );
    const params = { credentialId: created.body.id };
    const entered = createDeferredPromise<void>(context.signal);
    const release = createDeferredPromise<void>(context.signal);
    useSecretKmsProbe(async (request) => {
      entered.resolve();
      await release.promise;
      return {
        keyId: request.keyId,
        plaintext: Buffer.from("0123456789abcdef0123456789abcdef"),
        encryptedDataKey: Buffer.from("test-wrapped-key"),
      };
    });
    const delayed = accept(
      credentials().update({
        headers,
        params,
        body: {
          expectedRevision: 1,
          authentication: {
            method: "private_key",
            privateKey: "replacement-canary",
          },
        },
      }),
      [200],
    );
    await entered.promise;
    const renamed = await accept(
      credentials().update({
        headers,
        params,
        body: { expectedRevision: 1, name: "Concurrent winner" },
      }),
      [200],
    );
    release.resolve();
    const saved = await delayed;
    expect(saved.body).toMatchObject({
      id: created.body.id,
      name: renamed.body.name,
      revision: 3,
      authMethod: "private_key",
    });
    expect(
      (await accept(credentials().list({ headers }), [200])).body.credentials,
    ).toStrictEqual([saved.body]);
    const staleDeletion = await accept(
      credentials().delete({ headers, params, body: { expectedRevision: 1 } }),
      [409],
    );
    expect(staleDeletion.body.error.code).toBe(
      "SSH_CREDENTIAL_REVISION_CONFLICT",
    );
    await accept(
      credentials().delete({ headers, params, body: { expectedRevision: 3 } }),
      [204],
    );
  });

  it("leaves a recoverable credential state after deletion overlaps an edit", async () => {
    useSecretKmsProbe();
    owner();
    const created = await accept(
      credentials().create({
        headers,
        body: { id: randomUUID(), ...passwordBody },
      }),
      [201],
    );
    const params = { credentialId: created.body.id };
    const [updated, deleted] = await Promise.all([
      accept(
        credentials().update({
          headers,
          params,
          body: { expectedRevision: 1, name: "Concurrent edit" },
        }),
        [200, 404],
      ),
      accept(
        credentials().delete({
          headers,
          params,
          body: { expectedRevision: 1 },
        }),
        [204, 409],
      ),
    ]);
    const remaining = await accept(credentials().list({ headers }), [200]);
    if (deleted.status === 204) {
      expect(remaining.body.credentials).toStrictEqual([]);
      return;
    }
    expect(updated.status).toBe(200);
    expect(remaining.body.credentials).toStrictEqual([updated.body]);
    await accept(
      credentials().delete({
        headers,
        params,
        body: { expectedRevision: remaining.body.credentials[0]?.revision ?? 0 },
      }),
      [204],
    );
  });

  it("preserves one valid outcome when creating a host races credential deletion", async () => {
    useSecretKmsProbe();
    owner();
    const created = await accept(
      credentials().create({
        headers,
        body: { id: randomUUID(), ...passwordBody },
      }),
      [201],
    );
    const [bound, deleted] = await Promise.all([
      accept(
        connections().create({
          headers,
          body: {
            id: randomUUID(),
            displayName: "Concurrent",
            host: "ssh.example.com",
            credential: { id: created.body.id },
          },
        }),
        [201, 404],
      ),
      accept(
        credentials().delete({
          headers,
          params: { credentialId: created.body.id },
          body: { expectedRevision: 1 },
        }),
        [204, 409],
      ),
    ]);
    expect([bound.status, deleted.status]).toStrictEqual(
      bound.status === 201 ? [201, 409] : [404, 204],
    );
    if (bound.status === 404) {
      expect(bound.body.error.code).toBe("SSH_CREDENTIAL_NOT_FOUND");
    }
    if (deleted.status === 409) {
      expect(deleted.body.error.code).toBe("SSH_CREDENTIAL_IN_USE");
    }
    const hosts = await accept(connections().list({ headers }), [200]);
    expect(hosts.body.connections).toHaveLength(bound.status === 201 ? 1 : 0);
    const remaining = await accept(credentials().list({ headers }), [200]);
    expect(remaining.body.credentials).toHaveLength(
      bound.status === 201 ? 1 : 0,
    );
  });

  it("preserves the host binding when changing credentials races deletion", async () => {
    useSecretKmsProbe();
    owner();
    const original = await accept(
      credentials().create({
        headers,
        body: { id: randomUUID(), ...passwordBody },
      }),
      [201],
    );
    const replacement = await accept(
      credentials().create({
        headers,
        body: { id: randomUUID(), ...passwordBody, name: "Replacement" },
      }),
      [201],
    );
    const host = await accept(
      connections().create({
        headers,
        body: {
          id: randomUUID(),
          displayName: "Existing",
          host: "ssh.example.com",
          credential: { id: original.body.id },
        },
      }),
      [201],
    );
    const [bound, deleted] = await Promise.all([
      accept(
        connections().update({
          headers,
          params: { connectionId: host.body.id },
          body: {
            expectedGeneration: host.body.generation,
            displayName: "Rebound",
            credential: { id: replacement.body.id },
          },
        }),
        [200, 404],
      ),
      accept(
        credentials().delete({
          headers,
          params: { credentialId: replacement.body.id },
          body: { expectedRevision: replacement.body.revision },
        }),
        [204, 409],
      ),
    ]);
    expect([bound.status, deleted.status]).toStrictEqual(
      bound.status === 200 ? [200, 409] : [404, 204],
    );
    if (bound.status === 404) {
      expect(bound.body.error.code).toBe("SSH_CREDENTIAL_NOT_FOUND");
    }
    if (deleted.status === 409) {
      expect(deleted.body.error.code).toBe("SSH_CREDENTIAL_IN_USE");
    }
    const hosts = await accept(connections().list({ headers }), [200]);
    expect(hosts.body.connections).toStrictEqual([
      bound.status === 200 ? bound.body : host.body,
    ]);
    const remaining = await accept(credentials().list({ headers }), [200]);
    const credentialIds = remaining.body.credentials.map(({ id }) => {
      return id;
    });
    expect(credentialIds.sort()).toStrictEqual(
      bound.status === 200
        ? [original.body.id, replacement.body.id].sort()
        : [original.body.id],
    );
  });
});
