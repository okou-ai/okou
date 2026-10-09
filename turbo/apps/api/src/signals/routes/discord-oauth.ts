import { createHash, randomBytes } from "node:crypto";
import { command } from "ccstate";
import { and, eq, gt, isNotNull, lte, sql } from "drizzle-orm";
import { z } from "zod";
import { discordOauthContract } from "@okouai/api-contracts/contracts/discord-oauth";
import { discordOauthStates } from "@okouai/db/schema/discord-oauth-state";
import { discordOrgInstallations } from "@okouai/db/schema/discord-org-installation";
import { discordOrgGrants } from "@okouai/db/schema/discord-org-grant";
import { env } from "../../lib/env";
import { getOAuthApiOrigin } from "../../lib/oauth-origin";
import { now, nowDate } from "../../lib/time";
import { nullableDriverValueDecoder } from "../../lib/db-structured-result";
import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { request$, requestSignal$, setResHeader$ } from "../context/hono";
import { bodyResultOf, queryOf } from "../context/request";
import { writeDb$ } from "../external/db";
import {
  DISCORD_CONNECT_SCOPES,
  DISCORD_INSTALL_SCOPES,
} from "../external/discord-oauth-client";
import { discordSnowflakeSchema } from "../external/discord-client";
import { clerk$, isClerkResourceNotFound } from "../external/clerk";
import { settle } from "../utils";
import {
  discordIntegrationEnabledForOwner$,
  getDiscordAppConfig,
} from "../services/discord-config";
import { DiscordPermission } from "../services/discord-permissions";
import {
  verifyDiscordOauthGrant,
  revalidateDiscordOauthEvidence,
} from "../services/discord-oauth-verification.service";
import {
  persistDiscordOauth$,
  type DiscordOauthAttempt,
} from "../services/discord-oauth-binding.service";
import type { RouteEntry } from "../route-entry";

const CALLBACK = "/api/integrations/discord/oauth/callback";
const TTL_SECONDS = 600;
const PROOF = /^[A-Za-z0-9_-]{43}$/u;
const BOT_PERMISSIONS = (
  DiscordPermission.ViewChannel |
  DiscordPermission.SendMessages |
  DiscordPermission.ReadMessageHistory |
  DiscordPermission.AttachFiles |
  DiscordPermission.CreatePublicThreads |
  DiscordPermission.SendMessagesInThreads
).toString();
type Failure = NonNullable<DiscordOauthAttempt["failureCode"]>;

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
function secret(): string {
  return randomBytes(32).toString("base64url");
}
function apiError<S extends 400 | 403 | 404 | 409 | 503>(
  status: S,
  code: string,
  message: string,
) {
  return { status, body: { error: { code, message } } };
}
function invalidAttempt() {
  return apiError(
    400,
    "DISCORD_OAUTH_INVALID_ATTEMPT",
    "This Discord authorization attempt is invalid or expired. Start again from Works.",
  );
}
function callbackError(error: Failure | "invalid_state"): Response {
  const url = new URL("/works", env("APP_URL"));
  url.searchParams.set("discord", "error");
  url.searchParams.set("discord_error", error);
  return callbackRedirect(url);
}
function callbackRedirect(url: URL): Response {
  return new Response(null, {
    status: 307,
    headers: {
      location: url.toString(),
      "cache-control": "no-store",
      "referrer-policy": "no-referrer",
    },
  });
}
function callbackApproval(state: string, approvalProof: string): Response {
  const url = new URL("/works", env("APP_URL"));
  url.searchParams.set("discord", "pending");
  // Only the consent browser receives this proof. It is not a provider code,
  // completion token, query parameter, cookie or message to the opener.
  url.hash = new URLSearchParams({
    discord_oauth: "approve",
    state,
    approval_proof: approvalProof,
  }).toString();
  return callbackRedirect(url);
}

