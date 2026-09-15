import { inlineSshKey } from "./helpers/ssh-credential";
import { randomUUID } from "node:crypto";

import { describe, expect, it } from "vitest";

import { sshConnectionsContract } from "@okouai/api-contracts/contracts/ssh-connections";
import { testSshConnectionStateContract } from "@okouai/api-contracts/contracts/test-ssh-connection-state";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp, setupRawAppRequest } from "../../../__tests__/test-helpers";
import { createAuthOrgAgentsBddApi } from "./helpers/api-bdd-auth-org";
import { updateFeatureSwitchesForUser } from "./helpers/feature-switches";
import { createRouteMocks } from "./helpers/route-test";
import { useSecretKmsProbe } from "./helpers/secret-kms-probe";
import { sshConnectionsRoutes } from "../ssh-connections";
import { testSshConnectionStateRoutes } from "../test-ssh-connection-state";

const context = testContext();
const mocks = createRouteMocks(context);
const authApi = createAuthOrgAgentsBddApi(context);

interface Actor {
  readonly orgId: string;
  readonly userId: string;
}

function actor(prefix: string, orgId = `org_ssh_${randomUUID()}`): Actor {
  return { orgId, userId: `user_ssh_${prefix}_${randomUUID()}` };
}

function authenticate(
  value: Actor | { readonly orgId: null; readonly userId: string },
) {
  mocks.clerk.session(value.userId, value.orgId);
}

async function enableSsh(value: Actor): Promise<void> {
  await updateFeatureSwitchesForUser(context, value, {
    [FeatureSwitchKey.SshAccess]: true,
  });
}

function authHeaders() {
  return { authorization: "Bearer clerk-session" };
}

function client() {
  return setupApp({ context, routes: sshConnectionsRoutes })(
    sshConnectionsContract,
  );
}

function stateClient() {
  return setupApp({ context, routes: testSshConnectionStateRoutes })(
    testSshConnectionStateContract,
  );
}

function createBody(
  host: string,
  overrides: Partial<{
    readonly displayName: string;
    readonly port: number;
    readonly username: string;
    readonly privateKey: string;
    readonly passphrase: string | null;
  }> = {},
) {
  return {
    displayName: overrides.displayName ?? `Host ${host}`,
    host,
    port: overrides.port ?? 22,
    credential: inlineSshKey(
      overrides.username ?? "deploy",
      overrides.privateKey ?? "private-key",
      overrides.passphrase ?? null,
    ),
  };
}

