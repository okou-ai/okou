import {
  createHash,
  createPublicKey,
  generateKeyPairSync,
  type KeyObject,
  randomUUID,
} from "node:crypto";
import { vncConnectionsContract } from "@okouai/api-contracts/contracts/vnc-connections";
import { VNC_ERROR_CODES } from "@okouai/api-contracts/contracts/vnc-errors";
import { createStore } from "ccstate";
import { describe, expect, it } from "vitest";
import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp, setupRawAppRequest } from "../../../__tests__/test-helpers";
import { vncConnectionsRoutes } from "../vnc-connections";
import { seedOrgMembership$ } from "./helpers/org-membership";
import { createRouteMocks } from "./helpers/route-test";
import { useSecretKmsProbe } from "./helpers/secret-kms-probe";

const context = testContext();
const headers = Object.freeze({ authorization: "Bearer clerk-session" });

function computeFixedWidthWireHash(publicKey: KeyObject): string {
  const jwk = publicKey.export({ format: "jwk" });
  if (jwk.n === undefined || jwk.e === undefined) {
    throw new Error("Expected RSA JWK modulus and exponent");
  }
  const modulus = Buffer.from(jwk.n, "base64url");
  const exponent = Buffer.from(jwk.e, "base64url");
  const width = 2048 / 8;
  const wire = Buffer.alloc(4 + 2 * width);
  wire.writeUInt32BE(2048, 0);
  modulus.copy(wire, 4);
  exponent.copy(wire, wire.length - exponent.length);
  return createHash("sha256").update(wire).digest("hex");
}

const rsa2048 = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicExponent: 65_537,
});

function buildRsa1024Spki(): string {
  const modulus = Buffer.alloc(128, 0x55);
  modulus[0] = 0x80;
  modulus[127] = 0x01;
  return createPublicKey({
    format: "jwk",
    key: {
      kty: "RSA",
      n: modulus.toString("base64url"),
      e: "AQAB",
    },
  })
    .export({ format: "pem", type: "spki" })
    .toString();
}

const KEYS = Object.freeze({
  rsa1024Spki: buildRsa1024Spki(),
  rsa2048Exp3Spki: generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicExponent: 3,
  })
    .publicKey.export({ format: "pem", type: "spki" })
    .toString(),
  ecP256Spki: generateKeyPairSync("ec", { namedCurve: "prime256v1" })
    .publicKey.export({ format: "pem", type: "spki" })
    .toString(),
  rsaPssSpki: generateKeyPairSync("rsa-pss", {
    modulusLength: 2048,
    hashAlgorithm: "sha256",
  })
    .publicKey.export({ format: "pem", type: "spki" })
    .toString(),
  validSpki: rsa2048.publicKey
    .export({ format: "pem", type: "spki" })
    .toString(),
  validPkcs1: rsa2048.publicKey
    .export({ format: "pem", type: "pkcs1" })
    .toString(),
  validPrivatePem: rsa2048.privateKey
    .export({ format: "pem", type: "pkcs8" })
    .toString(),
  validWireHash: computeFixedWidthWireHash(rsa2048.publicKey),
});

async function signInMember(): Promise<void> {
  const userId = `user_${randomUUID()}`;
  const orgId = `org_${randomUUID()}`;
  createRouteMocks(context).clerk.session(userId, orgId, "org:member");
  await createStore().set(
    seedOrgMembership$,
    { orgId, userId, role: "member" },
    context.signal,
  );
}

const vnc = () => {
  return setupApp({ context, routes: vncConnectionsRoutes })(
    vncConnectionsContract,
  );
};

describe("RSA-AES owner and private Runner boundaries", () => {
  it("vnc-rsa-aes-009 rejects unsupported RSA sizes and exponents and non-RSA public keys without parser diagnostics", async () => {
    await signInMember();
    const unsupportedKeys = [
      KEYS.rsa1024Spki,
      KEYS.rsa2048Exp3Spki,
      KEYS.ecP256Spki,
      KEYS.rsaPssSpki,
    ];

    for (const publicKeyPem of unsupportedKeys) {
      const response = await accept(
        vnc().inspectRsaKey({ headers, body: { publicKeyPem } }),
        [400],
      );
      expect(response.body).toStrictEqual({
        error: {
          code: VNC_ERROR_CODES.INVALID_INPUT,
          message: "Invalid VNC configuration",
        },
      });
    }
  });

  it("vnc-rsa-aes-010 converts public PEM to a fixed-width wire hash and rejects private or extra material", async () => {
    await signInMember();
    const kms = useSecretKmsProbe();
    const rawRequest = setupRawAppRequest({
      context,
      routes: vncConnectionsRoutes,
    });

    const spkiResponse = await accept(
      vnc().inspectRsaKey({ headers, body: { publicKeyPem: KEYS.validSpki } }),
      [200],
    );
    const pkcs1Response = await accept(
      vnc().inspectRsaKey({
        headers,
        body: { publicKeyPem: KEYS.validPkcs1 },
      }),
      [200],
    );

    expect(spkiResponse.headers.get("cache-control")).toBe("no-store");
    expect(spkiResponse.body).toStrictEqual({
      serverKeySha256: KEYS.validWireHash,
      modulusBits: 2048,
    });
    expect(pkcs1Response.headers.get("cache-control")).toBe("no-store");
    expect(pkcs1Response.body).toStrictEqual({
      serverKeySha256: KEYS.validWireHash,
      modulusBits: 2048,
    });

    const certificateBlock = [
      "-----BEGIN CERTIFICATE-----",
      "private-canary",
      "-----END CERTIFICATE-----",
    ].join("\n");
    const invalidInputs = [
      KEYS.validPrivatePem,
      `${KEYS.validSpki}\n${KEYS.validSpki}`,
      certificateBlock,
      "A".repeat(16_385),
    ];

    for (const publicKeyPem of invalidInputs) {
      const response = await rawRequest("/api/vnc/rsa-key-pin", {
        method: "POST",
        headers: {
          ...headers,
          "content-type": "application/json",
        },
        body: JSON.stringify({ publicKeyPem }),
      });
      expect(response.status).toBe(400);
      expect(JSON.stringify(response.body)).not.toContain("private-canary");
    }

    expect(kms.decryptCalls).toBe(0);

    context.mocks.clerk.authenticateRequest.mockResolvedValue({
      isAuthenticated: false,
      toAuth: () => {
        return { userId: null, orgId: null };
      },
    });
    const unauthenticated = await rawRequest("/api/vnc/rsa-key-pin", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ publicKeyPem: KEYS.validSpki }),
    });
    expect(unauthenticated.status).toBe(401);
  });
});
