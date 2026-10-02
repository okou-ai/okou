import { createHash, generateKeyPairSync, randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { vncConnectionsContract } from "@okouai/api-contracts/contracts/vnc-connections";
import { sshConnectionsContract } from "@okouai/api-contracts/contracts/ssh-connections";
import { VNC_RSA_AES_SECURITY_TYPES } from "@okouai/api-contracts/contracts/vnc-rsa-aes";
import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp, setupRawAppRequest } from "../../../__tests__/test-helpers";
import { vncConnectionsRoutes } from "../vnc-connections";
import { sshConnectionsRoutes } from "../ssh-connections";
import { useSecretKmsProbe } from "./helpers/secret-kms-probe";
import { inlineSshKey } from "./helpers/ssh-credential";
import { requireVncCredentialId } from "./helpers/vnc-response";
import {
  createVncRuntimeApi,
  initializeVncRuntimeTest,
  vncSessionHeaders as headers,
} from "./helpers/vnc-runtime";

const context = testContext();
const api = createVncRuntimeApi(context);
beforeEach(initializeVncRuntimeTest);
const pin = "ab".repeat(32);
const password = "界".repeat(85);
const methods = ["rsa_aes_password", "rsa_aes_username_password"] as const;
function authentication(method: (typeof methods)[number], secret = password) {
  return method === "rsa_aes_password"
    ? { method, password: secret }
    : { method, username: "用户名", password: secret };
}
function raw(path: string, body: unknown) {
  return setupRawAppRequest({ context, routes: vncConnectionsRoutes })(path, {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("RSA-AES owner and private Runner boundaries", () => {
  it.each(VNC_RSA_AES_SECURITY_TYPES)(
    "preserves both exact credential subtypes and pin for %s",
    async (type) => {
      const f = await api.fixture();
      api.authenticate(f);
      let generation = 1;
      let transport: { type: "ssh"; connectionId: string } | undefined;
      if (type.includes("ra2ne")) {
        const ssh = await accept(
          setupApp({ context, routes: sshConnectionsRoutes })(
            sshConnectionsContract,
          ).create({
            headers,
            body: {
              id: randomUUID(),
              displayName: "RSA loopback gateway",
              host: "gateway.example.com",
              credential: inlineSshKey("deploy", "private-key"),
            },
          }),
          [201],
        );
        transport = { type: "ssh", connectionId: ssh.body.id };
        await api.enableDefault(f, "ssh", ssh.body.id);
      }
      for (const method of methods) {
        const saved = await accept(
          api.connections().update({
            headers,
            params: { connectionId: f.connectionId },
            body: {
              expectedGeneration: generation,
              host: transport ? "127.0.0.1" : "rsa.example.com",
              ...(transport ? { transport } : {}),
              security: { type, serverKeySha256: pin.toUpperCase() },
              credential: {
                create: {
                  name: "RSA login",
                  authentication: authentication(method),
                },
              },
            },
          }),
          [200],
        );
        generation = saved.body.generation;
        expect(saved.body.security).toStrictEqual({
          type,
          serverKeySha256: pin,
        });
        expect(saved.body).toHaveProperty("rsaAesAuthentication", method);
        expect(JSON.stringify(saved.body)).not.toContain(password);
        const resolved = await api.resolve(f, {
          supportedProfiles: [
            {
              authMethod: method,
              securityType: type,
              transportType: transport ? "ssh" : "direct",
            },
          ],
        });
        expect(resolved).toMatchObject({
          outcome: "resolved_rsa_aes",
          generation,
          security: { type, serverKeySha256: pin },
          authentication: authentication(method),
        });
        expect(resolved).not.toHaveProperty("serverName");
      }
    },
  );

  it("denies wrong capabilities before KMS and invalidates pin/password generations and revoked authority", async () => {
    const f = await api.fixture();
    api.authenticate(f);
    const saved = await accept(
      api.connections().update({
        headers,
        params: { connectionId: f.connectionId },
        body: {
          expectedGeneration: 1,
          security: { type: "rsa_aes_ra2", serverKeySha256: pin },
          credential: {
            create: {
              name: "RSA login",
              authentication: authentication("rsa_aes_password"),
            },
          },
        },
      }),
      [200],
    );
    const kms = useSecretKmsProbe();
    const initial = kms.decryptCalls;
    await expect(
      api.resolve(f, { supportedProfiles: [] }),
    ).resolves.toStrictEqual({ outcome: "unsupported_profile" });
    await expect(
      api.resolve(f, {
        supportedProfiles: [
          {
            authMethod: "rsa_aes_password",
            securityType: "rsa_aes_ra2_256",
            transportType: "direct",
          },
        ],
      }),
    ).resolves.toStrictEqual({ outcome: "unsupported_profile" });
    expect(kms.decryptCalls).toBe(initial);
    await accept(
      api.connections().update({
        headers,
        params: { connectionId: f.connectionId },
        body: {
          expectedGeneration: 2,
          security: { type: "rsa_aes_ra2", serverKeySha256: "cd".repeat(32) },
        },
      }),
      [200],
    );
    await accept(
      api.connections().update({
        headers,
        params: { connectionId: f.connectionId },
        body: {
          expectedGeneration: 2,
          security: { type: "rsa_aes_ra2", serverKeySha256: pin },
        },
      }),
      [409],
    );
    await accept(
      api.credentials().update({
        headers,
        params: { credentialId: requireVncCredentialId(saved.body) },
        body: {
          expectedRevision: 1,
          authentication: authentication("rsa_aes_password", "rotated"),
        },
      }),
      [200],
    );
    const profile = [
      {
        authMethod: "rsa_aes_password" as const,
        securityType: "rsa_aes_ra2" as const,
        transportType: "direct" as const,
      },
    ];
    await expect(
      api.resolve(f, { supportedProfiles: profile }),
    ).resolves.toMatchObject({
      outcome: "resolved_rsa_aes",
      generation: 4,
      security: { serverKeySha256: "cd".repeat(32) },
      authentication: { password: "rotated" },
    });
    await api.setDefault(f, "vnc", f.connectionId, false);
    const after = kms.decryptCalls;
    await expect(
      api.resolve(f, { supportedProfiles: profile }),
    ).resolves.toStrictEqual({ outcome: "unavailable" });
    expect(kms.decryptCalls).toBe(after);
  });

  it("rejects bytes, NUL, malformed Unicode, CA alias and direct-ne without encrypting", async () => {
    const f = await api.fixture();
    api.authenticate(f);
    const kms = useSecretKmsProbe();
    const before = kms.generateDataKeyCalls;
    for (const secret of ["", "é".repeat(128), "x\u0000y", "\uD800"]) {
      expect(
        (
          await raw("/api/vnc/credentials", {
            id: randomUUID(),
            name: "Rejected",
            authentication: authentication("rsa_aes_password", secret),
          })
        ).status,
      ).toBe(400);
    }
    for (const security of [
      { type: "rsa_aes_ra2ne", serverKeySha256: pin },
      { type: "rsa_aes_ra2", serverKeySha256: "ab".repeat(20) },
      { type: "rsa_aes_ra2", serverKeySha256: pin, trust: { mode: "system" } },
    ]) {
      expect(
        (
          await raw("/api/vnc/connections", {
            id: randomUUID(),
            displayName: "Rejected",
            host: "rsa.example.com",
            security,
            credential: {
              create: {
                name: "Rejected",
                authentication: authentication("rsa_aes_password"),
              },
            },
          })
        ).status,
      ).toBe(400);
    }
    expect(kms.generateDataKeyCalls).toBe(before);
  });

  it("converts public PEM to a fixed-width wire hash, not a PEM/SPKI hash, and rejects private or extra material", async () => {
    const f = await api.fixture();
    api.authenticate(f);
    const pair = generateKeyPairSync("rsa", {
      modulusLength: 2048,
      publicExponent: 65537,
    });
    const publicKeyPem = pair.publicKey
      .export({ type: "spki", format: "pem" })
      .toString();
    const publicPkcs1 = pair.publicKey
      .export({ type: "pkcs1", format: "pem" })
      .toString();
    const jwk = pair.publicKey.export({ format: "jwk" });
    if (!jwk.n) {
      throw new Error("Missing synthetic public modulus");
    }
    const bits = Buffer.from([0, 0, 8, 0]);
    const exponent = Buffer.alloc(256);
    exponent.set([1, 0, 1], 253);
    const expected = createHash("sha256")
      .update(Buffer.concat([bits, Buffer.from(jwk.n, "base64url"), exponent]))
      .digest("hex");
    const kms = useSecretKmsProbe();
    const before = kms.decryptCalls;
    for (const pem of [publicKeyPem, publicPkcs1]) {
      const inspected = await accept(
        api
          .connections()
          .inspectRsaKey({ headers, body: { publicKeyPem: pem } }),
        [200],
      );
      expect(inspected.body).toStrictEqual({
        serverKeySha256: expected,
        modulusBits: 2048,
      });
      expect(inspected.headers.get("cache-control")).toBe("no-store");
    }
    expect(expected).not.toBe(
      createHash("sha256")
        .update(pair.publicKey.export({ type: "spki", format: "der" }))
        .digest("hex"),
    );
    for (const invalid of [
      pair.privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
      publicKeyPem + publicKeyPem,
      "-----BEGIN CERTIFICATE-----\nprivate-canary\n-----END CERTIFICATE-----",
      "x".repeat(16_385),
    ]) {
      const response = await raw("/api/vnc/rsa-key-pin", {
        publicKeyPem: invalid,
      });
      expect(response.status).toBe(400);
      expect(JSON.stringify(response.body)).not.toContain("private-canary");
    }
    expect(kms.decryptCalls).toBe(before);
    await accept(
      api.connections().inspectRsaKey({ headers: {}, body: { publicKeyPem } }),
      [401],
    );
  });
});
