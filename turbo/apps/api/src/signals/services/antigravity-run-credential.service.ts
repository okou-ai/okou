import { command } from "ccstate";
import { number, object, string } from "zod";

import { nowDate } from "../../lib/time";
import { db$ } from "../external/db";
import {
  ANTIGRAVITY_TOKEN_URL,
  antigravityOAuthClient,
} from "./antigravity-oauth-client";
import type { FeatureSwitchContext } from "@okouai/core/feature-switch";
import {
  personalSubscriptionAccountCiphertextsFromRows,
  personalSubscriptionAccountCiphertextsReadPlan,
  personalSubscriptionCredentialValues,
} from "./model-provider-account.service";

const REFRESH_TOKEN_SECRET = "ANTIGRAVITY_REFRESH_TOKEN";

const refreshResponseSchema = object({
  access_token: string().min(1),
  expires_in: number().positive(),
});

/**
 * Exchange the stored refresh token for a fresh access token. Google keeps the
 * refresh token valid across refreshes, so the stored value is not rotated.
 */
async function refreshAccessToken(refreshToken: string, signal: AbortSignal) {
  const client = antigravityOAuthClient();
  if (!client) {
    throw new Error("Google AI sign-in is not configured");
  }
  const response = await fetch(ANTIGRAVITY_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: client.clientId,
      client_secret: client.clientSecret,
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    }),
    signal,
  });
  if (!response.ok) {
    throw new Error(
      `Google AI access token refresh failed with status ${response.status}`,
    );
  }
  const parsed = refreshResponseSchema.safeParse(await response.json());
  if (!parsed.success) {
    throw new Error("Google returned an unrecognized token refresh response");
  }
  return parsed.data;
}

/**
 * The official `agy` CLI validates a local Google login before any request, so
 * a run receives its native stored-token JSON instead of a firewall
 * placeholder. Lancy approved this staff-pilot deviation from the credential
 * trust boundary; firewall-side replacement is the follow-up. The value lives
 * only in process-local admission facts and the dispatched platform
 * environment, where it is a reserved secret alias.
 */
export const mintAntigravityRunCredential$ = command(
  async (
    { get },
    args: {
      readonly orgId: string;
      readonly userId: string;
      readonly accountId: string;
      readonly featureSwitchContext: FeatureSwitchContext;
    },
    signal: AbortSignal,
  ): Promise<string> => {
    const plan = personalSubscriptionAccountCiphertextsReadPlan({
      orgId: args.orgId,
      userId: args.userId,
      type: "antigravity",
      sourceId: args.accountId,
    });
    const rows = await get(db$)
      .select(plan.columns)
      .from(plan.from)
      .leftJoin(plan.join.table, plan.join.on)
      .where(plan.where);
    signal.throwIfAborted();
    const ciphertexts = personalSubscriptionAccountCiphertextsFromRows(rows);
    const secret = ciphertexts?.secrets.filter((row) => {
      return row.name === REFRESH_TOKEN_SECRET;
    });
    if (!secret?.length) {
      throw new Error(
        "The Google AI account is unavailable. Connect it again.",
      );
    }
    const values = await personalSubscriptionCredentialValues(
      secret,
      args.featureSwitchContext,
    );
    signal.throwIfAborted();
    const refreshToken = values.get(REFRESH_TOKEN_SECRET);
    if (!refreshToken) {
      throw new Error(
        "The Google AI account is unavailable. Connect it again.",
      );
    }
    const startedAt = nowDate().getTime();
    const refreshed = await refreshAccessToken(refreshToken, signal);
    signal.throwIfAborted();
    const token = {
      access_token: refreshed.access_token,
      token_type: "Bearer",
      refresh_token: refreshToken,
      expiry: new Date(startedAt + refreshed.expires_in * 1000).toISOString(),
    };
    // agy 1.5.15 file token storage reads `{ token, auth_method }`; without
    // `auth_method` it reports "You are not logged into Antigravity".
    // `consumer` selects its personal Google account sign-in, whose OAuth
    // client issued this refresh token. The guest validates and writes the
    // payload verbatim, and currently requires the top-level token fields.
    return JSON.stringify({
      ...token,
      token,
      auth_method: "consumer",
    });
  },
);
