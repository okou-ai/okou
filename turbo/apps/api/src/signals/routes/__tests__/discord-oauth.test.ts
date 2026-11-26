import { randomBytes, randomUUID } from "node:crypto";
import { createStore } from "ccstate";
import { http, HttpResponse } from "msw";
import { object, string } from "zod";
import { describe, expect, it } from "vitest";
import { discordOauthContract } from "@okouai/api-contracts/contracts/discord-oauth";
import { integrationsDiscordContract } from "@okouai/api-contracts/contracts/integrations-discord";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp, setupRawAppRequest } from "../../../__tests__/test-helpers";
import { env, mockEnv } from "../../../lib/env";
import { mockNow, now } from "../../../lib/time";
import { server } from "../../../mocks/server";
import { discordOauthRoutes } from "../discord-oauth";
import { integrationsDiscordRoutes } from "../integrations-discord";
import { configureDiscordApp, uniqueDiscordSnowflake } from "./helpers/discord";
import {
  deleteOrgMembership$,
  seedOrgMembership$,
} from "./helpers/org-membership";
import { createRouteMocks } from "./helpers/route-test";

const context = testContext();
const SESSION = Object.freeze({ authorization: "Bearer clerk-session" });
const API = "https://discord.com/api/v10";
const INSTALL_SCOPES = Object.freeze([
  "identify",
  "guilds",
  "bot",
  "applications.commands",
]);
const PROVIDER_DETAIL = "provider-private-detail-7f3a";

interface Member {
  readonly userId: string;
  readonly orgId: string;
  readonly role: "admin" | "member";
}

interface ProviderGuild {
  readonly id: string;
  readonly name: string;
  readonly ownerId: string;
  readonly members: Set<string>;
  botPresent: boolean;
}

interface ProviderGrant {
  readonly discordUserId: string;
  readonly guildId: string;
  readonly install: boolean;
  readonly scopes: readonly string[];
}

interface Attempt {
  readonly state: string;
  readonly completionToken: string;
  readonly url: URL;
}

/** Real workspace members, as the identity provider reports them. */
function workspace() {
  const store = createStore();
  return {
    async member(
      role: "admin" | "member" = "admin",
      orgId = `org_${randomUUID()}`,
      userId = `user_${randomUUID()}`,
    ): Promise<Member> {
      await store.set(
        seedOrgMembership$,
        { orgId, userId, role, name: "Discord test workspace" },
        context.signal,
      );
      return { userId, orgId, role };
    },
    async revoke(member: Member): Promise<void> {
      await store.set(deleteOrgMembership$, member, context.signal);
    },
  };
}

function signIn(member: Member): void {
  createRouteMocks(context).clerk.session(
    member.userId,
    member.orgId,
    member.role === "admin" ? "org:admin" : "org:member",
  );
}