describe("SSH connection routes", () => {
  it.each([
    { staff: true, override: undefined, enabled: true },
    { staff: false, override: undefined, enabled: false },
    { staff: true, override: false, enabled: false },
    { staff: false, override: true, enabled: true },
  ])(
    "applies the SSH rollout to host management: staff=$staff, override=$override",
    async ({ staff, override, enabled }) => {
      const owner = actor(
        "rollout",
        staff ? "org_3ANttyrbWYJk6JKRSTRLEsbsDLe" : undefined,
      );
      authenticate(owner);
      if (override !== undefined) {
        await updateFeatureSwitchesForUser(context, owner, {
          [FeatureSwitchKey.SshAccess]: override,
        });
      }

      const result = await accept(
        client().list({ headers: authHeaders() }),
        [200, 404],
      );
      expect(result.status).toBe(enabled ? 200 : 404);
      if (result.status === 404) {
        expect(result.body.error.code).toBe("SSH_UNAVAILABLE");
      } else {
        expect(result.body.connections).toStrictEqual([]);
      }
    },
  );

  it("notifies only the owner after every successful creation, even without visible Agents", async () => {
    useSecretKmsProbe();
    const owner = actor("browser-notice");
    await enableSsh(owner);
    for (const host of [
      "first.example.com",
      "second.example.com",
      "first.example.com",
    ]) {
      context.mocks.ably.publish.mockClear();
      context.mocks.ably.channelGet.mockClear();
      await accept(
        client().create({ headers: authHeaders(), body: createBody(host) }),
        [201],
      );
      expect(context.mocks.ably.publish.mock.calls).toStrictEqual([
        ["ssh:changed", { orgId: owner.orgId }],
      ]);
      expect(context.mocks.ably.channelGet.mock.calls).toStrictEqual([
        [`user:${owner.userId}`],
      ]);
    }
  });
  it("requires an organization session and the feature flag before parsing input", async () => {
    const kms = useSecretKmsProbe();
    const unauthenticated = await accept(client().list({ headers: {} }), [401]);
    expect(unauthenticated.body.error.code).toBe("UNAUTHORIZED");

    authenticate({ userId: `user_ssh_no_org_${randomUUID()}`, orgId: null });
    const withoutOrg = await accept(
      client().list({ headers: authHeaders() }),
      [401],
    );
    expect(withoutOrg.body.error.code).toBe("UNAUTHORIZED");

    const patActor = authApi.user();
    authApi.mockClerkOrg(patActor);
    const pat = await authApi.createCliToken(patActor);
    const patResponse = await accept(
      client().list({
        headers: { authorization: `Bearer ${pat.token}` },
      }),
      [403],
    );
    expect(patResponse.body.error.code).toBe("FORBIDDEN");

    const withoutSwitch = actor("disabled");
    authenticate(withoutSwitch);
    const disabledResponse = await accept(
      client().create({
        headers: authHeaders(),
        body: createBody("disabled.example.com"),
      }),
      [404],
    );
    expect(disabledResponse.body.error.message).toBe(
      "SSH configuration is not available",
    );
    expect(disabledResponse.body.error.code).toBe("SSH_UNAVAILABLE");

    const rawResponse = await setupRawAppRequest({
      context,
      routes: sshConnectionsRoutes,
    })("/api/ssh/connections", {
      method: "POST",
      headers: {
        ...authHeaders(),
        "content-type": "application/json",
      },
      body: JSON.stringify({ unexpected: true }),
    });
    expect(rawResponse.status).toBe(404);
    expect(kms.generateDataKeyCalls).toBe(0);
  });

  it("creates, normalizes, lists, edits, resets, and deletes without exposing secrets", async () => {
    useSecretKmsProbe();
    const owner = actor("crud");
    await enableSsh(owner);
    const privateKey = "  -----BEGIN KEY-----\nvalue\n-----END KEY-----\n";
    const passphrase = " passphrase with spaces ";

    const created = await accept(
      client().create({
        headers: authHeaders(),
        body: {
          displayName: "  Production  ",
          host: "  BÜCHER.Example.  ",
          credential: inlineSshKey("  deploy  ", privateKey, passphrase),
        },
      }),
      [201],
    );
    expect(created.body).toMatchObject({
      displayName: "Production",
      host: "xn--bcher-kva.example",
      port: 22,
      username: "deploy",
      generation: 1,
      learnedHostKey: null,
    });
    expect(created.body).not.toHaveProperty("privateKey");
    expect(created.body).not.toHaveProperty("passphrase");
    expect(created.body).not.toHaveProperty("status");
    expect(created.body).not.toHaveProperty("account");
    expect(JSON.stringify(created.body)).not.toContain("vm0secret:");

    const credentialMatch = await accept(
      stateClient().action({
        body: {
          action: "match-credentials",
          orgId: owner.orgId,
          userId: owner.userId,
          connectionId: created.body.id,
          privateKey,
          passphrase,
        },
      }),
      [200],
    );
    expect(credentialMatch.body).toMatchObject({
      privateKeyMatches: true,
      passphraseMatches: true,
    });

    const summary = await accept(
      client().summary({ headers: authHeaders() }),
      [200],
    );
    expect(summary.body).toStrictEqual({ configuredCount: 1 });
    const listed = await accept(
      client().list({ headers: authHeaders() }),
      [200],
    );
    expect(listed.body.connections).toStrictEqual([created.body]);

    const pinned = await accept(
      stateClient().action({
        body: {
          action: "set-learned-host-key",
          orgId: owner.orgId,
          userId: owner.userId,
          connectionId: created.body.id,
          algorithm: "ssh-ed25519",
          fingerprint: "SHA256:test",
        },
      }),
      [200],
    );
    expect(pinned.body.generation).toBe(2);

    const metadataUpdated = await accept(
      client().update({
        headers: authHeaders(),
        params: { connectionId: created.body.id },
        body: {
          expectedGeneration: 2,
          displayName: "Renamed",
          credential: inlineSshKey("operator", privateKey, passphrase),
        },
      }),
      [200],
    );
    expect(metadataUpdated.body).toMatchObject({
      generation: 3,
      learnedHostKey: {
        algorithm: "ssh-ed25519",
        fingerprint: "SHA256:test",
      },
    });

    const credentialUpdated = await accept(
      client().update({
        headers: authHeaders(),
        params: { connectionId: created.body.id },
        body: {
          expectedGeneration: 3,
          credential: inlineSshKey("operator", "replacement\n"),
        },
      }),
      [200],
    );
    expect(credentialUpdated.body.generation).toBe(4);
    expect(credentialUpdated.body.learnedHostKey).not.toBeNull();

    const replacementMatch = await accept(
      stateClient().action({
        body: {
          action: "match-credentials",
          orgId: owner.orgId,
          userId: owner.userId,
          connectionId: created.body.id,
          privateKey: "replacement\n",
          passphrase: null,
        },
      }),
      [200],
    );
    expect(replacementMatch.body).toMatchObject({
      privateKeyMatches: true,
      passphraseMatches: true,
    });

    const endpointUpdated = await accept(
      client().update({
        headers: authHeaders(),
        params: { connectionId: created.body.id },
        body: {
          expectedGeneration: 4,
          host: "2001:0DB8:0:0::1",
          port: 2222,
        },
      }),
      [200],
    );
    expect(endpointUpdated.body).toMatchObject({
      host: "2001:db8::1",
      port: 2222,
      generation: 5,
      learnedHostKey: null,
    });

    const repinned = await accept(
      stateClient().action({
        body: {
          action: "set-learned-host-key",
          orgId: owner.orgId,
          userId: owner.userId,
          connectionId: created.body.id,
          algorithm: "ssh-ed25519",
          fingerprint: "SHA256:replacement",
        },
      }),
      [200],
    );
    const reset = await accept(
      client().resetHostKey({
        headers: authHeaders(),
        params: { connectionId: created.body.id },
        body: { expectedGeneration: repinned.body.generation ?? 0 },
      }),
      [200],
    );
    expect(reset.body).toMatchObject({ generation: 7, learnedHostKey: null });

    const resetAgain = await accept(
      client().resetHostKey({
        headers: authHeaders(),
        params: { connectionId: created.body.id },
        body: { expectedGeneration: 7 },
      }),
      [200],
    );
    expect(resetAgain.body).toMatchObject({
      generation: 8,
      learnedHostKey: null,
    });

    const stale = await accept(
      client().update({
        headers: authHeaders(),
        params: { connectionId: created.body.id },
        body: { expectedGeneration: 7, displayName: "Stale" },
      }),
      [409],
    );
    expect(stale.body.error.message).toContain("modified");

    const staleReset = await accept(
      client().resetHostKey({
        headers: authHeaders(),
        params: { connectionId: created.body.id },
        body: { expectedGeneration: 7 },
      }),
      [409],
    );
    expect(staleReset.body.error.message).toContain("modified");

    await accept(
      client().delete({
        headers: authHeaders(),
        params: { connectionId: created.body.id },
      }),
      [204],
    );
    const afterDelete = await accept(
      stateClient().action({
        body: {
          action: "match-credentials",
          orgId: owner.orgId,
          userId: owner.userId,
          connectionId: created.body.id,
          privateKey: "replacement\n",
          passphrase: null,
        },
      }),
      [400],
    );
    expect(afterDelete.body.error).toBe("Connection not found");
  });

  it("rejects invalid input before KMS work", async () => {
    const kms = useSecretKmsProbe();
    const owner = actor("validation");
    await enableSsh(owner);

    const invalidHosts = [
      "[::1]",
      "example.com:22",
      "https://example.com",
      "bad host",
      "-bad.example",
      "example..com",
      "127.0.0.999",
      "example.com..",
    ];
    for (const host of invalidHosts) {
      const response = await accept(
        client().create({ headers: authHeaders(), body: createBody(host) }),
        [400],
      );
      expect(response.body.error.code).toBe("SSH_INVALID_HOST");
    }
    expect(kms.generateDataKeyCalls).toBe(0);

    const created = await accept(
      client().create({
        headers: authHeaders(),
        body: createBody("EXAMPLE.com."),
      }),
      [201],
    );
    expect(created.body.host).toBe("example.com");
    expect(kms.generateDataKeyCalls).toBe(1);

    const rawRequest = setupRawAppRequest({
      context,
      routes: sshConnectionsRoutes,
    });
    for (const [path, method, body] of [
      [
        "/api/ssh/connections",
        "POST",
        {
          ...createBody("password.example.com"),
          credential: {
            create: {
              name: "Invalid",
              username: "deploy",
              authentication: {
                method: "private_key",
                privateKey: "test",
                password: "password-canary",
              },
            },
          },
        },
      ],
      [
        `/api/ssh/connections/${created.body.id}`,
        "PATCH",
        {
          expectedGeneration: created.body.generation,
          credential: {
            create: {
              name: "Invalid",
              username: "deploy",
              authentication: {
                method: "private_key",
                privateKey: "test",
                password: "password-canary",
              },
            },
          },
        },
      ],
    ] as const) {
      const response = await rawRequest(path, {
        method,
        headers: { ...authHeaders(), "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      expect(response.status).toBe(400);
      expect(JSON.stringify(response.body)).not.toContain("password-canary");
    }
    expect(kms.generateDataKeyCalls).toBe(1);

    const unknownField = await rawRequest("/api/ssh/connections", {
      method: "POST",
      headers: { ...authHeaders(), "content-type": "application/json" },
      body: JSON.stringify({
        ...createBody("other.example.com"),
        unexpected: true,
      }),
    });
    expect(unknownField.status).toBe(400);

    const invalidPort = await rawRequest("/api/ssh/connections", {
      method: "POST",
      headers: { ...authHeaders(), "content-type": "application/json" },
      body: JSON.stringify({
        ...createBody("invalid-port.example.com"),
        port: 65_536,
      }),
    });
    expect(invalidPort.status).toBe(400);

    const invalidPrivateKey = await rawRequest("/api/ssh/connections", {
      method: "POST",
      headers: { ...authHeaders(), "content-type": "application/json" },
      body: JSON.stringify({
        ...createBody("invalid-key.example.com"),
        credential: inlineSshKey("deploy", ""),
      }),
    });
    expect(invalidPrivateKey.status).toBe(400);

    const invalidPassphrase = await rawRequest("/api/ssh/connections", {
      method: "POST",
      headers: { ...authHeaders(), "content-type": "application/json" },
      body: JSON.stringify({
        ...createBody("invalid-passphrase.example.com"),
        credential: inlineSshKey("deploy", "test", ""),
      }),
    });
    expect(invalidPassphrase.status).toBe(400);

    const emptyPatch = await rawRequest(
      `/api/ssh/connections/${created.body.id}`,
      {
        method: "PATCH",
        headers: { ...authHeaders(), "content-type": "application/json" },
        body: JSON.stringify({ expectedGeneration: 1 }),
      },
    );
    expect(emptyPatch.status).toBe(400);

    const invalidGeneration = await rawRequest(
      `/api/ssh/connections/${created.body.id}`,
      {
        method: "PATCH",
        headers: { ...authHeaders(), "content-type": "application/json" },
        body: JSON.stringify({ expectedGeneration: 0, displayName: "Invalid" }),
      },
    );
    expect(invalidGeneration.status).toBe(400);
    expect(kms.generateDataKeyCalls).toBe(1);
  });

  it("allows independent logins to share a normalized endpoint on create and update", async () => {
    useSecretKmsProbe();
    const owner = actor("shared-endpoint");
    await enableSsh(owner);
    const original = await accept(
      client().create({
        headers: authHeaders(),
        body: createBody("EXAMPLE.com.", { username: "ubuntu" }),
      }),
      [201],
    );
    const additional = await accept(
      client().create({
        headers: authHeaders(),
        body: createBody("example.COM"),
      }),
      [201],
    );
    expect(additional.body.id).not.toBe(original.body.id);
    expect(additional.body).toMatchObject({
      host: "example.com",
      port: 22,
      username: "deploy",
    });
    const other = await accept(
      client().create({
        headers: authHeaders(),
        body: createBody("other.example.com", { port: 2222 }),
      }),
      [201],
    );
    const moved = await accept(
      client().update({
        headers: authHeaders(),
        params: { connectionId: other.body.id },
        body: { expectedGeneration: 1, host: "EXAMPLE.com.", port: 22 },
      }),
      [200],
    );
    expect(moved.body).toMatchObject({
      id: other.body.id,
      host: "example.com",
      port: 22,
      username: "deploy",
      generation: 2,
    });
    const listed = await accept(
      client().list({ headers: authHeaders() }),
      [200],
    );
    expect(listed.body.connections).toHaveLength(3);
    expect(listed.body.connections).toStrictEqual(
      expect.arrayContaining([original.body, additional.body, moved.body]),
    );
  });

  it("fails closed across owners without invoking KMS", async () => {
    const kms = useSecretKmsProbe();
    const owner = actor("owner");
    await enableSsh(owner);
    const created = await accept(
      client().create({
        headers: authHeaders(),
        body: createBody("isolated.example.com"),
      }),
      [201],
    );
    expect(kms.generateDataKeyCalls).toBe(1);

    const other = actor("other", owner.orgId);
    await enableSsh(other);
    const crossOwner = await accept(
      client().update({
        headers: authHeaders(),
        params: { connectionId: created.body.id },
        body: {
          expectedGeneration: 1,
          credential: inlineSshKey("deploy", "should-not-encrypt"),
        },
      }),
      [404],
    );
    expect(crossOwner.body.error.message).toBe("SSH connection not found");
    expect(kms.generateDataKeyCalls).toBe(1);

    const otherList = await accept(
      client().list({ headers: authHeaders() }),
      [200],
    );
    expect(otherList.body.connections).toStrictEqual([]);
  });

  it("preserves concurrent configurations for the same endpoint and username", async () => {
    useSecretKmsProbe();
    const duplicateOwner = actor("concurrent-duplicate");
    await enableSsh(duplicateOwner);
    const [first, second] = await Promise.all([
      accept(
        client().create({
          headers: authHeaders(),
          body: createBody("RACE.example.com", { privateKey: "first-key" }),
        }),
        [201],
      ),
      accept(
        client().create({
          headers: authHeaders(),
          body: createBody("race.example.com.", { privateKey: "second-key" }),
        }),
        [201],
      ),
    ]);
    expect(first.body.id).not.toBe(second.body.id);
    const listed = await accept(
      client().list({ headers: authHeaders() }),
      [200],
    );
    expect(listed.body.connections).toHaveLength(2);
    expect(listed.body.connections).toStrictEqual(
      expect.arrayContaining([first.body, second.body]),
    );
  });

  it("allows concurrent creates beyond 64 configured hosts", async () => {
    useSecretKmsProbe();
    const owner = actor("concurrent-above-64");
    await enableSsh(owner);
    const seeded = await Promise.all(
      Array.from({ length: 63 }, (_, index) => {
        return client().create({
          headers: authHeaders(),
          body: createBody(`seed-${index}.example.com`),
        });
      }),
    );
    expect(
      seeded.every((result) => {
        return result.status === 201;
      }),
    ).toBeTruthy();

    const results = await Promise.all([
      client().create({
        headers: authHeaders(),
        body: createBody("final-a.example.com"),
      }),
      client().create({
        headers: authHeaders(),
        body: createBody("final-b.example.com"),
      }),
    ]);
    expect(
      results
        .map((result) => {
          return result.status;
        })
        .sort(),
    ).toStrictEqual([201, 201]);
    const summary = await accept(
      client().summary({ headers: authHeaders() }),
      [200],
    );
    expect(summary.body).toStrictEqual({ configuredCount: 65 });
    const list = await accept(client().list({ headers: authHeaders() }), [200]);
    expect(list.body.connections).toHaveLength(65);
    expect(
      list.body.connections.map((connection) => {
        return connection.host;
      }),
    ).toStrictEqual(
      expect.arrayContaining(["final-a.example.com", "final-b.example.com"]),
    );
  });

  it("leaves no visible row when KMS encryption fails", async () => {
    const owner = actor("kms-failure");
    await enableSsh(owner);
    const kms = useSecretKmsProbe(() => {
      return Promise.reject(new Error("KMS unavailable"));
    });

    const response = await accept(
      client().create({
        headers: authHeaders(),
        body: createBody("kms-failure.example.com"),
      }),
      [500],
    );
    expect(JSON.stringify(response.body)).not.toContain("KMS unavailable");
    expect(kms.generateDataKeyCalls).toBe(1);

    const summary = await accept(
      client().summary({ headers: authHeaders() }),
      [200],
    );
    expect(summary.body.configuredCount).toBe(0);
  });
});
