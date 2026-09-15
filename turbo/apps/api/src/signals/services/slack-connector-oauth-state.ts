import { createHmac, timingSafeEqual } from "node:crypto";

import { z } from "zod";

import { env } from "../../lib/env";
import { now } from "../../lib/time";
import { safeJsonParse } from "../utils";

const START_MAX_AGE_SECONDS = 15 * 60;
export const SLACK_CONNECTOR_OAUTH_STATE_PREFIX = "slack-connector.";

export const slackConnectorOAuthContextSchema = z.object({
  flow: z.enum(["install", "connect"]),
  orgId: z.string().min(1),
  userId: z.string().min(1),
  workspaceId: z.string().min(1).optional(),
  slackUserId: z.string().min(1).optional(),
  channelId: z.string().optional(),
  threadTs: z.string().optional(),
  prompt: z.string().max(500).optional(),
  reinstall: z.boolean().optional(),
});

export type SlackConnectorOAuthContext = z.infer<
  typeof slackConnectorOAuthContextSchema
>;

const startSchema = slackConnectorOAuthContextSchema.extend({
  issuedAt: z.number().int(),
});

function sign(payload: string): string {
  return createHmac("sha256", env("SECRETS_ENCRYPTION_KEY"))
    .update(`slack-connector-start-v1:${payload}`)
    .digest("base64url");
}

/** Only authenticated integration endpoints may mint a connector start link. */
export function buildSlackConnectorOAuthStartUrl(
  apiOrigin: string,
  context: SlackConnectorOAuthContext,
): string {
  const payload = Buffer.from(
    JSON.stringify({ ...context, issuedAt: Math.floor(now() / 1000) }),
  ).toString("base64url");
  const url = new URL(`/api/slack/oauth/${context.flow}`, apiOrigin);
  url.searchParams.set("connectorState", `${payload}.${sign(payload)}`);
  return url.toString();
}

export function verifySlackConnectorOAuthStart(
  state: string,
): SlackConnectorOAuthContext | null {
  const [payload, signature, extra] = state.split(".");
  if (!payload || !signature || extra) {
    return null;
  }
  const expected = Buffer.from(sign(payload));
  const actual = Buffer.from(signature);
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
    return null;
  }
  const parsed = startSchema.safeParse(
    safeJsonParse(Buffer.from(payload, "base64url").toString()),
  );
  if (!parsed.success) {
    return null;
  }
  const timestamp = Math.floor(now() / 1000);
  if (
    parsed.data.issuedAt > timestamp + 60 ||
    timestamp - parsed.data.issuedAt > START_MAX_AGE_SECONDS
  ) {
    return null;
  }
  return parsed.data;
}