/** Discord's OAuth, bot and DM APIs for the accounts and servers a case owns. */
function discordProvider() {
  configureDiscordApp();
  mockEnv("DISCORD_OAUTH_CLIENT_SECRET", "discord-test-client-secret");
  const applicationId = env("DISCORD_APPLICATION_ID") ?? "";
  const botAuthorization = `Bot ${env("DISCORD_BOT_TOKEN")}`;
  const botUserId = applicationId;
  const guilds = new Map<string, ProviderGuild>();
  const codes = new Map<string, ProviderGrant>();
  const tokens = new Map<string, ProviderGrant>();
  const dmChannels = new Map<string, string>();
  const messages: { recipient: string; content: string }[] = [];

  function bearer(request: Request): ProviderGrant | undefined {
    const authorization = request.headers.get("authorization") ?? "";
    return authorization.startsWith("Bearer ")
      ? tokens.get(authorization.slice("Bearer ".length))
      : undefined;
  }
  function isBot(request: Request): boolean {
    return request.headers.get("authorization") === botAuthorization;
  }
  function unauthorized() {
    return HttpResponse.json(
      { message: "401: Unauthorized", code: 0 },
      { status: 401 },
    );
  }
  function botGuild(request: Request, guildId: unknown) {
    const guild = guilds.get(String(guildId));
    return isBot(request) && guild?.botPresent ? guild : undefined;
  }
  function unknownGuild() {
    return HttpResponse.json(
      { message: `Unknown Guild ${PROVIDER_DETAIL}`, code: 10_004 },
      { status: 404 },
    );
  }

  server.use(
    http.post(`${API}/oauth2/token`, async ({ request }) => {
      const code = new URLSearchParams(await request.text()).get("code") ?? "";
      const grant = codes.get(code);
      codes.delete(code);
      if (!grant) {
        return HttpResponse.json({ error: "invalid_grant" }, { status: 400 });
      }
      const accessToken = `discord-access-${randomUUID()}`;
      tokens.set(accessToken, grant);
      const guild = guilds.get(grant.guildId);
      return HttpResponse.json({
        access_token: accessToken,
        token_type: "Bearer",
        expires_in: 604_800,
        refresh_token: `discord-refresh-${randomUUID()}`,
        scope: grant.scopes.join(" "),
        ...(grant.install && guild
          ? { guild: { id: guild.id, name: guild.name } }
          : {}),
      });
    }),
    http.get(`${API}/oauth2/@me`, ({ request }) => {
      const grant = bearer(request);
      if (!grant) {
        return unauthorized();
      }
      return HttpResponse.json({
        application: { id: applicationId },
        scopes: grant.scopes,
        expires: new Date(now() + 604_800_000).toISOString(),
        user: { id: grant.discordUserId, username: "member" },
      });
    }),
    http.get(`${API}/oauth2/applications/@me`, ({ request }) => {
      if (!isBot(request)) {
        return unauthorized();
      }
      return HttpResponse.json({
        id: applicationId,
        bot: { id: botUserId, username: "Okou" },
      });
    }),
    http.get(`${API}/users/@me`, ({ request }) => {
      if (isBot(request)) {
        return HttpResponse.json({
          id: botUserId,
          username: "Okou",
          bot: true,
        });
      }
      const grant = bearer(request);
      if (!grant) {
        return unauthorized();
      }
      return HttpResponse.json({ id: grant.discordUserId, username: "member" });
    }),
    http.get(`${API}/users/@me/guilds`, ({ request }) => {
      const grant = bearer(request);
      if (!grant) {
        return unauthorized();
      }
      const after = new URL(request.url).searchParams.get("after") ?? "0";
      if (after !== "0") {
        return HttpResponse.json([]);
      }
      return HttpResponse.json(
        [...guilds.values()]
          .filter((guild) => {
            return guild.members.has(grant.discordUserId);
          })
          .map((guild) => {
            const owner = guild.ownerId === grant.discordUserId;
            return {
              id: guild.id,
              name: guild.name,
              owner,
              permissions: owner ? "8" : "0",
              features: [],
            };
          }),
      );
    }),
    http.get(`${API}/guilds/:guildId`, ({ request, params }) => {
      const guild = botGuild(request, params.guildId);
      if (!guild) {
        return unknownGuild();
      }
      return HttpResponse.json({
        id: guild.id,
        name: guild.name,
        owner_id: guild.ownerId,
      });
    }),
    http.get(`${API}/guilds/:guildId/roles`, ({ request, params }) => {
      const guild = botGuild(request, params.guildId);
      if (!guild) {
        return unknownGuild();
      }
      return HttpResponse.json([
        { id: guild.id, name: "@everyone", permissions: "0" },
      ]);
    }),
    http.get(
      `${API}/guilds/:guildId/members/:userId`,
      ({ request, params }) => {
        const guild = botGuild(request, params.guildId);
        const userId = String(params.userId);
        if (!guild || (userId !== botUserId && !guild.members.has(userId))) {
          return HttpResponse.json(
            { message: "Unknown Member", code: 10_007 },
            { status: 404 },
          );
        }
        return HttpResponse.json({
          user: { id: userId, username: "member", bot: userId === botUserId },
          roles: [],
        });
      },
    ),
    http.post(`${API}/users/@me/channels`, async ({ request }) => {
      if (!isBot(request)) {
        return unauthorized();
      }
      const { recipient_id: recipient } = object({
        recipient_id: string(),
      }).parse(await request.json());
      const channelId =
        [...dmChannels.entries()].find(([, user]) => {
          return user === recipient;
        })?.[0] ?? uniqueDiscordSnowflake();
      dmChannels.set(channelId, recipient);
      return HttpResponse.json({
        id: channelId,
        type: 1,
        recipients: [{ id: recipient, username: "member" }],
      });
    }),
    http.get(`${API}/channels/:channelId`, ({ request, params }) => {
      const recipient = dmChannels.get(String(params.channelId));
      if (!isBot(request) || !recipient) {
        return HttpResponse.json(
          { message: "Unknown Channel", code: 10_003 },
          { status: 404 },
        );
      }
      return HttpResponse.json({
        id: String(params.channelId),
        type: 1,
        recipients: [{ id: recipient, username: "member" }],
      });
    }),
    http.post(
      `${API}/channels/:channelId/messages`,
      async ({ request, params }) => {
        const channelId = String(params.channelId);
        const recipient = dmChannels.get(channelId);
        if (!isBot(request) || !recipient) {
          return HttpResponse.json(
            { message: "Unknown Channel", code: 10_003 },
            { status: 404 },
          );
        }
        const { content } = object({ content: string() }).parse(
          await request.json(),
        );
        messages.push({ recipient, content });
        return HttpResponse.json({
          id: uniqueDiscordSnowflake(),
          channel_id: channelId,
          author: { id: botUserId, username: "Okou", bot: true },
          content,
          timestamp: new Date(now()).toISOString(),
          attachments: [],
        });
      },
    ),
  );

  return {
    botUserId,
    /** A Discord server owned by one account, with the Okou bot present. */
    guild(ownerId: string, name = "Discord test guild"): string {
      const id = uniqueDiscordSnowflake();
      guilds.set(id, {
        id,
        name,
        ownerId,
        members: new Set([ownerId]),
        botPresent: true,
      });
      return id;
    },
    join(guildId: string, discordUserId: string): void {
      guilds.get(guildId)?.members.add(discordUserId);
    },
    removeBot(guildId: string): void {
      const guild = guilds.get(guildId);
      if (guild) {
        guild.botPresent = false;
      }
    },
    /** The code Discord issues once the account consents. */
    consent(grant: {
      readonly discordUserId: string;
      readonly guildId: string;
      readonly install: boolean;
      readonly scopes?: readonly string[];
    }): string {
      const code = randomUUID();
      codes.set(code, {
        ...grant,
        scopes:
          grant.scopes ??
          (grant.install ? INSTALL_SCOPES : ["identify", "guilds"]),
      });
      return code;
    },
    welcomes(): readonly { recipient: string; content: string }[] {
      return [...messages];
    },
  };
}

