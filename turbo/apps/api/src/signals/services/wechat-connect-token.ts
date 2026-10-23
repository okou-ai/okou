import { createHmac, timingSafeEqual } from "node:crypto";
import * as z from "zod";
import { INTEGRATION_SETTINGS_PATHS } from "@okouai/core/integration-routes";
import { env } from "../../lib/env";
import { now } from "../../lib/time";
import { safeJsonParse } from "../utils";

const MAX_AGE_MS = 10 * 60_000;
const payloadSchema = z.object({
  connectionId: z.uuid(),
  generation: z.uuid(),
  issuedAt: z.number().int(),
});

function sign(payload: string) {
  return createHmac("sha256", env("SECRETS_ENCRYPTION_KEY"))
    .update(`wechat-reconnect:${payload}`)
    .digest("base64url");
}

export function buildWechatConnectUrl(
  connectionId: string,
  generation: string,
) {
  const payload = Buffer.from(
    JSON.stringify({ connectionId, generation, issuedAt: now() }),
  ).toString("base64url");
  const url = new URL(INTEGRATION_SETTINGS_PATHS.wechat, env("APP_URL"));
  url.searchParams.set("token", `${payload}.${sign(payload)}`);
  return url.toString();
}

export function verifyWechatConnectToken(token: string) {
  const parts = token.split(".");
  if (parts.length !== 2) {
    return null;
  }
  const [payload, signature] = parts;
  if (!payload || !signature) {
    return null;
  }
  const expected = Buffer.from(sign(payload));
  const actual = Buffer.from(signature);
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    return null;
  }
  const result = payloadSchema.safeParse(
    safeJsonParse(Buffer.from(payload, "base64url").toString("utf8")),
  );
  if (
    !result.success ||
    result.data.issuedAt > now() + 60_000 ||
    now() - result.data.issuedAt >= MAX_AGE_MS
  ) {
    return null;
  }
  return result.data;
}
