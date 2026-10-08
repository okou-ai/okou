import { createHash, randomBytes } from "node:crypto";
import { command } from "ccstate";
import { and, eq, gt } from "drizzle-orm";
import { parse, serialize } from "hono/utils/cookie";
import { discordOauthContract } from "@okouai/api-contracts/contracts/discord-oauth";
import { discordOauthStates } from "@okouai/db/schema/discord-oauth-state";
import { discordUserIdentities } from "@okouai/db/schema/discord-user-identity";
import { discordOrgConnections } from "@okouai/db/schema/discord-org-connection";
import { discordOrgInstallations } from "@okouai/db/schema/discord-org-installation";
import { env, optionalEnv } from "../../lib/env";
import { getOAuthApiOrigin } from "../../lib/oauth-origin";
import { now, nowDate } from "../../lib/time";
import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { request$, setResHeader$ } from "../context/hono";
import { bodyResultOf, queryOf } from "../context/request";
import { writeDb$ } from "../external/db";
import {
  DISCORD_CONNECT_SCOPES,
  DISCORD_INSTALL_SCOPES,
} from "../external/discord-oauth-client";
import { discordMemberRole } from "../services/discord-data.service";
import {
  discordIntegrationEnabledForOwner$,
  getDiscordAppConfig,
} from "../services/discord-config";
import {
  discordOrgChangedUserIds,
  publishDiscordChanged,
} from "../services/discord-realtime.service";
import { verifyDiscordOauthGrant } from "../services/discord-oauth-verification.service";
import { notifyDiscordConnection$ } from "../services/discord-oauth-welcome.service";
import type { RouteEntry } from "../route-entry";
import { settle } from "../utils";

const CALLBACK = "/api/integrations/discord/oauth/callback";
const COOKIE = "okou-discord-oauth";
const COOKIE_PATH = "/api/integrations/discord/oauth";
const TTL_SECONDS = 600;
// View/send/history/thread/file permissions only. Never ADMINISTRATOR.
const BOT_PERMISSIONS = "397284477952";
type Attempt = typeof discordOauthStates.$inferSelect;
type CallbackError =
  | "invalid_state"
  | "cancelled"
  | "unavailable"
  | "forbidden"
  | "provider_error"
  | "invalid_authorization"
  | "guild_unverified"
  | "bot_missing"
  | "conflict";

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
function apiError<S extends 400 | 403 | 404 | 409 | 503>(
  status: S,
  code: string,
  message: string,
) {
  return { status, body: { error: { code, message } } };
}
function redirect(
  status: "installed" | "connected" | "error",
  error?: CallbackError,
): Response {
  const url = new URL("/works", env("APP_URL"));
  url.searchParams.set("discord", status);
  if (error) {
    url.searchParams.set("discord_error", error);
  }
  return new Response(null, {
    status: 307,
    headers: {
      location: url.toString(),
      "cache-control": "no-store",
      "referrer-policy": "no-referrer",
    },
  });
}

