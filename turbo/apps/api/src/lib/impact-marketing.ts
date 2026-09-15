import { createHmac, randomUUID } from "node:crypto";
import { optionalEnv } from "./env";
import { nowDate } from "./time";

export function retireImpactMetadata<T>(
  metadata: Readonly<Record<string, T>>,
): Record<string, T> {
  return Object.fromEntries(
    Object.entries(metadata).filter(([key]) => {
      return !key.startsWith("impact_");
    }),
  );
}
function config() {
  const origin = new URL(
    optionalEnv("MARKETING_ATTRIBUTION_ORIGIN") ?? "https://www.okou.ai",
  );
  const parent = new URL(
    optionalEnv("IMPACT_APP_ORIGIN") ?? "https://app.okou.ai",
  );
  const secret = optionalEnv("MARKETING_ATTRIBUTION_SECRET");
  if (
    origin.protocol !== "https:" ||
    parent.protocol !== "https:" ||
    !secret ||
    secret.length < 32
  ) {
    throw new Error("Marketing attribution is not configured");
  }
  return { origin: origin.origin, parent: parent.origin, secret };
}

export function createImpactHandoff(identity: {
  userId: string;
  orgId: string;
  orgRole: string | undefined;
}) {
  const { origin, parent, secret } = config();
  const issuedAt = Math.floor(nowDate().getTime() / 1000);
  const nonce = randomUUID();
  const payload = Buffer.from(
    JSON.stringify({
      sub: identity.userId,
      org: identity.orgId,
      admin: identity.orgRole === "admin",
      aud: origin,
      parent,
      iat: issuedAt,
      exp: issuedAt + 120,
      nonce,
    }),
  ).toString("base64url");
  const signature = createHmac("sha256", secret)
    .update(payload)
    .digest("base64url");
  return {
    token: `${payload}.${signature}`,
    nonce,
    iframeUrl: `${origin}/finish-onboarding`,
  };
}