const ownerAuthorized$ = command(
  async (
    { get, set },
    args: {
      readonly orgId: string;
      readonly userId: string;
      readonly flow: "install" | "connect";
    },
    signal: AbortSignal,
  ): Promise<boolean> => {
    signal.throwIfAborted();
    // This semantic recheck is request-cancellable and deliberately fresh after
    // provider work. Do not construct a computed graph during command execution
    // or reuse an earlier request's memoized membership result.
    const result = await settle(
      get(clerk$).organizations.getOrganizationMembershipList({
        organizationId: args.orgId,
        userId: [args.userId],
        limit: 1,
      }),
    );
    signal.throwIfAborted();
    if (!result.ok) {
      if (isClerkResourceNotFound(result.error)) {
        return false;
      }
      throw result.error;
    }
    const membership = result.value.data.find((member) => {
      return member.publicUserData?.userId === args.userId;
    });
    if (
      !membership ||
      (args.flow === "install" && membership.role !== "org:admin")
    ) {
      return false;
    }
    return await set(
      discordIntegrationEnabledForOwner$,
      args.orgId,
      args.userId,
      signal,
    );
  },
);

const startDiscordOauth$ = command(
  async ({ get, set }, rootSignal: AbortSignal) => {
    const signal = AbortSignal.any([rootSignal, get(requestSignal$)]);
    const auth = get(organizationAuthContext$);
    const body = await get(bodyResultOf(discordOauthContract.start));
    signal.throwIfAborted();
    if (!body.ok) {
      return body.response;
    }
    if (
      !(await set(ownerAuthorized$, { ...auth, flow: body.data.flow }, signal))
    ) {
      return apiError(
        403,
        "FORBIDDEN",
        "Discord requires current workspace membership, an enabled integration, and admin access to install.",
      );
    }
    const config = getDiscordAppConfig();
    if (!config || !env("DISCORD_OAUTH_CLIENT_SECRET")) {
      return apiError(
        503,
        "DISCORD_NOT_CONFIGURED",
        "Discord OAuth is not configured; ask an administrator to configure the application and OAuth client secret.",
      );
    }
    const db = set(writeDb$);
    const [installation] = await db
      .select()
      .from(discordOrgInstallations)
      .where(eq(discordOrgInstallations.orgId, auth.orgId));
    signal.throwIfAborted();
    let guildId = body.data.guildId ?? null;
    if (body.data.flow === "connect" && !installation) {
      return apiError(
        404,
        "NOT_FOUND",
        "Install Discord for this workspace first.",
      );
    }
    if (installation) {
      if (guildId && guildId !== installation.guildId) {
        return apiError(
          409,
          "CONFLICT",
          "Uninstall the current Discord server before choosing another.",
        );
      }
      guildId = installation.guildId;
    }
    const state = secret();
    const completionToken = secret();
    const redirectUri = `${getOAuthApiOrigin(get(request$).raw)}${CALLBACK}`;
    // A data-modifying CTE and the new attempt commit as one SQL statement.
    // Cleanup remains limited to this owner's expired attempts.
    const expiredAttempts = db.$with("expired_discord_oauth_attempts").as(
      db
        .delete(discordOauthStates)
        .where(
          and(
            eq(discordOauthStates.userId, auth.userId),
            eq(discordOauthStates.orgId, auth.orgId),
            lte(discordOauthStates.expiresAt, nowDate()),
            isNotNull(discordOauthStates.completionTokenHash),
          ),
        )
        .returning({ id: discordOauthStates.id }),
    );
    const createdAt = nowDate();
    const expiresAt = new Date(now() + TTL_SECONDS * 1000);
    const started = db.$with("started_discord_oauth_attempt").as(
      db
        .insert(discordOauthStates)
        .values({
          stateHash: hash(state),
          completionTokenHash: hash(completionToken),
          userId: auth.userId,
          orgId: auth.orgId,
          flow: body.data.flow,
          guildId,
          redirectUri,
          createdAt,
          expiresAt,
        })
        .returning({
          id: discordOauthStates.id,
          flow: discordOauthStates.flow,
        }),
    );
    await db
      .with(expiredAttempts, started)
      .insert(discordOrgGrants)
      .select(
        db
          .select({
            id: started.id,
            orgId: sql`${auth.orgId}`
              .mapWith(discordOrgGrants.orgId)
              .as("org_id"),
            initiatedByUserId: sql`${auth.userId}`
              .mapWith(discordOrgGrants.initiatedByUserId)
              .as("initiated_by_user_id"),
            requestedGuildId: sql`${guildId}`
              .mapWith(discordOrgGrants.requestedGuildId)
              .as("requested_guild_id"),
            verifiedGuildId: sql`NULL`
              .mapWith(
                nullableDriverValueDecoder(discordOrgGrants.verifiedGuildId),
              )
              .as("verified_guild_id"),
            verifiedBotUserId: sql`NULL`
              .mapWith(
                nullableDriverValueDecoder(discordOrgGrants.verifiedBotUserId),
              )
              .as("verified_bot_user_id"),
            approvedAt: sql`NULL`
              .mapWith(nullableDriverValueDecoder(discordOrgGrants.approvedAt))
              .as("approved_at"),
            createdAt: sql`${sql.param(createdAt, discordOrgGrants.createdAt)}`
              .mapWith(discordOrgGrants.createdAt)
              .as("created_at"),
            expiresAt: sql`${sql.param(expiresAt, discordOrgGrants.expiresAt)}`
              .mapWith(discordOrgGrants.expiresAt)
              .as("expires_at"),
          })
          .from(started)
          .where(eq(started.flow, "install")),
      );
    signal.throwIfAborted();
    set(setResHeader$, "Cache-Control", "no-store");
    const url = new URL("https://discord.com/oauth2/authorize");
    url.searchParams.set("client_id", config.applicationId);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("redirect_uri", redirectUri);
    url.searchParams.set("state", state);
    url.searchParams.set(
      "scope",
      (body.data.flow === "install"
        ? DISCORD_INSTALL_SCOPES
        : DISCORD_CONNECT_SCOPES
      ).join(" "),
    );
    url.searchParams.set("prompt", "consent");
    if (guildId) {
      url.searchParams.set("guild_id", guildId);
      url.searchParams.set("disable_guild_select", "true");
    }
    if (body.data.flow === "install") {
      url.searchParams.set("integration_type", "0");
      url.searchParams.set("permissions", BOT_PERMISSIONS);
    }
    return {
      status: 200 as const,
      body: { authorizationUrl: url.toString(), completionToken },
    };
  },
);