const startDiscordOauth$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const auth = get(organizationAuthContext$);
    const body = await get(bodyResultOf(discordOauthContract.start));
    signal.throwIfAborted();
    if (!body.ok) {
      return body.response;
    }
    if (
      !(await set(
        discordIntegrationEnabledForOwner$,
        auth.orgId,
        auth.userId,
        signal,
      ))
    ) {
      return apiError(403, "FORBIDDEN", "Discord integration is not enabled");
    }
    const role = await get(discordMemberRole(auth));
    signal.throwIfAborted();
    if (!role || (body.data.flow === "install" && role !== "admin")) {
      return apiError(
        403,
        "FORBIDDEN",
        "Current workspace admin membership is required to install Discord",
      );
    }
    const config = getDiscordAppConfig();
    if (!config || !optionalEnv("DISCORD_OAUTH_CLIENT_SECRET")) {
      return apiError(
        503,
        "DISCORD_NOT_CONFIGURED",
        "Discord OAuth is not configured; ask an administrator to configure the application and OAuth client secret",
      );
    }
    const db = set(writeDb$);
    const [installation] = await db
      .select()
      .from(discordOrgInstallations)
      .where(eq(discordOrgInstallations.orgId, auth.orgId));
    signal.throwIfAborted();
    let guildId = body.data.guildId ?? null;
    if (body.data.flow === "connect") {
      if (!installation) {
        return apiError(
          404,
          "NOT_FOUND",
          "Install Discord for this workspace first",
        );
      }
      if (guildId && guildId !== installation.guildId) {
        return apiError(
          409,
          "CONFLICT",
          "This workspace is installed in a different Discord server",
        );
      }
      guildId = installation.guildId;
    } else if (installation) {
      if (guildId && guildId !== installation.guildId) {
        return apiError(
          409,
          "CONFLICT",
          "Uninstall the current Discord server before choosing another",
        );
      }
      guildId = installation.guildId;
    }
    const state = randomBytes(32).toString("base64url");
    const browser = randomBytes(32).toString("base64url");
    const redirectUri = `${getOAuthApiOrigin(get(request$).raw)}${CALLBACK}`;
    await db.insert(discordOauthStates).values({
      stateHash: hash(state),
      browserHash: hash(browser),
      userId: auth.userId,
      orgId: auth.orgId,
      flow: body.data.flow,
      guildId,
      redirectUri,
      createdAt: nowDate(),
      expiresAt: new Date(now() + TTL_SECONDS * 1000),
    });
    signal.throwIfAborted();
    set(
      setResHeader$,
      "Set-Cookie",
      serialize(COOKIE, browser, {
        httpOnly: true,
        secure: new URL(redirectUri).protocol === "https:",
        sameSite: "Lax",
        path: COOKIE_PATH,
        maxAge: TTL_SECONDS,
      }),
    );
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
    return { status: 200 as const, body: { authorizationUrl: url.toString() } };
  },
);

class BindingConflict extends Error {
  constructor() {
    super("Discord binding conflict");
  }
}

const persistDiscordOauth$ = command(
  async (
    { set },
    args: {
      readonly attempt: Attempt;
      readonly guildId: string;
      readonly guildName: string;
      readonly discordUserId: string;
      readonly botUserId: string;
    },
    signal: AbortSignal,
  ) => {
    const { attempt } = args;
    const result = await settle(
      set(writeDb$).transaction(async (tx) => {
        if (attempt.flow === "install") {
          await tx
            .insert(discordOrgInstallations)
            .values({
              guildId: args.guildId,
              guildName: args.guildName,
              orgId: attempt.orgId,
              botUserId: args.botUserId,
              installedByUserId: attempt.userId,
              createdAt: nowDate(),
              updatedAt: nowDate(),
            })
            .onConflictDoNothing();
          signal.throwIfAborted();
        }
        const [installation] = await tx
          .select()
          .from(discordOrgInstallations)
          .where(
            and(
              eq(discordOrgInstallations.guildId, args.guildId),
              eq(discordOrgInstallations.orgId, attempt.orgId),
            ),
          )
          .for("share");
        signal.throwIfAborted();
        if (!installation || installation.botUserId !== args.botUserId) {
          throw new BindingConflict();
        }
        // A constrained identity row serializes claims across all guilds.
        await tx
          .insert(discordUserIdentities)
          .values({ discordUserId: args.discordUserId, userId: attempt.userId })
          .onConflictDoNothing();
        signal.throwIfAborted();
        const [owner] = await tx
          .select({ userId: discordUserIdentities.userId })
          .from(discordUserIdentities)
          .where(eq(discordUserIdentities.discordUserId, args.discordUserId))
          .for("share");
        signal.throwIfAborted();
        if (owner?.userId !== attempt.userId) {
          throw new BindingConflict();
        }
        const [inserted] = await tx
          .insert(discordOrgConnections)
          .values({
            guildId: args.guildId,
            userId: attempt.userId,
            discordUserId: args.discordUserId,
            createdAt: nowDate(),
          })
          .onConflictDoNothing()
          .returning({ id: discordOrgConnections.id });
        signal.throwIfAborted();
        const [connection] = await tx
          .select({ id: discordOrgConnections.id })
          .from(discordOrgConnections)
          .where(
            and(
              eq(discordOrgConnections.guildId, args.guildId),
              eq(discordOrgConnections.userId, attempt.userId),
              eq(discordOrgConnections.discordUserId, args.discordUserId),
            ),
          );
        signal.throwIfAborted();
        if (!connection) {
          throw new BindingConflict();
        }
        const recipients = await discordOrgChangedUserIds(tx, attempt.orgId, [
          attempt.userId,
        ]);
        signal.throwIfAborted();
        return {
          connectionId: connection.id,
          inserted: inserted?.id === connection.id,
          recipients,
        };
      }),
      signal,
    );
    if (!result.ok) {
      if (result.error instanceof BindingConflict) {
        return null;
      }
      throw result.error;
    }
    await publishDiscordChanged(result.value.recipients);
    signal.throwIfAborted();
    if (result.value.inserted) {
      await set(
        notifyDiscordConnection$,
        {
          connectionId: result.value.connectionId,
          orgId: attempt.orgId,
          userId: attempt.userId,
        },
        signal,
      );
    }
    return result.value;
  },
);

