import { settle } from "../signals/utils";
import { createHmac, randomUUID } from "node:crypto";
import { z } from "zod";
import { optionalEnv } from "./env";
import { nowDate } from "./time";
import { logger } from "./log";

const log = logger("impact-marketing");
export function marketingImpactEnabled(): boolean {
  return optionalEnv("IMPACT_MARKETING_ATTRIBUTION") === "true";
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

const lookupSchema = z.object({
  metadata: z.union([
    z
      .object({
        impact_capture_id: z.string().regex(/^[a-f0-9]{64}$/u),
        impact_click_id: z.string().regex(/^[A-Za-z0-9._~-]{1,128}$/u),
        impact_click_at: z.iso.datetime(),
      })
      .strict(),
    z.object({}).strict(),
  ]),
});

async function fetchMarketingImpact(
  orgId: string,
  signal: AbortSignal,
): Promise<Record<string, string>> {
  const { origin, secret } = config();
  const response = await fetch(`${origin}/api/marketing/impact/lookup`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${secret}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ orgId }),
    redirect: "error",
    signal: AbortSignal.any([signal, AbortSignal.timeout(2000)]),
  });
  signal.throwIfAborted();
  if (!response.ok) {
    throw new Error("Marketing attribution lookup unavailable");
  }
  const result = lookupSchema.safeParse(await response.json());
  signal.throwIfAborted();
  if (!result.success) {
    throw new Error("Invalid Marketing attribution response");
  }
  return result.data.metadata;
}

export async function readMarketingImpact(
  orgId: string,
  signal: AbortSignal,
): Promise<Record<string, string>> {
  const result = await settle(fetchMarketingImpact(orgId, signal), signal);
  if (result.ok) {
    return result.value;
  }
  log.warn(
    "Marketing Impact attribution unavailable; omitting billing attribution",
  );
  return {};
}