const failCallback$ = command(
  async (
    { set },
    attempt: DiscordOauthAttempt,
    failure: Failure,
    signal: AbortSignal,
  ) => {
    await set(writeDb$)
      .update(discordOauthStates)
      .set({ phase: "failed", failureCode: failure })
      .where(
        and(
          eq(discordOauthStates.id, attempt.id),
          eq(discordOauthStates.phase, "processing"),
        ),
      );
    signal.throwIfAborted();
    return callbackError(failure);
  },
);

const verifyCallback$ = command(
  async (
    { set },
    attempt: DiscordOauthAttempt,
    query: {
      readonly code?: string;
      readonly error?: string;
      readonly guild_id?: string;
    },
    state: string,
    signal: AbortSignal,
  ) => {
    if (query.error) {
      return await set(failCallback$, attempt, "cancelled", signal);
    }
    if (!query.code || query.code.length > 2048) {
      return await set(failCallback$, attempt, "invalid_authorization", signal);
    }
    const config = getDiscordAppConfig();
    const clientSecret = env("DISCORD_OAUTH_CLIENT_SECRET");
    if (!config || !clientSecret) {
      return await set(failCallback$, attempt, "unavailable", signal);
    }
    const verified = await verifyDiscordOauthGrant(
      {
        config,
        clientSecret,
        flow: attempt.flow,
        guildId: attempt.guildId,
        redirectUri: attempt.redirectUri,
        code: query.code,
        guildHint: query.guild_id,
      },
      signal,
    );
    if (!verified.ok) {
      return await set(failCallback$, attempt, verified.error, signal);
    }
    const approvalProof = secret();
    const db = set(writeDb$);
    const verifiedAttempt = db.$with("verified_discord_oauth_attempt").as(
      db
        .update(discordOauthStates)
        .set({
          phase: "verified",
          approvalTokenHash: hash(approvalProof),
          verifiedGuildId: verified.data.guildId,
          verifiedGuildName: verified.data.guildName,
          verifiedDiscordUserId: verified.data.discordUserId,
          verifiedBotUserId: verified.data.botUserId,
        })
        .where(
          and(
            eq(discordOauthStates.id, attempt.id),
            eq(discordOauthStates.phase, "processing"),
            gt(discordOauthStates.expiresAt, nowDate()),
          ),
        )
        .returning({ id: discordOauthStates.id }),
    );
    const verifiedGrant = db.$with("verified_discord_installation_consent").as(
      db
        .update(discordOrgGrants)
        .set({
          verifiedGuildId: verified.data.guildId,
          verifiedBotUserId: verified.data.botUserId,
        })
        .where(
          eq(
            discordOrgGrants.id,
            db.select({ id: verifiedAttempt.id }).from(verifiedAttempt),
          ),
        )
        .returning({ id: discordOrgGrants.id }),
    );
    const [saved] = await db
      .with(verifiedAttempt, verifiedGrant)
      .select({ id: verifiedAttempt.id })
      .from(verifiedAttempt);
    signal.throwIfAborted();
    return saved
      ? callbackApproval(state, approvalProof)
      : callbackError("invalid_state");
  },
);

