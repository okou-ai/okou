import { generateKeyPairSync, randomUUID, X509Certificate } from "node:crypto";
import { readFileSync } from "node:fs";
import { rootCertificates } from "node:tls";
import { describe, expect, it } from "vitest";
import { vncCredentialsContract } from "@okouai/api-contracts/contracts/vnc-credentials";
import { vncConnectionsContract } from "@okouai/api-contracts/contracts/vnc-connections";
import { sshConnectionsContract } from "@okouai/api-contracts/contracts/ssh-connections";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp, setupRawAppRequest } from "../../../__tests__/test-helpers";
import { mockNow } from "../../../lib/time";
import { vncConnectionsRoutes } from "../vnc-connections";
import { sshConnectionsRoutes } from "../ssh-connections";
import { createRouteMocks } from "./helpers/route-test";
import { inlineSshKey } from "./helpers/ssh-credential";
import { updateFeatureSwitchesForUser } from "./helpers/feature-switches";
import { useSecretKmsProbe } from "./helpers/secret-kms-probe";
import { requireVncCredentialId } from "./helpers/vnc-response";
import { certificateChain, privateKey } from "./helpers/vnc-synthetic-client";

const context = testContext();
const mocks = createRouteMocks(context);
const headers = Object.freeze({ authorization: "Bearer clerk-session" });
const security = Object.freeze({
  type: "x509_vnc" as const,
  trust: Object.freeze({ mode: "system" as const }),
});
const plainSecurity = Object.freeze({
  type: "x509_plain" as const,
  trust: Object.freeze({ mode: "system" as const }),
});
const leafCertificate = readFileSync(
  new URL("./fixtures/vnc-leaf.txt", import.meta.url),
  "utf8",
);
function credentials() {
  return setupApp({ context, routes: vncConnectionsRoutes })(
    vncCredentialsContract,
  );
}
function connections() {
  return setupApp({ context, routes: vncConnectionsRoutes })(
    vncConnectionsContract,
  );
}
function sshConnectionsClient() {
  return setupApp({ context, routes: sshConnectionsRoutes })(
    sshConnectionsContract,
  );
}
async function owner(
  overrides: Partial<{ orgId: string; userId: string }> = {},
) {
  const value = {
    orgId: `org_vnc_${randomUUID()}`,
    userId: `user_vnc_${randomUUID()}`,
    ...overrides,
  };
  await updateFeatureSwitchesForUser(context, value, {
    [FeatureSwitchKey.VncAccess]: true,
  });
  mocks.clerk.session(value.userId, value.orgId);
  context.mocks.clerk.organizations.getOrganizationMembershipList.mockResolvedValue(
    {
      data: [
        {
          id: `member_${value.orgId}_${value.userId}`,
          publicUserData: { userId: value.userId },
          organization: { id: value.orgId },
          role: "org:admin",
        },
      ],
      totalCount: 1,
    },
  );
  return value;
}
function passwordAuthentication(password: string) {
  return { method: "vnc_password" as const, password };
}
function usernamePasswordAuthentication(username: string, password: string) {
  return { method: "username_password" as const, username, password };
}
function hostBody(host = "vnc.example.com") {
  return {
    id: randomUUID(),
    displayName: "Desktop",
    host,
    credential: {
      create: {
        name: "Desktop password",
        authentication: passwordAuthentication(" secret "),
      },
    },
    security,
  };
}
function rawRequest(path: string, body: unknown, method = "POST") {
  const request = setupRawAppRequest({ context, routes: vncConnectionsRoutes });
  return request(path, {
    method,
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("VNC owner configuration", () => {
  it("requires session, feature and current membership before exposing configuration", async () => {
    const kms = useSecretKmsProbe();
    await accept(credentials().list({ headers: {} }), [401]);
    mocks.clerk.session(
      `user_disabled_${randomUUID()}`,
      `org_disabled_${randomUUID()}`,
    );
    expect(
      (
        await rawRequest("/api/vnc/credentials", {
          authentication: passwordAuthentication("canary"),
        })
      ).status,
    ).toBe(404);
    await owner();
    context.mocks.clerk.organizations.getOrganizationMembershipList.mockResolvedValue(
      { data: [], totalCount: 0 },
    );
    await accept(credentials().list({ headers }), [404]);
    await accept(connections().create({ headers, body: hostBody() }), [404]);
    expect(kms.generateDataKeyCalls).toBe(0);
  });

  it("returns secret-free metadata, shared references and an accurate summary", async () => {
    useSecretKmsProbe();
    await owner();
    const credential = await accept(
      credentials().create({
        headers,
        body: {
          id: randomUUID(),
          name: " Shared ",
          authentication: passwordAuthentication(" secret "),
        },
      }),
      [201],
    );
    expect(credential.body).toMatchObject({
      name: "Shared",
      authMethod: "vnc_password",
      revision: 1,
      hosts: [],
    });
    const hosts = [];
    for (const host of ["VNC.EXAMPLE.COM.", "192.0.2.5"]) {
      const created = await accept(
        connections().create({
          headers,
          body: { ...hostBody(host), credential: { id: credential.body.id } },
        }),
        [201],
      );
      hosts.push(created.body);
      expect(created.headers.get("cache-control")).toBe("no-store");
    }
    expect(hosts[0]?.host).toBe("vnc.example.com");
    expect(hosts[0]?.port).toBe(5900);
    expect(hosts[0]?.security).toStrictEqual(security);
    expect(hosts[0]).not.toHaveProperty("transport");
    expect(hosts[0]?.security).not.toHaveProperty("serverName");
    expect(
      (await accept(connections().summary({ headers }), [200])).body,
    ).toStrictEqual({ configuredCount: 2 });
    const listed = await accept(credentials().list({ headers }), [200]);
    expect(listed.headers.get("cache-control")).toBe("no-store");
    expect(listed.body.credentials[0]?.authMethod).toBe("vnc_password");
    expect(listed.body.credentials[0]?.hosts).toStrictEqual(
      expect.arrayContaining(
        hosts.map(({ id, displayName }) => {
          return { id, displayName };
        }),
      ),
    );
    for (const response of [credential.body, hosts, listed.body]) {
      for (const secret of [
        " secret ",
        '"password":',
        "encryptedPassword",
        "vm0secret:",
      ]) {
        expect(JSON.stringify(response)).not.toContain(secret);
      }
    }
    await accept(
      credentials().delete({
        headers,
        params: { credentialId: credential.body.id },
        body: { expectedRevision: 1 },
      }),
      [409],
    );
    for (const host of hosts) {
      await accept(
        connections().delete({
          headers,
          params: { connectionId: host.id },
          body: { expectedGeneration: 1 },
        }),
        [204],
      );
    }
    await accept(
      credentials().delete({
        headers,
        params: { credentialId: credential.body.id },
        body: { expectedRevision: 1 },
      }),
      [204],
    );
    expect(
      (await accept(credentials().list({ headers }), [200])).body.credentials,
    ).toStrictEqual([]);
  });

  it("stores two exact client-certificate pairs without changing certificate-free X509None", async () => {
    const kms = useSecretKmsProbe();
    await owner();
    const certificateOnly = await accept(
      credentials().create({
        headers,
        body: {
          id: randomUUID(),
          name: "QEMU client identity",
          authentication: {
            method: "client_certificate",
            certificateChain,
            privateKey,
          },
        },
      }),
      [201],
    );
    expect(certificateOnly.body).toMatchObject({
      authMethod: "client_certificate",
      revision: 1,
    });
    const created = await accept(
      connections().create({
        headers,
        body: {
          id: randomUUID(),
          displayName: "QEMU X509None mTLS",
          host: "qemu.example.com",
          security: { type: "x509_none", trust: { mode: "system" } },
          credential: { id: certificateOnly.body.id },
        },
      }),
      [201],
    );
    expect(created.body).toMatchObject({
      credentialId: certificateOnly.body.id,
      clientCertificateAuthentication: "client_certificate",
      security: { type: "x509_none" },
      generation: 1,
    });
    expect(created.body).not.toHaveProperty("credential");
    const certificateAndPassword = await accept(
      credentials().create({
        headers,
        body: {
          id: randomUUID(),
          name: "QEMU VNC mTLS",
          authentication: {
            method: "client_certificate_vnc_password",
            certificateChain,
            privateKey,
            password: " secret ",
          },
        },
      }),
      [201],
    );
    const second = await accept(
      connections().create({
        headers,
        body: {
          id: randomUUID(),
          displayName: "QEMU X509Vnc mTLS",
          host: "qemuvnc.example.com",
          security: { type: "x509_vnc", trust: { mode: "system" } },
          credential: { id: certificateAndPassword.body.id },
        },
      }),
      [201],
    );
    expect(second.body).toMatchObject({
      clientCertificateAuthentication: "client_certificate_vnc_password",
      security: { type: "x509_vnc" },
    });
    for (const value of [
      certificateOnly.body,
      certificateAndPassword.body,
      created.body,
      second.body,
      (await accept(credentials().list({ headers }), [200])).body,
      (await accept(connections().list({ headers }), [200])).body,
    ]) {
      const output = JSON.stringify(value);
      for (const secret of [
        privateKey,
        "privateKey",
        "encryptedClientIdentity",
        " secret ",
      ]) {
        expect(output).not.toContain(secret);
      }
    }
    expect(kms.generateDataKeyCalls).toBe(3);
    expect(
      (
        await rawRequest("/api/vnc/connections", {
          id: randomUUID(),
          displayName: "Do not downgrade",
          host: "qemu.example.com",
          security: { type: "x509_none", trust: { mode: "system" } },
          credential: { id: certificateAndPassword.body.id },
        })
      ).status,
    ).toBe(400);
    const rotated = await accept(
      credentials().update({
        headers,
        params: { credentialId: certificateOnly.body.id },
        body: {
          expectedRevision: 1,
          authentication: {
            method: "client_certificate",
            certificateChain,
            privateKey,
          },
        },
      }),
      [200],
    );
    expect(rotated.body.revision).toBe(2);
    expect(
      (await accept(connections().list({ headers }), [200])).body.connections[0]
        ?.generation,
    ).toBe(2);
  });

  it("rejects a malformed or mismatched client identity before KMS", async () => {
    const kms = useSecretKmsProbe();
    await owner();
    const otherKey = generateKeyPairSync("ec", { namedCurve: "prime256v1" })
      .privateKey.export({ format: "pem", type: "pkcs8" })
      .toString();
    for (const method of [
      "client_certificate",
      "client_certificate_vnc_password",
    ] as const) {
      for (const [chain, key] of [
        [certificateChain, "not a key"],
        [certificateChain, otherKey],
        [certificateChain + "\nGARBAGE", privateKey],
        [certificateChain + certificateChain.repeat(8), privateKey],
        [certificateChain, privateKey + "\n" + privateKey],
        [
          certificateChain,
          "-----BEGIN ENCRYPTED PRIVATE KEY-----\nAA==\n-----END ENCRYPTED PRIVATE KEY-----",
        ],
      ] as const) {
        const response = await rawRequest("/api/vnc/credentials", {
          id: randomUUID(),
          name: "Rejected",
          authentication: {
            method,
            certificateChain: chain,
            privateKey: key,
            ...(method === "client_certificate_vnc_password"
              ? { password: "secret" }
              : {}),
          },
        });
        expect(response.status).toBe(400);
        expect(JSON.stringify(response.body)).not.toContain(otherKey);
      }
    }
    mockNow(new Date("2037-01-01T00:00:00Z"));
    const expired = await rawRequest("/api/vnc/credentials", {
      id: randomUUID(),
      name: "Expired",
      authentication: {
        method: "client_certificate",
        certificateChain,
        privateKey,
      },
    });
    expect(expired.status).toBe(400);
    const inline = await rawRequest("/api/vnc/connections", {
      id: randomUUID(),
      displayName: "Rejected inline identity",
      host: "qemu.example.com",
      security: { type: "x509_none", trust: { mode: "system" } },
      credential: {
        create: {
          name: "Rejected identity",
          authentication: {
            method: "client_certificate",
            certificateChain,
            privateKey: "not a key",
          },
        },
      },
    });
    expect(inline.status).toBe(400);
    expect(inline.body).toMatchObject({
      error: { code: "VNC_INVALID_CLIENT_IDENTITY" },
    });
    expect(kms.generateDataKeyCalls).toBe(0);
  });

  it("persists explicitly selected X509None without a credential and requires explicit rebinds", async () => {
    useSecretKmsProbe();
    await owner();
    const none = {
      type: "x509_none" as const,
      trust: { mode: "system" as const },
    };
    const created = await accept(
      connections().create({
        headers,
        body: {
          id: randomUUID(),
          displayName: "No VNC password",
          host: "vnc.example.com",
          security: none,
          credential: { type: "none" },
        },
      }),
      [201],
    );
    expect(created.body).toMatchObject({
      security: none,
      credential: { type: "none" },
      generation: 1,
    });
    expect("credentialId" in created.body).toBeFalsy();
    expect(
      (await accept(connections().list({ headers }), [200])).body.connections,
    ).toStrictEqual([created.body]);
    expect(
      (await accept(credentials().list({ headers }), [200])).body.credentials,
    ).toStrictEqual([]);

    const invalid = await rawRequest("/api/vnc/connections", {
      id: randomUUID(),
      displayName: "Wrong authentication",
      host: "vnc.example.com",
      security: none,
      credential: {
        create: {
          name: "Secret",
          authentication: passwordAuthentication("secret"),
        },
      },
    });
    expect(invalid.status).toBe(400);
    const silentSwitch = await rawRequest(
      `/api/vnc/connections/${created.body.id}`,
      {
        expectedGeneration: 1,
        security,
      },
      "PATCH",
    );
    expect(silentSwitch.status).toBe(400);
    const withPassword = await accept(
      connections().update({
        headers,
        params: { connectionId: created.body.id },
        body: {
          expectedGeneration: 1,
          security,
          credential: {
            create: {
              name: "Explicit password",
              authentication: passwordAuthentication("secret"),
            },
          },
        },
      }),
      [200],
    );
    expect(withPassword.body).toMatchObject({ security, generation: 2 });
    expect(requireVncCredentialId(withPassword.body)).toBeDefined();
    const backToNone = await accept(
      connections().update({
        headers,
        params: { connectionId: created.body.id },
        body: {
          expectedGeneration: 2,
          security: none,
          credential: { type: "none" },
        },
      }),
      [200],
    );
    expect(backToNone.body).toMatchObject({
      security: none,
      credential: { type: "none" },
      generation: 3,
    });
    expect("credentialId" in backToNone.body).toBeFalsy();
    expect(
      (await accept(credentials().list({ headers }), [200])).body.credentials,
    ).toHaveLength(1);
  });

  it("persists typed SSH routes, certificate identity and restrictive deletion", async () => {
    useSecretKmsProbe();
    const routeOwner = await owner();
    const ssh = await accept(
      sshConnectionsClient().create({
        headers,
        body: {
          id: randomUUID(),
          displayName: "VNC gateway",
          host: "gateway.example.com",
          credential: inlineSshKey("deploy", "private-key"),
        },
      }),
      [201],
    );

    for (const host of ["127.0.0.1", "0:0:0:0:0:0:0:1", "::ffff:192.168.1.8"]) {
      const directPrivate = await rawRequest(
        "/api/vnc/connections",
        hostBody(host),
      );
      expect(directPrivate.status).toBe(400);
      expect(directPrivate.body).toMatchObject({
        error: { code: "VNC_INVALID_HOST" },
      });
    }

    const tunneled = await accept(
      connections().create({
        headers,
        body: {
          ...hostBody("127.0.0.1"),
          security: {
            ...security,
            serverName: "DESKTOP.Internal.Example.",
          },
          transport: { type: "ssh", connectionId: ssh.body.id },
        },
      }),
      [201],
    );
    expect(tunneled.body).toMatchObject({
      host: "127.0.0.1",
      generation: 1,
      transport: { type: "ssh", connectionId: ssh.body.id },
      security: { ...security, serverName: "desktop.internal.example" },
    });
    expect(
      (await accept(connections().list({ headers }), [200])).body.connections,
    ).toStrictEqual([tunneled.body]);

    await owner({ orgId: routeOwner.orgId });
    const foreign = await accept(
      connections().create({
        headers,
        body: {
          ...hostBody("10.0.0.8"),
          transport: { type: "ssh", connectionId: ssh.body.id },
        },
      }),
      [404],
    );
    expect(foreign.body.error.code).toBe("VNC_SSH_CONNECTION_NOT_FOUND");
    expect(
      (await accept(credentials().list({ headers }), [200])).body.credentials,
    ).toStrictEqual([]);
    await owner(routeOwner);

    const referenced = await accept(
      sshConnectionsClient().delete({
        headers,
        params: { connectionId: ssh.body.id },
      }),
      [409],
    );
    expect(referenced.body.error.code).toBe("SSH_CONNECTION_IN_USE");

    const renamed = await accept(
      connections().update({
        headers,
        params: { connectionId: tunneled.body.id },
        body: { expectedGeneration: 1, displayName: "Renamed desktop" },
      }),
      [200],
    );
    expect(renamed.body).toMatchObject({
      generation: 2,
      transport: { type: "ssh", connectionId: ssh.body.id },
    });

    const direct = await accept(
      connections().update({
        headers,
        params: { connectionId: tunneled.body.id },
        body: {
          expectedGeneration: 2,
          host: "public.example.com",
          transport: { type: "direct" },
        },
      }),
      [200],
    );
    expect(direct.body).toMatchObject({
      host: "public.example.com",
      generation: 3,
      security: { ...security, serverName: "desktop.internal.example" },
    });
    expect(direct.body).not.toHaveProperty("transport");
    const clearedIdentity = await accept(
      connections().update({
        headers,
        params: { connectionId: tunneled.body.id },
        body: { expectedGeneration: 3, security },
      }),
      [200],
    );
    expect(clearedIdentity.body.generation).toBe(4);
    expect(clearedIdentity.body.security).toStrictEqual(security);
    expect(clearedIdentity.body).not.toHaveProperty("transport");
    await accept(
      sshConnectionsClient().delete({
        headers,
        params: { connectionId: ssh.body.id },
      }),
      [204],
    );
  });

  it("rejects non-ASCII and oversized passwords without truncating or echoing them", async () => {
    const kms = useSecretKmsProbe();
    await owner();
    for (const password of [
      "",
      "123456789",
      "秘密",
      "x\n",
      "x\t",
      "\u007f",
      "é",
    ]) {
      const response = await rawRequest("/api/vnc/credentials", {
        id: randomUUID(),
        name: "Canary",
        authentication: passwordAuthentication(password),
      });
      expect(response.status).toBe(400);
      expect(response.body).toMatchObject({
        error: { code: "VNC_INVALID_INPUT" },
      });
    }
    expect(kms.generateDataKeyCalls).toBe(0);
    await accept(
      credentials().create({
        headers,
        body: {
          id: randomUUID(),
          name: "Spaces",
          authentication: passwordAuthentication("        "),
        },
      }),
      [201],
    );
  });

  it("bounds Apple DH credential fields before encryption and returns no password", async () => {
    const kms = useSecretKmsProbe();
    await owner();
    for (const [username, password] of [
      ["", "secret"],
      ["operator", ""],
      ["é".repeat(32), "secret"],
      ["operator", "é".repeat(32)],
      ["oper\u0000ator", "secret"],
      ["operator", "sec\u0000ret"],
    ]) {
      const result = await rawRequest("/api/vnc/credentials", {
        id: randomUUID(),
        name: "Mac login",
        authentication: {
          method: "apple_dh_username_password",
          username,
          password,
        },
      });
      expect(result.status).toBe(400);
      expect(result.body).toMatchObject({
        error: { code: "VNC_INVALID_INPUT" },
      });
    }
    expect(kms.generateDataKeyCalls).toBe(0);

    const username = `${"é".repeat(31)}x`;
    const password = "p".repeat(63);
    const created = await accept(
      credentials().create({
        headers,
        body: {
          id: randomUUID(),
          name: "Mac login",
          authentication: {
            method: "apple_dh_username_password",
            username,
            password,
          },
        },
      }),
      [201],
    );
    expect(created.body).toMatchObject({
      authMethod: "apple_dh_username_password",
      username,
    });
    expect(JSON.stringify(created.body)).not.toContain(password);
  });

  it("bounds Apple SRP UTF-8 credentials before encryption and returns no password", async () => {
    const kms = useSecretKmsProbe();
    await owner();
    for (const [username, password] of [
      ["", "secret"],
      ["operator", ""],
      ["é".repeat(128), "secret"],
      ["operator", "é".repeat(512)],
      ["oper\u0000ator", "secret"],
      ["operator", "sec\u0000ret"],
    ]) {
      const result = await rawRequest("/api/vnc/credentials", {
        id: randomUUID(),
        name: "Mac SRP login",
        authentication: {
          method: "apple_srp_username_password",
          username,
          password,
        },
      });
      expect(result.status).toBe(400);
      expect(result.body).toMatchObject({
        error: { code: "VNC_INVALID_INPUT" },
      });
    }
    expect(kms.generateDataKeyCalls).toBe(0);

    const username = `${"é".repeat(127)}x`;
    const password = "p".repeat(1023);
    const created = await accept(
      credentials().create({
        headers,
        body: {
          id: randomUUID(),
          name: "Mac SRP login",
          authentication: {
            method: "apple_srp_username_password",
            username,
            password,
          },
        },
      }),
      [201],
    );
    expect(created.body).toMatchObject({
      authMethod: "apple_srp_username_password",
      username,
    });
    expect(JSON.stringify(created.body)).not.toContain(password);
  });

  it("bounds Apple RSA/SRP credentials at 234 UTF-8 bytes before encryption", async () => {
    const kms = useSecretKmsProbe();
    await owner();
    for (const [username, password] of [
      ["", "secret"],
      ["operator", ""],
      ["é".repeat(118), "secret"],
      ["operator", "é".repeat(512)],
      ["oper\u0000ator", "secret"],
      ["operator", "sec\u0000ret"],
    ]) {
      const result = await rawRequest("/api/vnc/credentials", {
        id: randomUUID(),
        name: "Mac RSA/SRP login",
        authentication: {
          method: "apple_rsa_srp_username_password",
          username,
          password,
        },
      });
      expect(result.status).toBe(400);
      expect(result.body).toMatchObject({
        error: { code: "VNC_INVALID_INPUT" },
      });
    }
    expect(kms.generateDataKeyCalls).toBe(0);

    const username = "é".repeat(117);
    const password = "p".repeat(1023);
    const created = await accept(
      credentials().create({
        headers,
        body: {
          id: randomUUID(),
          name: "Mac RSA/SRP login",
          authentication: {
            method: "apple_rsa_srp_username_password",
            username,
            password,
          },
        },
      }),
      [201],
    );
    expect(created.body).toMatchObject({
      authMethod: "apple_rsa_srp_username_password",
      username,
    });
    expect(JSON.stringify(created.body)).not.toContain(password);
  });

  it("rejects unsupported authentication and security profiles without changing saved configuration", async () => {
    useSecretKmsProbe();
    await owner();
    const saved = await accept(
      connections().create({ headers, body: hostBody() }),
      [201],
    );
    const before = (await accept(credentials().list({ headers }), [200])).body;
    for (const authentication of [
      { method: "none" },
      { method: "username_password", username: "canary" },
      { method: "username_password", password: "secret" },
      { method: "vnc_password" },
      { method: "vnc_password", password: "secret", username: "canary" },
    ]) {
      expect(
        (
          await rawRequest("/api/vnc/credentials", {
            id: randomUUID(),
            name: "Unsupported",
            authentication,
          })
        ).status,
      ).toBe(400);
      expect(
        (
          await rawRequest("/api/vnc/connections", {
            ...hostBody(),
            credential: { create: { name: "Unsupported", authentication } },
          })
        ).status,
      ).toBe(400);
      expect(
        (
          await rawRequest(
            `/api/vnc/credentials/${requireVncCredentialId(saved.body)}`,
            {
              expectedRevision: 1,
              authentication,
            },
            "PATCH",
          )
        ).status,
      ).toBe(400);
    }
    for (const unsupportedSecurity of [
      { type: "none" },
      { type: "tls_vnc" },
      { type: "x509_vnc" },
      { type: "x509_plain" },
      { type: "x509_vnc", trust: { mode: "insecure" } },
    ]) {
      expect(
        (
          await rawRequest("/api/vnc/connections", {
            ...hostBody(),
            security: unsupportedSecurity,
          })
        ).status,
      ).toBe(400);
      expect(
        (
          await rawRequest(
            `/api/vnc/connections/${saved.body.id}`,
            {
              expectedGeneration: 1,
              security: unsupportedSecurity,
            },
            "PATCH",
          )
        ).status,
      ).toBe(400);
    }
    expect(
      (await accept(connections().list({ headers }), [200])).body.connections,
    ).toStrictEqual([saved.body]);
    expect(
      (await accept(credentials().list({ headers }), [200])).body,
    ).toStrictEqual(before);
  });

  it("stores only the exact QEMU SCRAM credential and verified-X509 pair without leaking secrets", async () => {
    const kms = useSecretKmsProbe();
    await owner();
    const auth = (username: string, password: string) => {
      return {
        method: "qemu_scram_sha256" as const,
        username,
        password,
      };
    };
    for (const invalid of [
      auth("", "secret"),
      auth("has space", "secret"),
      auth("has,comma", "secret"),
      auth("has=equal", "secret"),
      auth("é", "secret"),
      auth("x".repeat(256), "secret"),
      auth("operator", ""),
      auth("operator", "bad\u0000password"),
      auth("operator", "é"),
      auth("operator", "x".repeat(1024)),
      { ...auth("operator", "secret"), mechanism: "PLAIN" },
    ]) {
      const request = {
        id: randomUUID(),
        name: "QEMU SCRAM",
        authentication: invalid,
      };
      expect((await rawRequest("/api/vnc/credentials", request)).status).toBe(
        400,
      );
      expect(
        (
          await rawRequest("/api/vnc/connections", {
            ...hostBody(),
            security: { type: "qemu_x509_sasl", trust: { mode: "system" } },
            credential: { create: request },
          })
        ).status,
      ).toBe(400);
    }
    expect(kms.generateDataKeyCalls).toBe(0);
    const password = ` ${"s".repeat(1021)} `;
    const credential = await accept(
      credentials().create({
        headers,
        body: {
          id: randomUUID(),
          name: "QEMU SCRAM",
          authentication: auth("operator", password),
        },
      }),
      [201],
    );
    expect(credential.body).toMatchObject({
      authMethod: "qemu_scram_sha256",
      username: "operator",
      revision: 1,
    });
    const scramSecurity = {
      type: "qemu_x509_sasl" as const,
      trust: { mode: "system" as const },
      serverName: "qemu.example.com",
    };
    const base = {
      ...hostBody("qemu.example.com"),
      credential: { id: credential.body.id },
    };
    for (const securityType of ["x509_plain", "x509_vnc", "x509_none"]) {
      const response = await rawRequest("/api/vnc/connections", {
        ...base,
        id: randomUUID(),
        security: { ...scramSecurity, type: securityType },
      });
      expect(response.status).toBe(400);
    }
    expect(
      (
        await rawRequest("/api/vnc/connections", {
          ...base,
          security: { ...scramSecurity, type: "x509_sasl" },
        })
      ).status,
    ).toBe(400);
    const connection = await accept(
      connections().create({
        headers,
        body: { ...base, security: scramSecurity },
      }),
      [201],
    );
    expect(connection.body).toMatchObject({
      credentialId: credential.body.id,
      security: scramSecurity,
      generation: 1,
    });
    for (const response of [
      credential.body,
      connection.body,
      (await accept(credentials().list({ headers }), [200])).body,
      (await accept(connections().list({ headers }), [200])).body,
    ]) {
      expect(JSON.stringify(response)).not.toContain(password);
      expect(JSON.stringify(response)).not.toContain("encryptedPassword");
    }
    const rotated = await accept(
      credentials().update({
        headers,
        params: { credentialId: credential.body.id },
        body: {
          expectedRevision: 1,
          authentication: auth("operator", "new-secret"),
        },
      }),
      [200],
    );
    expect(rotated.body.revision).toBe(2);
    expect(JSON.stringify(rotated.body)).not.toContain("new-secret");
    expect(kms.generateDataKeyCalls).toBe(2);
  });

  it("models username/password credentials and enforces exact profile pairs", async () => {
    const kms = useSecretKmsProbe();
    await owner();
    for (const authentication of [
      usernamePasswordAuthentication("", "secret"),
      usernamePasswordAuthentication("bad\u0000name", "secret"),
      usernamePasswordAuthentication("é".repeat(128), "secret"),
      usernamePasswordAuthentication("canary", ""),
      usernamePasswordAuthentication("canary", "bad\u0000secret"),
      usernamePasswordAuthentication("canary", "é".repeat(512)),
    ]) {
      const result = await rawRequest("/api/vnc/credentials", {
        id: randomUUID(),
        name: "Invalid username password",
        authentication,
      });
      expect(result.status).toBe(400);
      expect(result.body).toMatchObject({
        error: { code: "VNC_INVALID_INPUT" },
      });
    }
    expect(kms.generateDataKeyCalls).toBe(0);

    const username = `${"é".repeat(127)}a`;
    const password = " ".repeat(1023);
    const credential = await accept(
      credentials().create({
        headers,
        body: {
          id: randomUUID(),
          name: "Username password",
          authentication: usernamePasswordAuthentication(username, password),
        },
      }),
      [201],
    );
    expect(credential.body).toMatchObject({
      authMethod: "username_password",
      username,
      revision: 1,
      hosts: [],
    });
    expect(JSON.stringify(credential.body)).not.toContain(password);
    expect(JSON.stringify(credential.body)).not.toContain("encryptedPassword");

    const plain = await accept(
      connections().create({
        headers,
        body: {
          ...hostBody("plain.example.com"),
          credential: { id: credential.body.id },
          security: plainSecurity,
        },
      }),
      [201],
    );
    expect(plain.body.security).toStrictEqual(plainSecurity);

    for (const body of [
      {
        ...hostBody("inline-plain.example.com"),
        credential: {
          create: {
            name: "Mismatched username password",
            authentication: usernamePasswordAuthentication(
              "operator",
              "secret",
            ),
          },
        },
      },
      {
        ...hostBody("selected-plain.example.com"),
        credential: { id: credential.body.id },
      },
      {
        ...hostBody("inline-vnc.example.com"),
        security: plainSecurity,
      },
    ]) {
      const result = await accept(
        connections().create({ headers, body }),
        [400],
      );
      expect(result.body.error.code).toBe("VNC_PROFILE_MISMATCH");
    }

    const rejectedMethod = await accept(
      credentials().update({
        headers,
        params: { credentialId: credential.body.id },
        body: {
          expectedRevision: 1,
          authentication: passwordAuthentication("replace"),
        },
      }),
      [400],
    );
    expect(rejectedMethod.body.error.code).toBe("VNC_PROFILE_MISMATCH");
    const rejectedSecurity = await accept(
      connections().update({
        headers,
        params: { connectionId: plain.body.id },
        body: { expectedGeneration: 1, security },
      }),
      [400],
    );
    expect(rejectedSecurity.body.error.code).toBe("VNC_PROFILE_MISMATCH");

    const legacy = await accept(
      credentials().create({
        headers,
        body: {
          id: randomUUID(),
          name: "Legacy password",
          authentication: passwordAuthentication("legacy"),
        },
      }),
      [201],
    );
    const rebound = await accept(
      connections().update({
        headers,
        params: { connectionId: plain.body.id },
        body: {
          expectedGeneration: 1,
          credential: { id: legacy.body.id },
          security,
        },
      }),
      [200],
    );
    expect(rebound.body).toMatchObject({
      credentialId: legacy.body.id,
      generation: 2,
      security,
    });

    const changedUnreferenced = await accept(
      credentials().update({
        headers,
        params: { credentialId: credential.body.id },
        body: {
          expectedRevision: 1,
          authentication: passwordAuthentication("changed"),
        },
      }),
      [200],
    );
    expect(changedUnreferenced.body).toMatchObject({
      authMethod: "vnc_password",
      revision: 2,
      hosts: [],
    });
    expect("username" in changedUnreferenced.body).toBeFalsy();
  });

  it("validates canonical endpoints and bounded certificate-only trust", async () => {
    const kms = useSecretKmsProbe();
    await owner();
    for (const host of [
      "https://vnc.example.com",
      "user@vnc.example.com",
      "vnc.example.com/path",
      "bad host",
      " vnc.example.com",
      "vnc.example.com ",
      "localhost:5900",
      "-bad.example",
      "a".repeat(254),
    ]) {
      expect(
        (await rawRequest("/api/vnc/connections", hostBody(host))).status,
      ).toBe(400);
    }
    for (const port of [0, 65_536, 1.5]) {
      expect(
        (await rawRequest("/api/vnc/connections", { ...hostBody(), port }))
          .status,
      ).toBe(400);
    }
    for (const serverName of [
      "https://desktop.example.com",
      "desktop.example.com/path",
      "desktop.example.com%eth0",
      "bad server name",
      " desktop.example.com",
      "desktop.example.com ",
    ]) {
      const response = await rawRequest("/api/vnc/connections", {
        ...hostBody(),
        security: { ...security, serverName },
      });
      expect(response.status).toBe(400);
      expect(response.body).toMatchObject({
        error: { code: "VNC_INVALID_SERVER_NAME" },
      });
    }
    const certificate = rootCertificates[0];
    expect(certificate).toBeDefined();
    const appendedDer = Buffer.concat([
      new X509Certificate(certificate!).raw,
      Buffer.from("junk"),
    ]);
    const appendedCertificate = `-----BEGIN CERTIFICATE-----\n${appendedDer.toString("base64")}\n-----END CERTIFICATE-----`;
    for (const invalidTrust of [
      { mode: "insecure" },
      { mode: "custom_ca", caBundle: leafCertificate },
      { mode: "custom_ca", caBundle: appendedCertificate },
      { mode: "custom_ca", caBundle: `${certificate}\ntrailing-junk` },
      { mode: "system", caBundle: certificate },
      {
        mode: "custom_ca",
        caBundle:
          "-----BEGIN PRIVATE KEY-----\ncanary\n-----END PRIVATE KEY-----",
      },
      { mode: "custom_ca", caBundle: "malformed-canary" },
      {
        mode: "custom_ca",
        caBundle: Array.from({ length: 9 }, () => {
          return certificate;
        }).join("\n"),
      },
      { mode: "custom_ca", caBundle: "x".repeat(65_537) },
    ]) {
      expect(
        (
          await rawRequest("/api/vnc/connections", {
            ...hostBody(),
            security: { type: "x509_vnc", trust: invalidTrust },
          })
        ).status,
      ).toBe(400);
    }
    expect(kms.generateDataKeyCalls).toBe(0);
    expect(
      (await accept(credentials().list({ headers }), [200])).body.credentials,
    ).toStrictEqual([]);
    expect(
      (await accept(connections().list({ headers }), [200])).body.connections,
    ).toStrictEqual([]);
    const created = await accept(
      connections().create({
        headers,
        body: {
          ...hostBody("2001:0db8::1"),
          security: {
            type: "x509_vnc",
            trust: { mode: "custom_ca", caBundle: certificate! },
          },
        },
      }),
      [201],
    );
    expect(created.body.host).toBe("2001:db8::1");
    expect(created.body.security.type).toBe("x509_vnc");
    expect(created.body.security).toMatchObject({
      trust: { mode: "custom_ca" },
    });
  });

  it("isolates owners and rejects foreign creation IDs and credentials", async () => {
    useSecretKmsProbe();
    const first = await owner();
    const credential = await accept(
      credentials().create({
        headers,
        body: {
          id: randomUUID(),
          name: "First",
          authentication: passwordAuthentication("first"),
        },
      }),
      [201],
    );
    const host = await accept(
      connections().create({
        headers,
        body: { ...hostBody(), credential: { id: credential.body.id } },
      }),
      [201],
    );
    for (const other of [{ orgId: first.orgId }, { userId: first.userId }]) {
      await owner(other);
      expect(
        (await accept(credentials().list({ headers }), [200])).body.credentials,
      ).toStrictEqual([]);
      expect(
        (await accept(connections().list({ headers }), [200])).body.connections,
      ).toStrictEqual([]);
      await accept(
        credentials().create({
          headers,
          body: {
            id: credential.body.id,
            name: "Foreign",
            authentication: passwordAuthentication("foreign"),
          },
        }),
        [409],
      );
      await accept(
        connections().create({
          headers,
          body: { ...hostBody(), id: host.body.id },
        }),
        [409],
      );
      await accept(
        connections().create({
          headers,
          body: { ...hostBody(), credential: { id: credential.body.id } },
        }),
        [404],
      );
      await accept(
        credentials().update({
          headers,
          params: { credentialId: credential.body.id },
          body: { expectedRevision: 1, name: "Foreign" },
        }),
        [404],
      );
      await accept(
        connections().delete({
          headers,
          params: { connectionId: host.body.id },
          body: { expectedGeneration: 1 },
        }),
        [404],
      );
    }
  });

  it("makes creation retries no-ops even with changed inline secrets and metadata", async () => {
    useSecretKmsProbe();
    await owner();
    const body = hostBody();
    const created = await accept(
      connections().create({ headers, body }),
      [201],
    );
    await accept(
      connections().create({
        headers,
        body: {
          ...body,
          displayName: "Retry",
          host: "retry.example.com",
          credential: {
            create: {
              name: "Retry",
              authentication: passwordAuthentication("changed"),
            },
          },
        },
      }),
      [204],
    );
    expect(
      (await accept(connections().list({ headers }), [200])).body.connections,
    ).toStrictEqual([created.body]);
    const before = (await accept(credentials().list({ headers }), [200])).body
      .credentials;
    expect(before).toHaveLength(1);
    const credential = before[0]!;
    await accept(
      credentials().create({
        headers,
        body: {
          id: credential.id,
          name: "Retry",
          authentication: passwordAuthentication("changed"),
        },
      }),
      [204],
    );
    expect(
      (await accept(credentials().list({ headers }), [200])).body.credentials,
    ).toStrictEqual(before);
  });

  it("keeps configurations for one canonical endpoint independent during updates and deletion", async () => {
    useSecretKmsProbe();
    await owner();
    const first = await accept(
      connections().create({ headers, body: hostBody() }),
      [201],
    );
    const certificate = rootCertificates[0];
    expect(certificate).toBeDefined();
    const second = await accept(
      connections().create({
        headers,
        body: {
          ...hostBody("VNC.EXAMPLE.COM."),
          displayName: "Other login and trust",
          credential: {
            create: {
              name: "Other login",
              authentication: passwordAuthentication("other"),
            },
          },
          security: {
            type: "x509_vnc",
            trust: { mode: "custom_ca", caBundle: certificate! },
          },
        },
      }),
      [201],
    );
    expect(second.body.id).not.toBe(first.body.id);
    expect(requireVncCredentialId(second.body)).not.toBe(
      requireVncCredentialId(first.body),
    );
    expect(second.body.host).toBe(first.body.host);
    expect(second.body.port).toBe(first.body.port);
    expect(second.body.security).toMatchObject({
      trust: { mode: "custom_ca" },
    });
    expect(
      (await accept(connections().summary({ headers }), [200])).body,
    ).toStrictEqual({ configuredCount: 2 });
    const updated = await accept(
      connections().update({
        headers,
        params: { connectionId: second.body.id },
        body: { expectedGeneration: 1, displayName: "Renamed", security },
      }),
      [200],
    );
    expect(updated.body).toMatchObject({
      id: second.body.id,
      credentialId: requireVncCredentialId(second.body),
      generation: 2,
      displayName: "Renamed",
      security,
    });
    expect(
      (await accept(connections().list({ headers }), [200])).body.connections,
    ).toStrictEqual(expect.arrayContaining([first.body, updated.body]));
    await accept(
      connections().delete({
        headers,
        params: { connectionId: first.body.id },
        body: { expectedGeneration: 1 },
      }),
      [204],
    );
    expect(
      (await accept(connections().list({ headers }), [200])).body.connections,
    ).toStrictEqual([updated.body]);
    await accept(
      credentials().delete({
        headers,
        params: { credentialId: requireVncCredentialId(first.body) },
        body: { expectedRevision: 1 },
      }),
      [204],
    );
    expect(
      (await accept(credentials().list({ headers }), [200])).body.credentials,
    ).toMatchObject([
      {
        id: requireVncCredentialId(second.body),
        authMethod: "vnc_password",
        revision: 1,
        hosts: [{ id: second.body.id, displayName: "Renamed" }],
      },
    ]);
  });

  it("allows a new credential creation to reuse a deleted credential ID", async () => {
    useSecretKmsProbe();
    await owner();
    const body = {
      id: randomUUID(),
      name: "Deleted",
      authentication: passwordAuthentication("original"),
    };
    const saved = await accept(credentials().create({ headers, body }), [201]);
    await accept(
      credentials().delete({
        headers,
        params: { credentialId: saved.body.id },
        body: { expectedRevision: saved.body.revision },
      }),
      [204],
    );
    expect(
      (await accept(credentials().list({ headers }), [200])).body.credentials,
    ).toStrictEqual([]);
    const recreated = await accept(
      credentials().create({
        headers,
        body: {
          ...body,
          name: "New credential",
          authentication: passwordAuthentication("new"),
        },
      }),
      [201],
    );
    expect(recreated.body).toMatchObject({
      id: body.id,
      name: "New credential",
      revision: 1,
      hosts: [],
    });
    expect(
      (await accept(credentials().list({ headers }), [200])).body.credentials,
    ).toStrictEqual([recreated.body]);
  });

  it("allows a new host creation to reuse a deleted host ID with a new inline credential", async () => {
    useSecretKmsProbe();
    await owner();
    const body = hostBody();
    const saved = await accept(connections().create({ headers, body }), [201]);
    await accept(
      connections().delete({
        headers,
        params: { connectionId: saved.body.id },
        body: { expectedGeneration: saved.body.generation },
      }),
      [204],
    );
    await accept(
      credentials().delete({
        headers,
        params: { credentialId: requireVncCredentialId(saved.body) },
        body: { expectedRevision: 1 },
      }),
      [204],
    );
    expect(
      (await accept(connections().list({ headers }), [200])).body.connections,
    ).toStrictEqual([]);
    expect(
      (await accept(credentials().list({ headers }), [200])).body.credentials,
    ).toStrictEqual([]);
    const recreated = await accept(
      connections().create({
        headers,
        body: {
          ...body,
          displayName: "New desktop",
          credential: {
            create: {
              name: "New login",
              authentication: passwordAuthentication("new"),
            },
          },
        },
      }),
      [201],
    );
    expect(recreated.body).toMatchObject({
      id: body.id,
      displayName: "New desktop",
      generation: 1,
    });
    expect(requireVncCredentialId(recreated.body)).not.toBe(
      requireVncCredentialId(saved.body),
    );
    expect(
      (await accept(connections().list({ headers }), [200])).body.connections,
    ).toStrictEqual([recreated.body]);
    const logins = await accept(credentials().list({ headers }), [200]);
    expect(logins.body.credentials).toMatchObject([
      {
        id: requireVncCredentialId(recreated.body),
        name: "New login",
        revision: 1,
      },
    ]);
  });

  it("acknowledges completed creation retries during a KMS outage", async () => {
    useSecretKmsProbe();
    await owner();
    const body = hostBody();
    const saved = await accept(connections().create({ headers, body }), [201]);
    const kms = useSecretKmsProbe(() => {
      return Promise.reject(new Error("Synthetic KMS outage"));
    });
    await accept(connections().create({ headers, body }), [204]);
    await accept(
      credentials().create({
        headers,
        body: {
          id: requireVncCredentialId(saved.body),
          name: "Retry",
          authentication: passwordAuthentication("changed"),
        },
      }),
      [204],
    );
    await accept(
      credentials().update({
        headers,
        params: { credentialId: randomUUID() },
        body: {
          expectedRevision: 1,
          authentication: passwordAuthentication("changed"),
        },
      }),
      [404],
    );
    await accept(
      connections().update({
        headers,
        params: { connectionId: randomUUID() },
        body: {
          expectedGeneration: 1,
          credential: {
            create: {
              name: "Missing",
              authentication: passwordAuthentication("changed"),
            },
          },
        },
      }),
      [404],
    );
    expect(kms.generateDataKeyCalls).toBe(0);
    expect(
      (await accept(connections().list({ headers }), [200])).body.connections,
    ).toStrictEqual([saved.body]);
  });

  it("leaves concurrent password rotations recoverable, advances every shared host and rejects stale writes", async () => {
    useSecretKmsProbe();
    await owner();
    const first = await accept(
      connections().create({ headers, body: hostBody() }),
      [201],
    );
    const second = await accept(
      connections().create({
        headers,
        body: {
          ...hostBody("VNC.EXAMPLE.COM."),
          credential: { id: requireVncCredentialId(first.body) },
        },
      }),
      [201],
    );
    const independent = await accept(
      connections().create({ headers, body: hostBody() }),
      [201],
    );
    const params = { credentialId: requireVncCredentialId(first.body) };
    const rotations = await Promise.all(
      ["rotated1", "rotated2"].map((password) => {
        return accept(
          credentials().update({
            headers,
            params,
            body: {
              expectedRevision: 1,
              authentication: passwordAuthentication(password),
            },
          }),
          [200, 409],
        );
      }),
    );
    const statuses = rotations
      .map((result) => {
        return result.status;
      })
      .sort();
    expect([
      [200, 200],
      [200, 409],
    ]).toContainEqual(statuses);
    const applied = statuses.filter((status) => {
      return status === 200;
    }).length;
    const revision = 1 + applied;
    expect(
      (await accept(credentials().list({ headers }), [200])).body.credentials,
    ).toStrictEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: params.credentialId, revision }),
      ]),
    );
    const hosts = (await accept(connections().list({ headers }), [200])).body
      .connections;
    expect(hosts).toHaveLength(3);
    expect(hosts).toStrictEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: first.body.id, generation: revision }),
        expect.objectContaining({ id: second.body.id, generation: revision }),
        independent.body,
      ]),
    );
    await accept(
      credentials().update({
        headers,
        params,
        body: { expectedRevision: 1, name: "Stale" },
      }),
      [409],
    );
    await accept(
      credentials().delete({ headers, params, body: { expectedRevision: 1 } }),
      [409],
    );
    for (const host of [first.body, second.body]) {
      const connectionParams = { connectionId: host.id };
      await accept(
        connections().update({
          headers,
          params: connectionParams,
          body: {
            expectedGeneration: 1,
            credential: {
              create: {
                name: "Stale inline credential",
                authentication: passwordAuthentication("stale"),
              },
            },
          },
        }),
        [409],
      );
      await accept(
        connections().delete({
          headers,
          params: connectionParams,
          body: { expectedGeneration: 1 },
        }),
        [409],
      );
    }
    expect(
      (await accept(credentials().list({ headers }), [200])).body.credentials,
    ).toHaveLength(2);
    const renamed = await accept(
      credentials().update({
        headers,
        params,
        body: { expectedRevision: revision, name: "Recovered" },
      }),
      [200],
    );
    expect(renamed.body).toMatchObject({
      name: "Recovered",
      revision: revision + 1,
    });
    const edited = await accept(
      connections().update({
        headers,
        params: { connectionId: first.body.id },
        body: {
          expectedGeneration: revision,
          host: "new.example.com",
          security,
        },
      }),
      [200],
    );
    expect(edited.body).toMatchObject({
      generation: revision + 1,
      host: "new.example.com",
    });
  });

  it("rejects a concurrent creation by another owner without leaving an inline credential", async () => {
    useSecretKmsProbe();
    const owners = [await owner(), await owner()];
    context.mocks.clerk.authenticateRequest.mockImplementation((request) => {
      if (!(request instanceof Request)) {
        throw new Error("Expected a Clerk authentication request");
      }
      const authorization = request.headers.get("authorization");
      const authenticatedOwner = owners.find((candidate) => {
        return authorization === `Bearer ${candidate.userId}`;
      });
      if (!authenticatedOwner) {
        throw new Error("Expected a VNC creation owner token");
      }
      return Promise.resolve({
        isAuthenticated: true,
        toAuth: () => {
          return { ...authenticatedOwner, orgRole: "org:admin" };
        },
      });
    });
    context.mocks.clerk.organizations.getOrganizationMembershipList.mockResolvedValue(
      {
        data: owners.map((candidate) => {
          return {
            id: `member_${candidate.orgId}_${candidate.userId}`,
            publicUserData: { userId: candidate.userId },
            organization: { id: candidate.orgId },
            role: "org:admin",
          };
        }),
        totalCount: owners.length,
      },
    );

    const body = hostBody();
    const outcomes = await Promise.all(
      owners.map(async (candidate, index) => {
        const ownerHeaders = { authorization: `Bearer ${candidate.userId}` };
        const response = await accept(
          connections().create({
            headers: ownerHeaders,
            body: {
              ...body,
              id: index === 0 ? body.id : body.id.toUpperCase(),
            },
          }),
          [201, 409],
        );
        return { headers: ownerHeaders, response };
      }),
    );
    expect(
      outcomes
        .map(({ response }) => {
          return response.status;
        })
        .sort(),
    ).toStrictEqual([201, 409]);

    for (const outcome of outcomes) {
      const [hosts, logins] = await Promise.all([
        accept(connections().list({ headers: outcome.headers }), [200]),
        accept(credentials().list({ headers: outcome.headers }), [200]),
      ]);
      if (outcome.response.status === 409) {
        expect(outcome.response.body.error.code).toBe(
          "VNC_RESOURCE_ID_CONFLICT",
        );
        expect(hosts.body.connections).toStrictEqual([]);
        expect(logins.body.credentials).toStrictEqual([]);
      } else {
        expect(outcome.response.body.id).toBe(body.id);
        expect(hosts.body.connections).toStrictEqual([outcome.response.body]);
        expect(logins.body.credentials).toStrictEqual([
          expect.objectContaining({
            id: requireVncCredentialId(outcome.response.body),
            name: "Desktop password",
            hosts: [{ id: body.id, displayName: "Desktop" }],
          }),
        ]);
      }
    }
  });

  it("serializes concurrent duplicate creation and binding against credential deletion", async () => {
    useSecretKmsProbe();
    await owner();
    const body = hostBody();
    const results = await Promise.all([
      connections().create({ headers, body }),
      connections().create({ headers, body }),
    ]);
    expect(
      results
        .map(({ status }) => {
          return status;
        })
        .sort(),
    ).toStrictEqual([201, 204]);
    const listed = (await accept(connections().list({ headers }), [200])).body
      .connections;
    expect(listed).toHaveLength(1);
    expect(
      (await accept(credentials().list({ headers }), [200])).body.credentials,
    ).toHaveLength(1);
    const host = listed[0]!;
    await accept(
      connections().delete({
        headers,
        params: { connectionId: host.id },
        body: { expectedGeneration: 1 },
      }),
      [204],
    );
    const [bound, deleted] = await Promise.all([
      accept(
        connections().create({
          headers,
          body: {
            ...hostBody("race.example.com"),
            credential: { id: requireVncCredentialId(host) },
          },
        }),
        [201, 404],
      ),
      accept(
        credentials().delete({
          headers,
          params: { credentialId: requireVncCredentialId(host) },
          body: { expectedRevision: 1 },
        }),
        [204, 409],
      ),
    ]);
    expect([bound.status, deleted.status]).toStrictEqual(
      bound.status === 201 ? [201, 409] : [404, 204],
    );
  });
});
