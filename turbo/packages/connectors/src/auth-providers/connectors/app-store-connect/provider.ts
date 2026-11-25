import { createPrivateKey, sign } from "node:crypto";
import type { RefreshTokenAccessProvider } from "../../types";

const TOKEN_LIFETIME_SECONDS = 15 * 60;

function signAccessToken(
  keyId: string,
  encodedKey: string,
  principal: { iss: string } | { sub: "user" },
) {
  // A single-line base64 encoding preserves the PEM across password inputs.
  const pem = Buffer.from(encodedKey, "base64").toString("utf8");
  const key = createPrivateKey(pem);
  if (key.asymmetricKeyDetails?.namedCurve !== "prime256v1") {
    throw new Error("App Store Connect requires a P-256 private key");
  }
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "ES256", kid: keyId, typ: "JWT" };
  const claims = {
    ...principal,
    aud: "appstoreconnect-v1",
    iat: now,
    exp: now + TOKEN_LIFETIME_SECONDS,
  };
  const payload = [header, claims]
    .map((value) => {
      return Buffer.from(JSON.stringify(value)).toString("base64url");
    })
    .join(".");
  const signature = sign("sha256", Buffer.from(payload), {
    key,
    dsaEncoding: "ieee-p1363",
  });
  return {
    outputs: { accessToken: `${payload}.${signature.toString("base64url")}` },
    expiresIn: TOKEN_LIFETIME_SECONDS,
  };
}

export const appStoreConnectTeamKeyProvider = {
  access: {
    kind: "refresh-token",
    refresh: async ({ inputs }, signal) => {
      signal.throwIfAborted();
      return signAccessToken(inputs.keyId, inputs.privateKey, {
        iss: inputs.issuerId,
      });
    },
  } satisfies RefreshTokenAccessProvider<"app-store-connect", "team-key">,
};

export const appStoreConnectIndividualKeyProvider = {
  access: {
    kind: "refresh-token",
    refresh: async ({ inputs }, signal) => {
      signal.throwIfAborted();
      return signAccessToken(inputs.keyId, inputs.privateKey, { sub: "user" });
    },
  } satisfies RefreshTokenAccessProvider<"app-store-connect", "individual-key">,
};