const callbackDiscordOauth$ = command(
  async ({ get, set }, rootSignal: AbortSignal) => {
    const signal = AbortSignal.any([rootSignal, get(requestSignal$)]);
    const query = get(queryOf(discordOauthContract.callback));
    if (!query.state || !PROOF.test(query.state)) {
      return callbackError("invalid_state");
    }
    // One-use provider state; it grants only bounded pending evidence, never a
    // connection. Current App identity is independently required for approval.
    const [attempt] = await set(writeDb$)
      .update(discordOauthStates)
      .set({ phase: "processing" })
      .where(
        and(
          eq(discordOauthStates.stateHash, hash(query.state)),
          eq(discordOauthStates.phase, "pending"),
          gt(discordOauthStates.expiresAt, nowDate()),
        ),
      )
      .returning();
    signal.throwIfAborted();
    if (!attempt) {
      return callbackError("invalid_state");
    }
    return await set(verifyCallback$, attempt, query, query.state, signal);
  },
);

const approveDiscordOauth$ = command(
  async ({ get, set }, rootSignal: AbortSignal) => {
    const signal = AbortSignal.any([rootSignal, get(requestSignal$)]);
    const auth = get(organizationAuthContext$);
    const body = await get(bodyResultOf(discordOauthContract.approve));
    signal.throwIfAborted();
    if (!body.ok) {
      return body.response;
    }
    if (!PROOF.test(body.data.state) || !PROOF.test(body.data.approvalProof)) {
      return invalidAttempt();
    }
    const db = set(writeDb$);
    const [attempt] = await db
      .select()
      .from(discordOauthStates)
      .where(
        and(
          eq(discordOauthStates.stateHash, hash(body.data.state)),
          eq(
            discordOauthStates.approvalTokenHash,
            hash(body.data.approvalProof),
          ),
          eq(discordOauthStates.phase, "verified"),
          gt(discordOauthStates.expiresAt, nowDate()),
        ),
      );
    signal.throwIfAborted();
    if (!attempt) {
      return invalidAttempt();
    }
    if (
      attempt.userId !== auth.userId ||
      attempt.orgId !== auth.orgId ||
      !(await set(ownerAuthorized$, attempt, signal))
    ) {
      return apiError(
        403,
        "FORBIDDEN",
        "Sign in as the starting Okou account in its original workspace, or restart Discord authorization.",
      );
    }
    const [approved] = await db
      .update(discordOauthStates)
      .set({ phase: "approved", approvalTokenHash: null })
      .where(
        and(
          eq(discordOauthStates.id, attempt.id),
          eq(discordOauthStates.userId, auth.userId),
          eq(discordOauthStates.orgId, auth.orgId),
          eq(
            discordOauthStates.approvalTokenHash,
            hash(body.data.approvalProof),
          ),
          eq(discordOauthStates.phase, "verified"),
          gt(discordOauthStates.expiresAt, nowDate()),
        ),
      )
      .returning({ id: discordOauthStates.id });
    signal.throwIfAborted();
    if (!approved) {
      return invalidAttempt();
    }
    set(setResHeader$, "Cache-Control", "no-store");
    return { status: 200 as const, body: { approved: true as const } };
  },
);

