import { generateKeyPairSync, verify } from "node:crypto";
import { expect, it } from "vitest";
import {
  appStoreConnectIndividualKeyProvider,
  appStoreConnectTeamKeyProvider,
} from "../app-store-connect/provider";

it.each(["individual", "team"] as const)(
  "issues a verifiable short-lived ES256 bearer for an Apple %s key",
  async (kind) => {
    const pair = generateKeyPairSync("ec", { namedCurve: "P-256" });
    const inputs = {
      keyId: "TESTKEY",
      privateKey: Buffer.from(
        pair.privateKey.export({ type: "pkcs8", format: "pem" }),
      ).toString("base64"),
    };
    const signal = new AbortController().signal;
    const before = Math.floor(Date.now() / 1000);
    const result =
      kind === "team"
        ? await appStoreConnectTeamKeyProvider.access.refresh(
            { inputs: { ...inputs, issuerId: "team-issuer" } },
            signal,
          )
        : await appStoreConnectIndividualKeyProvider.access.refresh(
            { inputs },
            signal,
          );
    const [header, claims, signature] = result.outputs.accessToken.split(".");
    if (!header || !claims || !signature)
      throw new Error("Missing JWT segment");
    expect(
      verify(
        "sha256",
        Buffer.from(`${header}.${claims}`),
        {
          key: pair.publicKey,
          dsaEncoding: "ieee-p1363",
        },
        Buffer.from(signature, "base64url"),
      ),
    ).toBe(true);
    expect(JSON.parse(Buffer.from(header, "base64url").toString())).toEqual({
      alg: "ES256",
      kid: "TESTKEY",
      typ: "JWT",
    });
    const payload = JSON.parse(Buffer.from(claims, "base64url").toString());
    expect(payload).toEqual({
      ...(kind === "team" ? { iss: "team-issuer" } : { sub: "user" }),
      aud: "appstoreconnect-v1",
      iat: expect.any(Number),
      exp: payload.iat + result.expiresIn,
    });
    expect(payload.iat).toBeGreaterThanOrEqual(before);
    expect(payload.iat).toBeLessThanOrEqual(Math.floor(Date.now() / 1000));
    expect(result.expiresIn).toBeGreaterThan(0);
    expect(result.expiresIn).toBeLessThanOrEqual(20 * 60);
  },
);
