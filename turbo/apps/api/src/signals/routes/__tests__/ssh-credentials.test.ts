import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { sshCredentialsContract } from "@okouai/api-contracts/contracts/ssh-credentials";
import { sshConnectionsContract } from "@okouai/api-contracts/contracts/ssh-connections";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp, setupRawAppRequest } from "../../../__tests__/test-helpers";
import { sshConnectionsRoutes } from "../ssh-connections";
import { createRouteMocks } from "./helpers/route-test";
import { updateFeatureSwitchesForUser } from "./helpers/feature-switches";
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
async function owner(
  overrides: Partial<{ orgId: string; userId: string }> = {},
) {
  const value = {
    orgId: `org_ssh_${randomUUID()}`,
    userId: `user_ssh_${randomUUID()}`,
    ...overrides,
  };
  await updateFeatureSwitchesForUser(context, value, {
    [FeatureSwitchKey.SshAccess]: true,
  });
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
  it("requires a session and feature availability before parsing or encrypting secrets", async () => {
    const kms = useSecretKmsProbe();
    await accept(credentials().list({ headers: {} }), [401]);
    mocks.clerk.session(
      `user_disabled_${randomUUID()}`,
      `org_disabled_${randomUUID()}`,
    );
    const request = setupRawAppRequest({
      context,
      routes: sshConnectionsRoutes,
    });
    const disabled = await request("/api/ssh/credentials", {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ authentication: "invalid" }),
    });
    expect(disabled.status).toBe(404);
    expect(kms.generateDataKeyCalls).toBe(0);
  });

  it("shares named metadata, rejects referenced deletion, and preserves credentials after host deletion", async () => {
    useSecretKmsProbe();
    await owner();
    const created = await accept(
      credentials().create({ headers, body: passwordBody }),
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

  it("hides other users and organizations before KMS work or binding", async () => {
    const kms = useSecretKmsProbe();
    const first = await owner();
    const created = await accept(
      credentials().create({ headers, body: passwordBody }),
      [201],
    );
    for (const other of [{ orgId: first.orgId }, { userId: first.userId }]) {
      await owner(other);
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
    await owner();
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

  it("rechecks credential revision after encryption and leaves a concurrent winner intact", async () => {
    useSecretKmsProbe();
    await owner();
    const created = await accept(
      credentials().create({ headers, body: passwordBody }),
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
      [409],
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
    expect((await delayed).body.error.code).toBe(
      "SSH_CREDENTIAL_REVISION_CONFLICT",
    );
    expect(
      (await accept(credentials().list({ headers }), [200])).body.credentials,
    ).toStrictEqual([renamed.body]);
    expect(renamed.body).toMatchObject({ revision: 2, authMethod: "password" });
    await accept(
      credentials().delete({ headers, params, body: { expectedRevision: 1 } }),
      [409],
    );
    await accept(
      credentials().delete({ headers, params, body: { expectedRevision: 2 } }),
      [204],
    );
  });

  it("serializes deletion against a new host reference", async () => {
    useSecretKmsProbe();
    await owner();
    const created = await accept(
      credentials().create({ headers, body: passwordBody }),
      [201],
    );
    const [bound, deleted] = await Promise.all([
      accept(
        connections().create({
          headers,
          body: {
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
    const hosts = await accept(connections().list({ headers }), [200]);
    expect(hosts.body.connections).toHaveLength(bound.status === 201 ? 1 : 0);
  });
});