type Provider = ReturnType<typeof discordProvider>;

function oauthApi() {
  return setupApp({ context, routes: discordOauthRoutes })(
    discordOauthContract,
  );
}

async function startOauth(
  member: Member,
  body: { guildId?: string; flow?: "install" | "connect" } = {},
): Promise<Attempt> {
  signIn(member);
  const started = await accept(
    oauthApi().start({ headers: SESSION, body }),
    [200],
  );
  const url = new URL(started.body.authorizationUrl);
  const state = url.searchParams.get("state");
  if (!state) {
    throw new Error("Discord OAuth start did not issue state");
  }
  return { state, completionToken: started.body.completionToken, url };
}

/** The anonymous browser landing that Discord redirects to. */
async function callback(query: {
  code?: string;
  state?: string;
  guild_id?: string;
  error?: string;
}) {
  const response = await accept(oauthApi().callback({ query }), [307]);
  const location = new URL(response.headers.get("location") ?? "");
  const fragment = new URLSearchParams(location.hash.slice(1));
  return {
    location: location.toString(),
    status: location.searchParams.get("status"),
    error: location.searchParams.get("discord_error"),
    guildId: location.searchParams.get("guild_id"),
    approvalProof: fragment.get("approval_proof"),
  };
}

async function approveOauth(
  member: Member,
  state: string,
  approvalProof: string,
): Promise<number> {
  signIn(member);
  const response = await oauthApi().approve({
    headers: SESSION,
    body: { state, approvalProof },
  });
  return response.status;
}

async function completeOauth(member: Member, attempt: Attempt) {
  signIn(member);
  const response = await oauthApi().complete({
    headers: SESSION,
    body: { state: attempt.state, completionToken: attempt.completionToken },
  });
  return {
    status: response.status,
    code: "error" in response.body ? response.body.error.code : null,
    body: JSON.stringify(response.body),
  };
}

/** Discord consent through the landing and the consent browser's approval. */
async function consentAndApprove(
  provider: Provider,
  member: Member,
  attempt: Attempt,
  grant: { discordUserId: string; guildId: string; install: boolean },
): Promise<void> {
  const code = provider.consent(grant);
  const landing = await callback({
    code,
    state: attempt.state,
    ...(grant.install ? { guild_id: grant.guildId } : {}),
  });
  if (!landing.approvalProof) {
    throw new Error(
      `Discord OAuth landing did not verify: ${landing.location}`,
    );
  }
  await expect(
    approveOauth(member, attempt.state, landing.approvalProof),
  ).resolves.toBe(200);
}

/** The full public OAuth path; returns the completion's status. */
async function authorizeDiscord(
  provider: Provider,
  member: Member,
  grant: { discordUserId: string; guildId: string; install: boolean },
) {
  const attempt = await startOauth(
    member,
    grant.install ? {} : { guildId: grant.guildId },
  );
  await consentAndApprove(provider, member, attempt, grant);
  return await completeOauth(member, attempt);
}

async function readStatus(member: Member) {
  signIn(member);
  const response = await accept(
    setupApp({ context, routes: integrationsDiscordRoutes })(
      integrationsDiscordContract,
    ).getStatus({ headers: SESSION }),
    [200],
  );
  return response.body;
}

async function disconnect(member: Member): Promise<number> {
  signIn(member);
  const response = await setupApp({
    context,
    routes: integrationsDiscordRoutes,
  })(integrationsDiscordContract).disconnect({ headers: SESSION, query: {} });
  return response.status;
}

/** An admin who installed Okou into their own Discord server. */
async function installedOwner(provider: Provider, member: Member) {
  const discordUserId = uniqueDiscordSnowflake();
  const guildId = provider.guild(discordUserId);
  const completed = await authorizeDiscord(provider, member, {
    discordUserId,
    guildId,
    install: true,
  });
  if (completed.status !== 200) {
    throw new Error(`Discord installation failed: ${completed.body}`);
  }
  return { discordUserId, guildId };
}

/** An install completed at a pinned time, with another member of its workspace. */
async function completedInstallBeforeExpiry() {
  const provider = discordProvider();
  const members = workspace();
  const owner = await members.member("admin");
  const other = await members.member("member", owner.orgId);
  const startedAt = now();
  mockNow(startedAt);
  const discordUserId = uniqueDiscordSnowflake();
  const guildId = provider.guild(discordUserId);
  const original = await startOauth(owner);
  await consentAndApprove(provider, owner, original, {
    discordUserId,
    guildId,
    install: true,
  });
  const completed = await completeOauth(owner, original);
  if (completed.status !== 200) {
    throw new Error(`Discord installation failed: ${completed.body}`);
  }
  return {
    provider,
    owner,
    other,
    discordUserId,
    guildId,
    original,
    startedAt,
  };
}

function unissuedState(): string {
  return randomBytes(32).toString("base64url");
}