const completeDiscordOauth$ = command(
  async (
    { get, set },
    attempt: Attempt,
    code: string,
    guildHint: string | undefined,
    signal: AbortSignal,
  ) => {
    const config = getDiscordAppConfig();
    const clientSecret = optionalEnv("DISCORD_OAUTH_CLIENT_SECRET");
    if (!config || !clientSecret) {
      return redirect("error", "unavailable");
    }
    const verified = await verifyDiscordOauthGrant(
      {
        config,
        clientSecret,
        flow: attempt.flow,
        guildId: attempt.guildId,
        redirectUri: attempt.redirectUri,
        code,
        guildHint,
      },
      signal,
    );
    if (!verified.ok) {
      return redirect("error", verified.error);
    }
    // Re-read authority after all provider work, immediately before conditional writes.
    const role = await get(discordMemberRole(attempt));
    signal.throwIfAborted();
    if (!role || (attempt.flow === "install" && role !== "admin")) {
      return redirect("error", "forbidden");
    }
    if (
      !(await set(
        discordIntegrationEnabledForOwner$,
        attempt.orgId,
        attempt.userId,
        signal,
      ))
    ) {
      return redirect("error", "unavailable");
    }
    const saved = await set(
      persistDiscordOauth$,
      {
        attempt,
        ...verified.data,
      },
      signal,
    );
    return saved
      ? redirect(attempt.flow === "install" ? "installed" : "connected")
      : redirect("error", "conflict");
  },
);

const callbackDiscordOauth$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const query = get(queryOf(discordOauthContract.callback));
    const cookie = parse(get(request$).header("cookie") ?? "")[COOKIE];
    if (
      !query.state ||
      !/^[A-Za-z0-9_-]{43}$/u.test(query.state) ||
      !cookie ||
      !/^[A-Za-z0-9_-]{43}$/u.test(cookie)
    ) {
      return redirect("error", "invalid_state");
    }
    const [attempt] = await set(writeDb$)
      .delete(discordOauthStates)
      .where(
        and(
          eq(discordOauthStates.stateHash, hash(query.state)),
          eq(discordOauthStates.browserHash, hash(cookie)),
          gt(discordOauthStates.expiresAt, nowDate()),
        ),
      )
      .returning();
    signal.throwIfAborted();
    if (!attempt) {
      return redirect("error", "invalid_state");
    }
    set(
      setResHeader$,
      "Set-Cookie",
      serialize(COOKIE, "", {
        httpOnly: true,
        secure: new URL(attempt.redirectUri).protocol === "https:",
        sameSite: "Lax",
        path: COOKIE_PATH,
        maxAge: 0,
      }),
    );
    if (query.error) {
      return redirect("error", "cancelled");
    }
    if (!query.code || query.code.length > 2048) {
      return redirect("error", "invalid_authorization");
    }
    if (
      !(await set(
        discordIntegrationEnabledForOwner$,
        attempt.orgId,
        attempt.userId,
        signal,
      ))
    ) {
      return redirect("error", "unavailable");
    }
    const role = await get(discordMemberRole(attempt));
    signal.throwIfAborted();
    if (!role || (attempt.flow === "install" && role !== "admin")) {
      return redirect("error", "forbidden");
    }
    return await set(
      completeDiscordOauth$,
      attempt,
      query.code,
      query.guild_id,
      signal,
    );
  },
);

export const discordOauthRoutes: readonly RouteEntry[] = [
  {
    route: discordOauthContract.start,
    handler: authRoute(
      {
        requireOrganization: true,
        missingOrganizationStatus: 401,
        accept: ["session"],
      },
      startDiscordOauth$,
    ),
  },
  { route: discordOauthContract.callback, handler: callbackDiscordOauth$ },
];