const evidenceSchema = z.object({
  guildId: discordSnowflakeSchema,
  guildName: z.string(),
  discordUserId: discordSnowflakeSchema,
  botUserId: discordSnowflakeSchema,
});
const completeApproved$ = command(
  async ({ set }, attempt: DiscordOauthAttempt, signal: AbortSignal) => {
    const config = getDiscordAppConfig();
    if (!config) {
      return apiError(
        503,
        "DISCORD_NOT_CONFIGURED",
        "The Discord application is not configured.",
      );
    }
    // The phase check and DB constraints own this persisted shape. Malformed
    // local evidence is an invariant error, not a fabricated provider identity.
    const evidence = evidenceSchema.parse({
      guildId: attempt.verifiedGuildId,
      guildName: attempt.verifiedGuildName,
      discordUserId: attempt.verifiedDiscordUserId,
      botUserId: attempt.verifiedBotUserId,
    });
    const live = await revalidateDiscordOauthEvidence(
      config,
      evidence,
      attempt.flow,
      signal,
    );
    if (!live.ok) {
      return apiError(
        503,
        "DISCORD_OAUTH_UNAVAILABLE",
        "Discord could not verify current bot and sender server presence. Restart authorization.",
      );
    }
    if (!(await set(ownerAuthorized$, attempt, signal))) {
      return apiError(
        403,
        "FORBIDDEN",
        "Current workspace membership and Discord integration access are required.",
      );
    }
    const saved = await set(
      persistDiscordOauth$,
      { attempt, evidence },
      signal,
    );
    if (saved === "invalid") {
      return invalidAttempt();
    }
    if (saved === "conflict") {
      return apiError(
        409,
        "CONFLICT",
        "This Discord server or identity is already bound. Disconnect or uninstall before changing it.",
      );
    }
    return {
      status: 200 as const,
      body: {
        status:
          attempt.flow === "install"
            ? ("installed" as const)
            : ("connected" as const),
      },
    };
  },
);

const completeDiscordOauth$ = command(
  async ({ get, set }, rootSignal: AbortSignal) => {
    const signal = AbortSignal.any([rootSignal, get(requestSignal$)]);
    const auth = get(organizationAuthContext$);
    const body = await get(bodyResultOf(discordOauthContract.complete));
    signal.throwIfAborted();
    if (!body.ok) {
      return body.response;
    }
    if (
      !PROOF.test(body.data.state) ||
      !PROOF.test(body.data.completionToken)
    ) {
      return invalidAttempt();
    }
    const db = set(writeDb$);
    const [attempt] = await db
      .select()
      .from(discordOauthStates)
      .where(
        and(
          eq(discordOauthStates.stateHash, hash(body.data.state)),
          eq(
            discordOauthStates.completionTokenHash,
            hash(body.data.completionToken),
          ),
          gt(discordOauthStates.expiresAt, nowDate()),
        ),
      );
    signal.throwIfAborted();
    if (!attempt) {
      return invalidAttempt();
    }
    if (
      attempt.userId !== auth.userId ||
      attempt.orgId !== auth.orgId ||
      !(await set(ownerAuthorized$, attempt, signal))
    ) {
      return apiError(
        403,
        "FORBIDDEN",
        "Sign in as the starting Okou account in its original workspace, or restart Discord authorization.",
      );
    }
    if (attempt.phase === "failed") {
      await db
        .delete(discordOauthStates)
        .where(
          and(
            eq(discordOauthStates.id, attempt.id),
            eq(discordOauthStates.userId, auth.userId),
            eq(discordOauthStates.orgId, auth.orgId),
            eq(discordOauthStates.phase, "failed"),
          ),
        );
      signal.throwIfAborted();
      return apiError(
        400,
        "DISCORD_OAUTH_FAILED",
        "Discord authorization was cancelled or failed. Start again from Works.",
      );
    }
    if (attempt.phase !== "approved") {
      return apiError(
        409,
        "DISCORD_OAUTH_APPROVAL_REQUIRED",
        "Approve this Discord authorization in the consent browser before completing it.",
      );
    }
    set(setResHeader$, "Cache-Control", "no-store");
    return await set(completeApproved$, attempt, signal);
  },
);

const sessionAuth = Object.freeze({
  requireOrganization: true,
  missingOrganizationStatus: 401,
  accept: Object.freeze(["session"] as const),
});
export const discordOauthRoutes: readonly RouteEntry[] = [
  {
    route: discordOauthContract.start,
    handler: authRoute(sessionAuth, startDiscordOauth$),
  },
  { route: discordOauthContract.callback, handler: callbackDiscordOauth$ },
  {
    route: discordOauthContract.approve,
    handler: authRoute(sessionAuth, approveDiscordOauth$),
  },
  {
    route: discordOauthContract.complete,
    handler: authRoute(sessionAuth, completeDiscordOauth$),
  },
];
