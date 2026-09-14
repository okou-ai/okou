import type { FeishuPlatform } from "@okouai/core/feishu-platform";
import { createHmac, timingSafeEqual } from "node:crypto";

import { z } from "zod";
import { publicBrandSchema } from "@okouai/api-contracts/contracts/public-brand";
import { PUBLIC_BRAND } from "@okouai/core/public-brand";

import { env } from "../../lib/env";
import { now } from "../../lib/time";
import { safeJsonParse } from "../utils";
import {
  feishuOAuthAppCallbackUrl,
  feishuOAuthConnectUrl,
} from "./feishu-config";

const FEISHU_OAUTH_STATE_MAX_AGE_SECONDS = 10 * 60;

const feishuOAuthStateSchema = z.object({
  installationId: z.string().uuid(),
  orgId: z.string().min(1),
  userId: z.string().min(1),
  callbackTarget: z.literal("app").optional(),
  oauthRedirectTarget: z.literal("app").optional(),
  redirectUri: z.url(),
  publicBrand: publicBrandSchema,
  timestamp: z.number().int(),
});

export type FeishuOAuthState = z.infer<typeof feishuOAuthStateSchema>;

function sign(encodedPayload: string): string {
  return createHmac("sha256", env("SECRETS_ENCRYPTION_KEY"))
    .update(encodedPayload)
    .digest("base64url");
}

function createFeishuOAuthState(args: {
  readonly installationId: string;
  readonly orgId: string;
  readonly userId: string;
  readonly callbackTarget?: "app";
  readonly oauthRedirectTarget?: "app";
  readonly redirectUri: string;
  readonly timestamp?: number;
}): string {
  const encodedPayload = Buffer.from(
    JSON.stringify({
      ...args,
      publicBrand: PUBLIC_BRAND,
      timestamp: args.timestamp ?? Math.floor(now() / 1000),
    }),
  ).toString("base64url");
  return `${encodedPayload}.${sign(encodedPayload)}`;
}

export function verifyFeishuOAuthState(state: string): FeishuOAuthState | null {
  const [encodedPayload, signature, extra] = state.split(".");
  if (!encodedPayload || !signature || extra) {
    return null;
  }
  const expected = Buffer.from(sign(encodedPayload), "utf8");
  const actual = Buffer.from(signature, "utf8");
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    return null;
  }

  const parsed = feishuOAuthStateSchema.safeParse(
    safeJsonParse(Buffer.from(encodedPayload, "base64url").toString()),
  );
  if (!parsed.success) {
    return null;
  }
  const currentTimestamp = Math.floor(now() / 1000);
  if (
    parsed.data.timestamp > currentTimestamp + 60 ||
    currentTimestamp - parsed.data.timestamp >
      FEISHU_OAUTH_STATE_MAX_AGE_SECONDS
  ) {
    return null;
  }
  return parsed.data;
}

export function buildFeishuOAuthConnectUrl(args: {
  readonly platform?: FeishuPlatform;
  readonly installationId: string;
  readonly orgId: string;
  readonly userId: string;
}): string {
  return feishuOAuthConnectUrl(
    createFeishuOAuthState({
      ...args,
      redirectUri: feishuOAuthAppCallbackUrl(args.platform),
    }),
  );
}