describe("Discord product OAuth", () => {
  it("discord-oauth-006 allows ordinary workspace members to connect and rejects unauthenticated or malformed owner input", async () => {
    discordProvider();
    const members = workspace();
    const member = await members.member("member");

    signIn(member);
    const normal = await oauthApi().start({ headers: SESSION, body: {} });
    signIn(member);
    const ownerFields = await setupRawAppRequest({
      context,
      routes: discordOauthRoutes,
    })("/api/integrations/discord/oauth/start", {
      method: "POST",
      headers: { ...SESSION, "content-type": "application/json" },
      body: JSON.stringify({
        userId: `user_${randomUUID()}`,
        orgId: `org_${randomUUID()}`,
      }),
    });
    context.mocks.clerk.authenticateRequest.mockResolvedValue({
      isAuthenticated: false,
    });
    const signedOut = await oauthApi().start({ headers: {}, body: {} });

    expect([normal.status, ownerFields.status, signedOut.status]).toStrictEqual(
      [200, 400, 401],
    );
    await expect(readStatus(member)).resolves.toMatchObject({
      isConnected: false,
    });
  });

  it("discord-oauth-001 installs the verified bot, connects the admin and welcomes only a newly committed connection", async () => {
    const provider = discordProvider();
    const admin = await workspace().member("admin");
    const discordUserId = uniqueDiscordSnowflake();
    const guildId = provider.guild(discordUserId, "Product server");
    const initial = await readStatus(admin);

    const first = await authorizeDiscord(provider, admin, {
      discordUserId,
      guildId,
      install: true,
    });
    const repeated = await authorizeDiscord(provider, admin, {
      discordUserId,
      guildId,
      install: true,
    });
    const statuses = [await readStatus(admin), await readStatus(admin)];

    expect(initial).toMatchObject({
      isAvailable: true,
      isConnected: false,
      onboarding: "oauth",
    });
    expect([first.status, repeated.status]).toStrictEqual([200, 200]);
    for (const status of statuses) {
      expect(status).toMatchObject({
        isConnected: true,
        isAdmin: true,
        guildId,
        guildName: "Product server",
        discordUserId,
      });
    }
    const welcomes = provider.welcomes();
    expect(welcomes).toHaveLength(1);
    expect(welcomes[0]?.recipient).toBe(discordUserId);
    expect(welcomes[0]?.content).toContain(`<@${provider.botUserId}>`);
    expect(welcomes[0]?.content).toContain(
      "Send me a message describing what you need help with.",
    );
  });

  it("discord-oauth-002 installs when Discord returns only user scopes in the token and authorization", async () => {
    const provider = discordProvider();
    const admin = await workspace().member("admin");
    const discordUserId = uniqueDiscordSnowflake();
    const guildId = provider.guild(discordUserId);

    const attempt = await startOauth(admin);
    const code = provider.consent({
      discordUserId,
      guildId,
      install: true,
      scopes: ["identify", "guilds"],
    });
    const landing = await callback({
      code,
      state: attempt.state,
      guild_id: guildId,
    });
    const approved = await approveOauth(
      admin,
      attempt.state,
      landing.approvalProof ?? "",
    );
    const completed = await completeOauth(admin, attempt);

    expect(attempt.url.searchParams.get("scope")).toBe(
      "bot applications.commands identify guilds",
    );
    expect(attempt.url.searchParams.get("integration_type")).toBe("0");
    expect(attempt.url.searchParams.has("guild_id")).toBeFalsy();
    expect(attempt.url.searchParams.has("disable_guild_select")).toBeFalsy();
    expect(approved).toBe(200);
    expect(completed).toMatchObject({ status: 200, code: null });
    expect(completed.body).toBe(JSON.stringify({ status: "connected" }));
    await expect(readStatus(admin)).resolves.toMatchObject({
      isConnected: true,
      discordUserId,
      guildId,
    });
  });

  it("discord-oauth-003 (1/2) keeps the completed binding after a later attempt and refuses the old completion", async () => {
    const given = await completedInstallBeforeExpiry();
    const before = await readStatus(given.owner);

    mockNow(given.startedAt + 601_000);
    await startOauth(given.owner);
    const retained = await readStatus(given.owner);
    const oldCompletion = await completeOauth(given.owner, given.original);

    expect(retained.isConnected).toBeTruthy();
    expect(retained.dmBindings).toStrictEqual(before.dmBindings);
    expect(retained.dmBindings).toHaveLength(1);
    expect(oldCompletion.status).toBe(400);
  });

  it("discord-oauth-003 (2/2) disconnect clears the binding, voids the pending attempt and frees the identity", async () => {
    const given = await completedInstallBeforeExpiry();
    mockNow(given.startedAt + 601_000);
    const pending = await startOauth(given.owner);

    const disconnected = await disconnect(given.owner);
    const afterDisconnect = await readStatus(given.owner);
    const pendingCompletion = await completeOauth(given.owner, pending);
    const freed = await authorizeDiscord(given.provider, given.other, {
      discordUserId: given.discordUserId,
      guildId: given.guildId,
      install: false,
    });

    expect(disconnected).toBe(200);
    expect(afterDisconnect).toMatchObject({
      isConnected: false,
      discordUserId: null,
    });
    expect(pendingCompletion.status).toBe(400);
    expect(freed.status).toBe(200);
    await expect(readStatus(given.other)).resolves.toMatchObject({
      isConnected: true,
      discordUserId: given.discordUserId,
    });
  });

  it("discord-oauth-004 connects from a server link without a workspace installation or server-management permission", async () => {
    const provider = discordProvider();
    const member = await workspace().member("member");
    const discordUserId = uniqueDiscordSnowflake();
    const guildId = provider.guild(uniqueDiscordSnowflake());
    provider.join(guildId, discordUserId);

    const attempt = await startOauth(member, { guildId });
    await consentAndApprove(provider, member, attempt, {
      discordUserId,
      guildId,
      install: false,
    });
    const completed = await completeOauth(member, attempt);

    expect(attempt.url.searchParams.get("scope")).toBe("identify guilds");
    expect(attempt.url.searchParams.has("permissions")).toBeFalsy();
    expect(attempt.url.searchParams.has("integration_type")).toBeFalsy();
    expect(completed.status).toBe(200);
    await expect(readStatus(member)).resolves.toMatchObject({
      isConnected: true,
      isAdmin: false,
      discordUserId,
      guildId,
    });
  });

  it("discord-oauth-005 lets an ordinary current org member connect only their verified Discord identity", async () => {
    const provider = discordProvider();
    const members = workspace();
    const admin = await members.member("admin");
    const member = await members.member("member", admin.orgId);
    const installed = await installedOwner(provider, admin);
    const memberDiscordId = uniqueDiscordSnowflake();
    provider.join(installed.guildId, memberDiscordId);

    const attempt = await startOauth(member, { guildId: installed.guildId });
    await consentAndApprove(provider, member, attempt, {
      discordUserId: memberDiscordId,
      guildId: installed.guildId,
      install: false,
    });
    const completed = await completeOauth(member, attempt);

    expect(attempt.url.searchParams.get("scope")).toBe("identify guilds");
    expect(completed.status).toBe(200);
    await expect(readStatus(member)).resolves.toMatchObject({
      isConnected: true,
      discordUserId: memberDiscordId,
      guildId: installed.guildId,
    });
    await expect(readStatus(admin)).resolves.toMatchObject({
      isConnected: true,
      discordUserId: installed.discordUserId,
    });
  });

  it("discord-oauth-009 rejects a forged well-formed state without consuming the genuine attempt", async () => {
    const provider = discordProvider();
    const admin = await workspace().member("admin");
    const discordUserId = uniqueDiscordSnowflake();
    const guildId = provider.guild(discordUserId);
    const attempt = await startOauth(admin);

    const forged = await callback({
      code: provider.consent({ discordUserId, guildId, install: true }),
      state: unissuedState(),
      guild_id: guildId,
    });
    const afterForged = await readStatus(admin);
    await consentAndApprove(provider, admin, attempt, {
      discordUserId,
      guildId,
      install: true,
    });
    const completed = await completeOauth(admin, attempt);

    expect(forged).toMatchObject({ status: "error", error: "invalid_state" });
    expect(afterForged.isConnected).toBeFalsy();
    expect(completed.status).toBe(200);
    await expect(readStatus(admin)).resolves.toMatchObject({
      isConnected: true,
      discordUserId,
    });
  });

  it("discord-oauth-013 rejects expired and reused state, and cancellation is one-use with no provider text", async () => {
    const provider = discordProvider();
    const admin = await workspace().member("admin");
    const discordUserId = uniqueDiscordSnowflake();
    const guildId = provider.guild(discordUserId);
    const startedAt = now();
    mockNow(startedAt);
    const expired = await startOauth(admin);
    mockNow(startedAt + 601_000);

    const expiredLanding = await callback({
      code: provider.consent({ discordUserId, guildId, install: true }),
      state: expired.state,
      guild_id: guildId,
    });
    const fresh = await startOauth(admin);
    const valid = await startOauth(admin);
    const cancelQuery = new URLSearchParams({
      error: "access_denied",
      error_description: `The resource owner denied the request ${PROVIDER_DETAIL}`,
      state: fresh.state,
    });
    const cancelled = await setupRawAppRequest({
      context,
      routes: discordOauthRoutes,
    })(`/api/integrations/discord/oauth/callback?${cancelQuery.toString()}`, {
      method: "GET",
    });
    const cancelledLocation = new URL(cancelled.headers.get("location") ?? "");
    const cancelReplay = await callback({
      error: "access_denied",
      state: fresh.state,
    });
    const afterCancel = await readStatus(admin);
    const welcomesAfterCancel = provider.welcomes().length;
    const validCode = provider.consent({
      discordUserId,
      guildId,
      install: true,
    });
    const validLanding = await callback({
      code: validCode,
      state: valid.state,
      guild_id: guildId,
    });
    await expect(
      approveOauth(admin, valid.state, validLanding.approvalProof ?? ""),
    ).resolves.toBe(200);
    const completed = await completeOauth(admin, valid);
    const welcomesAfterValid = provider.welcomes().length;
    const validReplay = await callback({
      code: validCode,
      state: valid.state,
      guild_id: guildId,
    });

    expect(expiredLanding.error).toBe("invalid_state");
    expect(cancelled.status).toBe(307);
    expect(cancelledLocation.searchParams.get("status")).toBe("error");
    expect(cancelledLocation.searchParams.get("discord_error")).toBe(
      "cancelled",
    );
    expect(cancelledLocation.toString()).not.toContain(PROVIDER_DETAIL);
    expect(cancelledLocation.toString()).not.toContain("access_denied");
    expect(cancelReplay.error).toBe("invalid_state");
    expect(afterCancel.isConnected).toBeFalsy();
    expect(welcomesAfterCancel).toBe(0);
    expect(completed.status).toBe(200);
    expect(welcomesAfterValid).toBe(1);
    expect(validReplay.error).toBe("invalid_state");
    expect(provider.welcomes()).toHaveLength(1);
  });

  it("discord-oauth-023 fails closed for bot-missing and leaves status unchanged", async () => {
    const provider = discordProvider();
    const admin = await workspace().member("admin");
    const discordUserId = uniqueDiscordSnowflake();
    const guildId = provider.guild(discordUserId);
    const attempt = await startOauth(admin);
    provider.removeBot(guildId);

    const landing = await callback({
      code: provider.consent({ discordUserId, guildId, install: true }),
      state: attempt.state,
      guild_id: guildId,
    });
    const completed = await completeOauth(admin, attempt);

    expect(landing).toMatchObject({
      status: "error",
      error: "bot_missing",
      approvalProof: null,
    });
    expect(landing.location).not.toContain(PROVIDER_DETAIL);
    expect(completed.status).toBe(400);
    expect(completed.body).not.toContain(PROVIDER_DETAIL);
    expect(completed.body).not.toContain("Unknown Guild");
    await expect(readStatus(admin)).resolves.toMatchObject({
      isConnected: false,
    });
    expect(provider.welcomes()).toHaveLength(0);
  });

  it("discord-oauth-026 revalidates revoked membership while authorization is open", async () => {
    const provider = discordProvider();
    const members = workspace();
    const admin = await members.member("admin");
    const discordUserId = uniqueDiscordSnowflake();
    const guildId = provider.guild(discordUserId);
    const attempt = await startOauth(admin);
    await members.revoke(admin);

    const landing = await callback({
      code: provider.consent({ discordUserId, guildId, install: true }),
      state: attempt.state,
      guild_id: guildId,
    });
    await approveOauth(admin, attempt.state, landing.approvalProof ?? "");
    const completed = await completeOauth(admin, attempt);

    expect(completed.status).toBe(403);
    await expect(readStatus(admin)).resolves.toMatchObject({
      isConnected: false,
    });
    expect(provider.welcomes()).toHaveLength(0);
  });

  it("discord-oauth-029 connects independent workspaces in the same server and preserves a connection when choosing another server", async () => {
    const provider = discordProvider();
    const members = workspace();
    const owner = await members.member("admin");
    const otherMember = await members.member("member");
    const installed = await installedOwner(provider, owner);
    const before = await readStatus(owner);
    const otherDiscordId = uniqueDiscordSnowflake();
    provider.join(installed.guildId, otherDiscordId);
    const newGuildId = provider.guild(installed.discordUserId, "Second server");

    const second = await authorizeDiscord(provider, otherMember, {
      discordUserId: otherDiscordId,
      guildId: installed.guildId,
      install: false,
    });
    const moved = await authorizeDiscord(provider, owner, {
      discordUserId: installed.discordUserId,
      guildId: newGuildId,
      install: true,
    });
    const ownerStatus = await readStatus(owner);
    const otherStatus = await readStatus(otherMember);

    expect([second.status, moved.status]).toStrictEqual([200, 200]);
    expect(otherStatus).toMatchObject({
      isConnected: true,
      discordUserId: otherDiscordId,
      guildId: installed.guildId,
    });
    expect(ownerStatus).toMatchObject({
      isConnected: true,
      discordUserId: installed.discordUserId,
      guildId: newGuildId,
    });
    expect(
      ownerStatus.dmBindings.map((binding) => {
        return binding.connectionId;
      }),
    ).toStrictEqual(
      before.dmBindings.map((binding) => {
        return binding.connectionId;
      }),
    );
    expect(provider.welcomes()).toHaveLength(2);
  });

  it("discord-oauth-030 rejects stealing a Discord identity in the same guild and across guilds", async () => {
    const provider = discordProvider();
    const members = workspace();
    const owner = await members.member("admin");
    const sameWorkspace = await members.member("member", owner.orgId);
    const otherWorkspace = await members.member("admin");
    const installed = await installedOwner(provider, owner);
    const otherGuildId = provider.guild(installed.discordUserId);

    const sameGuild = await authorizeDiscord(provider, sameWorkspace, {
      discordUserId: installed.discordUserId,
      guildId: installed.guildId,
      install: false,
    });
    const crossGuild = await authorizeDiscord(provider, otherWorkspace, {
      discordUserId: installed.discordUserId,
      guildId: otherGuildId,
      install: true,
    });

    expect([sameGuild.code, crossGuild.code]).toStrictEqual([
      "CONFLICT",
      "CONFLICT",
    ]);
    await expect(readStatus(sameWorkspace)).resolves.toMatchObject({
      isConnected: false,
    });
    await expect(readStatus(otherWorkspace)).resolves.toMatchObject({
      isConnected: false,
    });
    await expect(readStatus(owner)).resolves.toMatchObject({
      isConnected: true,
      discordUserId: installed.discordUserId,
    });
    expect(provider.welcomes()).toHaveLength(1);
  });

  it("discord-oauth-031 requires disconnect before changing a user's Discord identity and releases unused ownership", async () => {
    const provider = discordProvider();
    const members = workspace();
    const owner = await members.member("admin");
    const next = await members.member("member", owner.orgId);
    const installed = await installedOwner(provider, owner);
    const replacementId = uniqueDiscordSnowflake();
    provider.join(installed.guildId, replacementId);

    const switched = await authorizeDiscord(provider, owner, {
      discordUserId: replacementId,
      guildId: installed.guildId,
      install: false,
    });
    const disconnected = await disconnect(owner);
    const ownerStatus = await readStatus(owner);
    const released = await authorizeDiscord(provider, next, {
      discordUserId: installed.discordUserId,
      guildId: installed.guildId,
      install: false,
    });

    expect(switched.code).toBe("CONFLICT");
    expect(disconnected).toBe(200);
    expect(ownerStatus).toMatchObject({
      isConnected: false,
      discordUserId: null,
    });
    expect(released.status).toBe(200);
    await expect(readStatus(next)).resolves.toMatchObject({
      isConnected: true,
      discordUserId: installed.discordUserId,
    });
  });

  it("discord-oauth-032 does not reserve a replacement Discord identity after an occupied-user binding fails", async () => {
    const provider = discordProvider();
    const members = workspace();
    const owner = await members.member("admin");
    const otherOwner = await members.member("admin");
    const installed = await installedOwner(provider, owner);
    const replacementId = uniqueDiscordSnowflake();
    const replacementGuildId = provider.guild(replacementId, "Replacement");
    const attempt = await startOauth(owner);
    await consentAndApprove(provider, owner, attempt, {
      discordUserId: replacementId,
      guildId: replacementGuildId,
      install: true,
    });

    const conflicting = await completeOauth(owner, attempt);
    const replay = await completeOauth(owner, attempt);
    const legitimate = await authorizeDiscord(provider, otherOwner, {
      discordUserId: replacementId,
      guildId: replacementGuildId,
      install: true,
    });

    expect([conflicting.status, replay.status]).toStrictEqual([409, 400]);
    await expect(readStatus(owner)).resolves.toMatchObject({
      isConnected: true,
      discordUserId: installed.discordUserId,
    });
    expect(legitimate.status).toBe(200);
    await expect(readStatus(otherOwner)).resolves.toMatchObject({
      isConnected: true,
      discordUserId: replacementId,
      guildId: replacementGuildId,
    });
    expect(
      provider.welcomes().map((welcome) => {
        return welcome.recipient;
      }),
    ).toStrictEqual([installed.discordUserId, replacementId]);
  });

  it("discord-oauth-036 installs into an invite's server while preserving the existing account connection", async () => {
    const provider = discordProvider();
    const owner = await workspace().member("admin");
    const installed = await installedOwner(provider, owner);
    const before = await readStatus(owner);
    const inviteGuildId = provider.guild(installed.discordUserId, "Invited");

    const attempt = await startOauth(owner, {
      guildId: inviteGuildId,
      flow: "install",
    });
    await consentAndApprove(provider, owner, attempt, {
      discordUserId: installed.discordUserId,
      guildId: inviteGuildId,
      install: true,
    });
    const completed = await completeOauth(owner, attempt);
    const after = await readStatus(owner);

    expect(attempt.url.searchParams.get("guild_id")).toBe(inviteGuildId);
    expect(attempt.url.searchParams.get("disable_guild_select")).toBe("true");
    expect(attempt.url.searchParams.get("scope")?.split(" ")).toContain("bot");
    expect(attempt.url.searchParams.get("integration_type")).toBe("0");
    expect(completed.status).toBe(200);
    expect(after).toMatchObject({
      isConnected: true,
      guildId: inviteGuildId,
      discordUserId: installed.discordUserId,
    });
    expect(
      after.dmBindings.map((binding) => {
        return binding.connectionId;
      }),
    ).toStrictEqual(
      before.dmBindings.map((binding) => {
        return binding.connectionId;
      }),
    );
    expect(provider.welcomes()).toHaveLength(1);
  });

  it("discord-oauth-043 does not reconnect an account from a pending attempt after disconnect", async () => {
    const provider = discordProvider();
    const owner = await workspace().member("admin");
    const installed = await installedOwner(provider, owner);
    const reconnect = await startOauth(owner);

    const disconnected = await disconnect(owner);
    const landing = await callback({
      code: provider.consent({
        discordUserId: installed.discordUserId,
        guildId: installed.guildId,
        install: true,
      }),
      state: reconnect.state,
      guild_id: installed.guildId,
    });

    expect(disconnected).toBe(200);
    expect(landing).toMatchObject({ status: "error", error: "invalid_state" });
    await expect(readStatus(owner)).resolves.toMatchObject({
      isConnected: false,
    });
    expect(provider.welcomes()).toHaveLength(1);
  });

  it("discord-oauth-045 neither the anonymous callback nor approval binds; only approved owner completion binds once", async () => {
    const provider = discordProvider();
    const owner = await workspace().member("admin");
    const discordUserId = uniqueDiscordSnowflake();
    const guildId = provider.guild(discordUserId);
    const attempt = await startOauth(owner, { guildId, flow: "install" });

    const early = await completeOauth(owner, attempt);
    const landing = await callback({
      code: provider.consent({ discordUserId, guildId, install: true }),
      state: attempt.state,
      guild_id: guildId,
    });
    const afterLanding = await completeOauth(owner, attempt);
    const statusAfterLanding = await readStatus(owner);
    const proof = landing.approvalProof ?? "";
    const approved = await approveOauth(owner, attempt.state, proof);
    const approvalReplay = await approveOauth(owner, attempt.state, proof);
    const statusAfterApproval = await readStatus(owner);
    const welcomesBeforeCompletion = provider.welcomes().length;
    const completed = await completeOauth(owner, attempt);
    const completionReplay = await completeOauth(owner, attempt);

    expect(early.status).toBe(409);
    expect(landing).toMatchObject({ status: "pending", guildId });
    expect(afterLanding.status).toBe(409);
    expect(statusAfterLanding.isConnected).toBeFalsy();
    expect([approved, approvalReplay]).toStrictEqual([200, 400]);
    expect(statusAfterApproval.isConnected).toBeFalsy();
    expect(welcomesBeforeCompletion).toBe(0);
    expect([completed.status, completionReplay.status]).toStrictEqual([
      200, 400,
    ]);
    await expect(readStatus(owner)).resolves.toMatchObject({
      isConnected: true,
      discordUserId,
    });
    expect(provider.welcomes()).toHaveLength(1);
  });

  it("discord-oauth-046 rejects attacker-start/victim-consent different-account without granting the attacker access", async () => {
    const provider = discordProvider();
    const members = workspace();
    const initiator = await members.member("admin");
    const consenting = await members.member("member", initiator.orgId);
    const discordUserId = uniqueDiscordSnowflake();
    const guildId = provider.guild(discordUserId);
    const attempt = await startOauth(initiator);
    const landing = await callback({
      code: provider.consent({ discordUserId, guildId, install: true }),
      state: attempt.state,
      guild_id: guildId,
    });

    const approved = await approveOauth(
      consenting,
      attempt.state,
      landing.approvalProof ?? "",
    );
    const completedByConsenting = await completeOauth(consenting, attempt);
    const completedByInitiator = await completeOauth(initiator, attempt);

    expect([
      approved,
      completedByConsenting.status,
      completedByInitiator.status,
    ]).toStrictEqual([403, 403, 409]);
    await expect(readStatus(initiator)).resolves.toMatchObject({
      isConnected: false,
    });
    await expect(readStatus(consenting)).resolves.toMatchObject({
      isConnected: false,
    });
    expect(provider.welcomes()).toHaveLength(0);
  });

  it("discord-oauth-047 rejects attacker-start/victim-consent different-org without granting the attacker access", async () => {
    const provider = discordProvider();
    const members = workspace();
    const initiator = await members.member("admin");
    const consenting = await members.member(
      "admin",
      `org_${randomUUID()}`,
      initiator.userId,
    );
    const discordUserId = uniqueDiscordSnowflake();
    const guildId = provider.guild(discordUserId);
    const attempt = await startOauth(initiator);
    const landing = await callback({
      code: provider.consent({ discordUserId, guildId, install: true }),
      state: attempt.state,
      guild_id: guildId,
    });

    const approved = await approveOauth(
      consenting,
      attempt.state,
      landing.approvalProof ?? "",
    );
    const completedByConsenting = await completeOauth(consenting, attempt);
    const completedByInitiator = await completeOauth(initiator, attempt);

    expect([
      approved,
      completedByConsenting.status,
      completedByInitiator.status,
    ]).toStrictEqual([403, 403, 409]);
    await expect(readStatus(initiator)).resolves.toMatchObject({
      isConnected: false,
    });
    await expect(readStatus(consenting)).resolves.toMatchObject({
      isConnected: false,
    });
    expect(provider.welcomes()).toHaveLength(0);
  });

  it("discord-oauth-048 revalidates member-before-approve after provider verification", async () => {
    const provider = discordProvider();
    const members = workspace();
    const owner = await members.member("admin");
    const discordUserId = uniqueDiscordSnowflake();
    const guildId = provider.guild(discordUserId);
    const attempt = await startOauth(owner);
    const landing = await callback({
      code: provider.consent({ discordUserId, guildId, install: true }),
      state: attempt.state,
      guild_id: guildId,
    });
    await members.revoke(owner);

    const approved = await approveOauth(
      owner,
      attempt.state,
      landing.approvalProof ?? "",
    );

    expect(approved).toBe(403);
    await expect(readStatus(owner)).resolves.toMatchObject({
      isConnected: false,
    });
    expect(provider.welcomes()).toHaveLength(0);
  });

  it("discord-oauth-055 does not extend original expiry for verified evidence", async () => {
    const provider = discordProvider();
    const owner = await workspace().member("admin");
    const discordUserId = uniqueDiscordSnowflake();
    const guildId = provider.guild(discordUserId);
    const startedAt = now();
    mockNow(startedAt);
    const attempt = await startOauth(owner);
    mockNow(startedAt + 300_000);
    const landing = await callback({
      code: provider.consent({ discordUserId, guildId, install: true }),
      state: attempt.state,
      guild_id: guildId,
    });
    mockNow(startedAt + 601_000);

    const approved = await approveOauth(
      owner,
      attempt.state,
      landing.approvalProof ?? "",
    );
    const completed = await completeOauth(owner, attempt);

    expect(landing.status).toBe("pending");
    expect([approved, completed.status]).toStrictEqual([400, 400]);
    await expect(readStatus(owner)).resolves.toMatchObject({
      isConnected: false,
    });
    expect(provider.welcomes()).toHaveLength(0);
  });
});
