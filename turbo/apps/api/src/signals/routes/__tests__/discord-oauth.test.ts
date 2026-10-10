import { randomBytes, randomUUID } from "node:crypto";
import { describe, expect, it, onTestFinished } from "vitest";
import { trace } from "@opentelemetry/api";
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { http, HttpResponse } from "msw";
import { z } from "zod";
import { discordOauthContract } from "@okouai/api-contracts/contracts/discord-oauth";
import { integrationsDiscordContract } from "@okouai/api-contracts/contracts/integrations-discord";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp, setupRawAppRequest } from "../../../__tests__/test-helpers";
import { mockEnv } from "../../../lib/env";
import { mockNow, now } from "../../../lib/time";
import { server } from "../../../mocks/server";
import { createDeferredPromise, settleIncludingAbort } from "../../utils";
import { discordOauthRoutes } from "../discord-oauth";
import { integrationsDiscordRoutes } from "../integrations-discord";
import { updateFeatureSwitchesForUser } from "./helpers/feature-switches";

const context = testContext();
const routes = Object.freeze([
  ...discordOauthRoutes,
  ...integrationsDiscordRoutes,
]);
const headers = Object.freeze({ authorization: "Bearer clerk-session" });
const API = "https://discord.com/api/v10";
function sameSecret(a: string | null, b: string): boolean {
  return a === b;
}
function hasSecret(value: string, secrets: readonly string[]): boolean {
  return secrets.some((secret) => {
    return value.includes(secret);
  });
}
function snowflake(): string {
  return (
    1_000_000_000_000_000_000n +
    (BigInt(`0x${randomBytes(8).toString("hex")}`) % 1_000_000_000_000_000_000n)
  ).toString();
}
interface Actor {
  userId: string;
  orgId: string;
  orgRole: "org:admin" | "org:member";
}
interface Grant {
  discordUserId: string;
  guildId: string;
  scopes: string[];
  tokenScopes?: string;
  audience?: string;
  authorizationUserId?: string;
  noGuildProof?: boolean;
  proofGuildId?: string;
}
function fixture() {
  const botId = snowflake();
  const guildId = snowflake();
  const discordUserId = snowflake();
  const dmId = snowflake();
  const actors: Actor[] = [];
  const grants = new Map<string, Grant>();
  const messages: string[] = [];
  const provider = {
    botMissing: false,
    tokenFailure: false,
    botApplicationId: botId,
    page: undefined as
      | readonly {
          id: string;
          name: string;
          owner: boolean;
          permissions: string;
        }[]
      | undefined,
    dmRecipient: discordUserId,
  };
  mockEnv("DISCORD_APPLICATION_ID", botId);
  mockEnv("DISCORD_BOT_TOKEN", "test-discord-bot");
  mockEnv("DISCORD_OAUTH_CLIENT_SECRET", "test-discord-client-secret");
  mockEnv("DISCORD_PUBLIC_KEY", "a".repeat(64));
  mockEnv("DISCORD_GATEWAY_SECRET", "discord-test-gateway-secret-32-bytes");
  mockEnv("APP_URL", "https://app.okou.ai");
  context.mocks.clerk.organizations.getOrganizationMembershipList.mockImplementation(
    (input) => {
      const args = z
        .object({
          organizationId: z.string(),
          userId: z.array(z.string()).optional(),
        })
        .parse(input);
      const found = actors.filter((actor) => {
        return (
          actor.orgId === args.organizationId &&
          (!args.userId || args.userId.includes(actor.userId))
        );
      });
      return Promise.resolve({
        data: found.map((actor) => {
          return {
            id: `membership_${actor.userId}`,
            publicUserData: { userId: actor.userId },
            role: actor.orgRole,
            organization: { id: actor.orgId, name: "OAuth workspace" },
          };
        }),
        totalCount: found.length,
      });
    },
  );
  function bearer(request: Request): Grant {
    const token = request.headers.get("authorization")?.replace("Bearer ", "");
    const grant = token ? grants.get(token) : undefined;
    if (!grant) {
      throw new Error("Unexpected external OAuth grant");
    }
    return grant;
  }
  function user(id: string, bot = false) {
    return { id, username: bot ? "Okou" : "member", bot };
  }
  server.use(
    http.get(`${API}/applications/@me`, () => {
      return HttpResponse.json({ id: provider.botApplicationId, flags: 0 });
    }),
    http.post(`${API}/oauth2/token`, async ({ request }) => {
      if (provider.tokenFailure) {
        return HttpResponse.json(
          {
            error: "invalid_grant",
            error_description: "secret-provider-detail",
          },
          { status: 400 },
        );
      }
      const body = new URLSearchParams(await request.text());
      expect(request.headers.get("content-type")).toBe(
        "application/x-www-form-urlencoded",
      );
      expect(body.get("grant_type")).toBe("authorization_code");
      expect(body.get("client_id")).toBe(botId);
      expect(body.get("client_secret")).toBe("test-discord-client-secret");
      expect(body.get("redirect_uri")).toMatch(
        /\/api\/integrations\/discord\/oauth\/callback$/u,
      );
      const code = body.get("code");
      const grant = code ? grants.get(code) : undefined;
      if (!grant || !code) {
        return HttpResponse.json({}, { status: 400 });
      }
      return HttpResponse.json({
        access_token: code,
        token_type: "Bearer",
        expires_in: 600,
        scope: grant.tokenScopes ?? grant.scopes.join(" "),
        ...(!grant.noGuildProof
          ? {
              guild: {
                id: grant.proofGuildId ?? grant.guildId,
                name: "OAuth guild",
              },
            }
          : {}),
      });
    }),
    http.get(`${API}/oauth2/@me`, ({ request }) => {
      const grant = bearer(request);
      return HttpResponse.json({
        application: { id: grant.audience ?? botId },
        scopes: grant.scopes,
        expires: new Date(now() + 600_000).toISOString(),
        user: user(grant.authorizationUserId ?? grant.discordUserId),
      });
    }),
    http.get(`${API}/oauth2/applications/@me`, () => {
      return HttpResponse.json({
        id: provider.botApplicationId,
        bot: user(botId, true),
      });
    }),
    http.get(`${API}/users/@me`, ({ request }) => {
      return HttpResponse.json(
        request.headers.get("authorization") === "Bot test-discord-bot"
          ? user(botId, true)
          : user(bearer(request).discordUserId),
      );
    }),
    http.get(`${API}/users/@me/guilds`, ({ request }) => {
      const grant = bearer(request);
      const url = new URL(request.url);
      const page = provider.page;
      if (page && url.searchParams.get("after") === "0") {
        return HttpResponse.json(page);
      }
      return HttpResponse.json([
        {
          id: grant.guildId,
          name: "OAuth guild",
          owner: true,
          permissions: "32",
        },
      ]);
    }),
    http.get(`${API}/guilds/:guildId`, ({ params }) => {
      return provider.botMissing
        ? HttpResponse.json({}, { status: 404 })
        : HttpResponse.json({
            id: params.guildId,
            name: "OAuth guild",
            owner_id: discordUserId,
          });
    }),
    http.get(`${API}/guilds/:guildId/members/:userId`, ({ params }) => {
      return HttpResponse.json({
        user: user(String(params.userId), params.userId === botId),
        roles: [],
      });
    }),
    http.get(`${API}/guilds/:guildId/roles`, ({ params }) => {
      return HttpResponse.json([
        { id: params.guildId, name: "@everyone", permissions: "32" },
      ]);
    }),
    http.post(`${API}/users/@me/channels`, async ({ request }) => {
      const body = z
        .object({ recipient_id: z.string() })
        .parse(await request.json());
      provider.dmRecipient = body.recipient_id;
      return HttpResponse.json({
        id: dmId,
        type: 1,
        recipients: [user(body.recipient_id)],
      });
    }),
    http.get(`${API}/channels/${dmId}`, () => {
      return HttpResponse.json({
        id: dmId,
        type: 1,
        recipients: [user(provider.dmRecipient)],
      });
    }),
    http.post(`${API}/channels/${dmId}/messages`, async ({ request }) => {
      const body = z
        .object({
          content: z.string(),
          allowed_mentions: z.object({ parse: z.array(z.string()) }),
          nonce: z.string(),
          enforce_nonce: z.boolean(),
        })
        .parse(await request.json());
      expect(body.allowed_mentions.parse).toStrictEqual([]);
      expect(body.enforce_nonce).toBeTruthy();
      messages.push(body.content);
      return HttpResponse.json({
        id: snowflake(),
        channel_id: dmId,
        content: body.content,
        author: user(botId, true),
        timestamp: new Date(now()).toISOString(),
        attachments: [],
      });
    }),
  );
  async function actor(
    orgId = `org_${randomUUID()}`,
    orgRole: Actor["orgRole"] = "org:admin",
    userId = `user_${randomUUID()}`,
  ) {
    const result = { userId, orgId, orgRole };
    actors.push(result);
    await updateFeatureSwitchesForUser(context, result, {
      [FeatureSwitchKey.DiscordIntegration]: true,
    });
    return result;
  }
  return {
    botId,
    guildId,
    discordUserId,
    actors,
    grants,
    messages,
    provider,
    actor,
  };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
function actorHeaders(actor: Actor) {
  return {
    authorization: `Bearer oauth-test.${Buffer.from(JSON.stringify(actor)).toString("base64url")}`,
  };
}
function authenticate(actor: Actor) {
  context.mocks.clerk.authenticateRequest.mockImplementation((input) => {
    const request = z.instanceof(Request).parse(input);
    const encoded = request.headers
      .get("authorization")
      ?.split("Bearer oauth-test.")[1];
    const current = encoded
      ? z
          .object({
            userId: z.string(),
            orgId: z.string(),
            orgRole: z.enum(["org:admin", "org:member"]),
          })
          .parse(JSON.parse(Buffer.from(encoded, "base64url").toString()))
      : actor;
    return Promise.resolve({
      isAuthenticated: true,
      toAuth: () => {
        return current;
      },
    });
  });
}
function clients() {
  return setupApp({ context, routes });
}
async function status(actor: Actor) {
  authenticate(actor);
  return (
    await accept(
      clients()(integrationsDiscordContract).getStatus({ headers }),
      [200],
    )
  ).body;
}
async function start(
  actor: Actor,
  flow: "install" | "connect",
  guildId?: string,
) {
  authenticate(actor);
  const response = await accept(
    clients()(discordOauthContract).start({
      headers: actorHeaders(actor),
      body: { flow, ...(guildId ? { guildId } : {}) },
    }),
    [200],
  );
  const url = new URL(response.body.authorizationUrl);
  const state = url.searchParams.get("state");
  if (!state) {
    throw new Error("Expected bounded OAuth state");
  }
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(response.headers.get("set-cookie")).toBeNull();
  expect(sameSecret(state, response.body.completionToken)).toBeFalsy();
  expect(BigInt(url.searchParams.get("permissions") ?? "0") & 8n).toBe(0n);
  return { state, completionToken: response.body.completionToken, url, actor };
}
type Started = Awaited<ReturnType<typeof start>>;
async function callback(
  started: Started,
  query: {
    code?: string;
    error?: string;
    state?: string;
    guild_id?: string;
  } = {},
) {
  const result = await accept(
    clients()(discordOauthContract).callback({
      query: { state: started.state, ...query },
    }),
    [307],
  );
  const location = result.headers.get("location");
  if (!location) {
    throw new Error("Expected fixed works redirect");
  }
  const url = new URL(location);
  expect(url.origin + url.pathname).toBe("https://app.okou.ai/works");
  expect(result.headers.get("cache-control")).toBe("no-store");
  expect(result.headers.get("referrer-policy")).toBe("no-referrer");
  expect(hasSecret(location, [started.completionToken])).toBeFalsy();
  return url;
}
async function verified(
  f: Fixture,
  started: Started,
  options: Partial<Grant> = {},
) {
  const code = randomUUID();
  const grant = {
    discordUserId: f.discordUserId,
    guildId: f.guildId,
    scopes: (started.url.searchParams.get("scope") ?? "").split(" "),
    ...options,
  };
  f.grants.set(code, grant);
  return await callback(started, { code, guild_id: grant.guildId });
}
function approvalProof(started: Started, landing: URL): string {
  const fragment = new URLSearchParams(landing.hash.slice(1));
  expect(fragment.get("discord_oauth")).toBe("approve");
  expect(sameSecret(fragment.get("state"), started.state)).toBeTruthy();
  const proof = fragment.get("approval_proof");
  if (!proof || !/^[A-Za-z0-9_-]{43}$/u.test(proof)) {
    throw new Error("Expected bounded independent consent proof");
  }
  expect(sameSecret(proof, started.completionToken)).toBeFalsy();
  return proof;
}
async function approve(
  started: Started,
  landing: URL,
  actor = started.actor,
  proof = approvalProof(started, landing),
) {
  authenticate(actor);
  return await accept(
    clients()(discordOauthContract).approve({
      headers: actorHeaders(actor),
      body: { state: started.state, approvalProof: proof },
    }),
    [200, 400, 401, 403, 404, 409, 503],
  );
}
async function complete(
  started: Started,
  actor = started.actor,
  token = started.completionToken,
) {
  authenticate(actor);
  return await accept(
    clients()(discordOauthContract).complete({
      headers: actorHeaders(actor),
      body: { state: started.state, completionToken: token },
    }),
    [200, 400, 401, 403, 404, 409, 503],
  );
}
async function finish(
  f: Fixture,
  started: Started,
  options: Partial<Grant> = {},
) {
  const landing = await verified(f, started, options);
  if (landing.searchParams.get("discord") !== "pending") {
    return {
      status: "error" as const,
      error: landing.searchParams.get("discord_error"),
      httpStatus: 307,
    };
  }
  const approved = await approve(started, landing);
  if (approved.status !== 200) {
    return {
      status: "error" as const,
      error: approved.body.error.code.toLowerCase(),
      httpStatus: approved.status,
    };
  }
  const completed = await complete(started);
  return completed.status === 200
    ? { status: completed.body.status, error: null, httpStatus: 200 }
    : {
        status: "error" as const,
        error: completed.body.error.code.toLowerCase(),
        httpStatus: completed.status,
      };
}
async function installed(
  f: Fixture,
  actor: Actor,
  options: Partial<Grant> = {},
) {
  expect(
    (
      await finish(
        f,
        await start(actor, "install", options.guildId ?? f.guildId),
        options,
      )
    ).status,
  ).toBe("installed");
}

describe("Discord product OAuth", () => {
  it("installs the verified bot, connects the admin and welcomes only a newly committed connection", async () => {
    const f = await fixture();
    const admin = await f.actor();
    await expect(status(admin)).resolves.toMatchObject({
      isInstalled: false,
      isConnected: false,
      onboarding: "oauth",
    });
    await installed(f, admin);
    await expect(status(admin)).resolves.toMatchObject({
      isInstalled: true,
      isConnected: true,
      guildId: f.guildId,
      discordUserId: f.discordUserId,
      isAdmin: true,
    });
    expect(f.messages).toHaveLength(1);
    expect(f.messages[0]).toContain("https://app.okou.ai/works");
    await installed(f, admin);
    await status(admin);
    await status(admin);
    expect(f.messages).toHaveLength(1);
  });
  it("installs when Discord returns only user scopes in the token and authorization", async () => {
    const f = fixture();
    const actor = await f.actor();
    const started = await start(actor, "install", f.guildId);
    expect(started.url.searchParams.get("scope")).toBe(
      "bot applications.commands identify guilds",
    );
    await expect(
      finish(f, started, {
        scopes: ["identify", "guilds"],
        tokenScopes: "identify guilds",
      }),
    ).resolves.toMatchObject({ status: "installed", httpStatus: 200 });
    await expect(status(actor)).resolves.toMatchObject({
      isInstalled: true,
      isConnected: true,
      guildId: f.guildId,
      discordUserId: f.discordUserId,
    });
  });
  it("retains a completed personal grant when a later attempt reaps expired opener capabilities", async () => {
    const f = fixture();
    const actor = await f.actor();
    const initial = now();
    const installed = await start(actor, "install", f.guildId);
    expect((await finish(f, installed)).status).toBe("installed");
    const before = await status(actor);
    expect(before.isConnected).toBeTruthy();
    expect(before.dmBindings).toHaveLength(1);
    mockNow(initial + 601_000);
    const pending = await start(actor, "connect", f.guildId);
    const after = await status(actor);
    expect(after.isConnected).toBeTruthy();
    expect(after.dmBindings).toStrictEqual(before.dmBindings);
    expect(after.discordUserId).toBe(f.discordUserId);
    expect((await complete(installed)).status).toBe(400);
    authenticate(actor);
    await accept(
      clients()(integrationsDiscordContract).disconnect({ headers, query: {} }),
      [200],
    );
    expect((await status(actor)).isConnected).toBeFalsy();
    expect((await complete(pending)).status).toBe(400);
    const member = await f.actor(actor.orgId, "org:member");
    expect(
      (await finish(f, await start(member, "connect", f.guildId))).status,
    ).toBe("connected");
    expect((await status(member)).discordUserId).toBe(f.discordUserId);
  });

  it("lets an ordinary current org member connect only their verified Discord identity", async () => {
    const f = await fixture();
    const admin = await f.actor();
    await installed(f, admin);
    const member = await f.actor(admin.orgId, "org:member");
    const memberDiscordId = snowflake();
    const started = await start(member, "connect");
    expect(started.url.searchParams.get("scope")).toBe("identify guilds");
    expect(
      (await finish(f, started, { discordUserId: memberDiscordId })).status,
    ).toBe("connected");
    await expect(status(member)).resolves.toMatchObject({
      isInstalled: true,
      isConnected: true,
      isAdmin: false,
      discordUserId: memberDiscordId,
    });
    expect((await status(admin)).discordUserId).toBe(f.discordUserId);
  });
  it("requires authentication, rejects ordinary-member installs and malformed owner input", async () => {
    const f = await fixture();
    const member = await f.actor(undefined, "org:member");
    authenticate(member);
    await accept(
      clients()(discordOauthContract).start({
        headers,
        body: { flow: "install" },
      }),
      [403],
    );
    const raw = setupRawAppRequest({ context, routes });
    await accept(
      raw("/api/integrations/discord/oauth/start", {
        method: "POST",
        headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify({
          flow: "connect",
          userId: "arbitrary",
          orgId: "arbitrary",
        }),
      }),
      [400],
    );
    await accept(
      raw("/api/integrations/discord/oauth/start", {
        method: "POST",
        headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify({ flow: "install", guildId: "not-a-snowflake" }),
      }),
      [400],
    );
    context.mocks.clerk.authenticateRequest.mockResolvedValue({
      isAuthenticated: false,
      toAuth: () => {
        return {};
      },
    });
    await accept(
      clients()(discordOauthContract).start({
        headers,
        body: { flow: "install" },
      }),
      [401],
    );
    expect((await status(member)).isInstalled).toBeFalsy();
  });
  it("rejects connect before installation and reports missing configuration without inventing defaults", async () => {
    const f = await fixture();
    const actor = await f.actor();
    authenticate(actor);
    await accept(
      clients()(discordOauthContract).start({
        headers,
        body: { flow: "connect" },
      }),
      [404],
    );
    mockEnv("DISCORD_OAUTH_CLIENT_SECRET", undefined);
    const response = await accept(
      clients()(discordOauthContract).start({
        headers,
        body: { flow: "install" },
      }),
      [503],
    );
    expect(response.body.error.code).toBe("DISCORD_NOT_CONFIGURED");
    expect((await status(actor)).isAvailable).toBeTruthy();
  });
  it("rejects a forged well-formed state without consuming the genuine attempt", async () => {
    const f = await fixture();
    const actor = await f.actor();
    const started = await start(actor, "install", f.guildId);
    expect(
      (
        await callback(started, {
          code: "unknown",
          state: randomBytes(32).toString("base64url"),
        })
      ).searchParams.get("discord_error"),
    ).toBe("invalid_state");
    expect((await status(actor)).isInstalled).toBeFalsy();
    expect((await finish(f, started)).status).toBe("installed");
  });
  it.each([
    "malformed-state",
    "oversize-code",
    "oversize-error",
    "overflow-guild",
  ])(
    "bounds callback %s before handling without consuming genuine state",
    async (variant) => {
      const f = await fixture();
      const actor = await f.actor();
      const started = await start(actor, "install", f.guildId);
      const query = {
        state: started.state,
        code: "unknown",
        ...(variant === "malformed-state" ? { state: "malformed" } : {}),
        ...(variant === "oversize-code" ? { code: "x".repeat(2049) } : {}),
        ...(variant === "oversize-error" ? { error: "x".repeat(129) } : {}),
        ...(variant === "overflow-guild"
          ? { guild_id: "18446744073709551616" }
          : {}),
      };
      await accept(clients()(discordOauthContract).callback({ query }), [400]);
      expect((await finish(f, started)).status).toBe("installed");
    },
  );
  it("rejects expired and reused state, and cancellation is one-use with no provider text", async () => {
    const f = await fixture();
    const actor = await f.actor();
    const initial = now();
    mockNow(initial);
    const expired = await start(actor, "install", f.guildId);
    mockNow(initial + 601_000);
    expect(
      (await callback(expired, { code: "expired" })).searchParams.get(
        "discord_error",
      ),
    ).toBe("invalid_state");
    const cancelled = await start(actor, "install", f.guildId);
    const url = await callback(cancelled, {
      error: "access_denied:secret-provider-detail",
    });
    expect(url.searchParams.get("discord_error")).toBe("cancelled");
    expect(url.toString()).not.toContain("secret-provider-detail");
    expect(
      (await callback(cancelled, { code: "replayed" })).searchParams.get(
        "discord_error",
      ),
    ).toBe("invalid_state");
    expect((await status(actor)).isInstalled).toBeFalsy();
    expect(f.messages).toStrictEqual([]);
    const good = await start(actor, "install", f.guildId);
    await finish(f, good);
    expect(
      (await callback(good, { code: "replayed-success" })).searchParams.get(
        "discord_error",
      ),
    ).toBe("invalid_state");
    expect(f.messages).toHaveLength(1);
  });
  it.each([
    "missing-token-identify-scope",
    "missing-token-guilds-scope",
    "missing-authorization-identify-scope",
    "missing-authorization-guilds-scope",
    "audience",
    "identity",
    "missing-guild-proof",
    "selected-guild",
    "bot-audience",
    "bot-missing",
    "provider-error",
  ])("fails closed for %s and leaves status unchanged", async (variant) => {
    const f = await fixture();
    const actor = await f.actor();
    const started = await start(actor, "install", f.guildId);
    const options: Partial<Grant> = { scopes: ["identify", "guilds"] };
    if (variant === "missing-token-identify-scope") {
      options.tokenScopes = "guilds";
    }
    if (variant === "missing-token-guilds-scope") {
      options.tokenScopes = "identify";
    }
    if (variant === "missing-authorization-identify-scope") {
      options.scopes = ["guilds"];
      options.tokenScopes = "identify guilds";
    }
    if (variant === "missing-authorization-guilds-scope") {
      options.scopes = ["identify"];
      options.tokenScopes = "identify guilds";
    }
    if (variant === "audience") {
      options.audience = snowflake();
    }
    if (variant === "identity") {
      options.authorizationUserId = snowflake();
    }
    if (variant === "missing-guild-proof") {
      options.noGuildProof = true;
    }
    if (variant === "selected-guild") {
      options.proofGuildId = snowflake();
    }
    if (variant === "bot-audience") {
      f.provider.botApplicationId = snowflake();
    }
    if (variant === "bot-missing") {
      f.provider.botMissing = true;
    }
    if (variant === "provider-error") {
      f.provider.tokenFailure = true;
    }
    const result = await finish(f, started, options);
    expect(result.status).toBe("error");
    expect(JSON.stringify(result)).not.toContain("secret-provider-detail");
    expect((await status(actor)).isInstalled).toBeFalsy();
    expect(f.messages).toStrictEqual([]);
  });
  it("rejects a callback guild hint that disagrees with verified token guild evidence", async () => {
    const f = await fixture();
    const actor = await f.actor();
    const started = await start(actor, "install", f.guildId);
    const code = randomUUID();
    f.grants.set(code, {
      discordUserId: f.discordUserId,
      guildId: f.guildId,
      scopes: ["bot", "applications.commands", "identify", "guilds"],
    });
    expect(
      (
        await callback(started, { code, guild_id: snowflake() })
      ).searchParams.get("discord_error"),
    ).toBe("guild_unverified");
    expect((await status(actor)).isInstalled).toBeFalsy();
  });
  it.each(["revoked-member", "downgraded-admin", "switch-off"])(
    "revalidates %s while authorization is open",
    async (variant) => {
      const f = await fixture();
      const actor = await f.actor();
      const started = await start(actor, "install", f.guildId);
      if (variant === "revoked-member") {
        f.actors.splice(0);
      }
      if (variant === "downgraded-admin") {
        actor.orgRole = "org:member";
      }
      if (variant === "switch-off") {
        await updateFeatureSwitchesForUser(context, actor, {
          [FeatureSwitchKey.DiscordIntegration]: false,
        });
      }
      const result = await finish(f, started);
      expect(result.status).toBe("error");
      expect((await status(actor)).isInstalled).toBeFalsy();
      expect(f.messages).toStrictEqual([]);
    },
  );
  it("revalidates current membership again after slow provider work before callback writes", async () => {
    const f = await fixture();
    const actor = await f.actor();
    const started = await start(actor, "install", f.guildId);
    server.use(
      http.get(`${API}/guilds/:guildId/members/:userId`, ({ params }) => {
        f.actors.splice(0);
        return HttpResponse.json({
          user: { id: params.userId, username: "member" },
          roles: [],
        });
      }),
    );
    expect((await finish(f, started)).error).toBe("forbidden");
    expect((await status(actor)).isInstalled).toBeFalsy();
    expect(f.messages).toStrictEqual([]);
  });
  it("paginates past 200 eligible guilds rather than silently truncating membership", async () => {
    const f = await fixture();
    const actor = await f.actor();
    f.provider.page = Array.from({ length: 200 }, (_, index) => {
      return {
        id: String(1000 + index),
        name: "Other guild",
        owner: false,
        permissions: "0",
      };
    });
    await installed(f, actor);
    expect((await status(actor)).guildId).toBe(f.guildId);
  });
  it("never moves an occupied guild into another org or replaces a workspace's server", async () => {
    const f = await fixture();
    const owner = await f.actor();
    await installed(f, owner);
    const other = await f.actor();
    expect(
      (
        await finish(f, await start(other, "install", f.guildId), {
          discordUserId: snowflake(),
        })
      ).error,
    ).toBe("conflict");
    expect((await status(other)).isInstalled).toBeFalsy();
    expect((await status(owner)).guildId).toBe(f.guildId);
    authenticate(owner);
    await accept(
      clients()(discordOauthContract).start({
        headers,
        body: { flow: "install", guildId: snowflake() },
      }),
      [409],
    );
    expect(f.messages).toHaveLength(1);
  });
  it("rejects stealing a Discord identity in the same guild and across guilds", async () => {
    const f = await fixture();
    const owner = await f.actor();
    await installed(f, owner);
    const member = await f.actor(owner.orgId, "org:member");
    expect((await finish(f, await start(member, "connect"))).error).toBe(
      "conflict",
    );
    expect((await status(member)).isConnected).toBeFalsy();
    const otherOrg = await f.actor();
    const otherGuild = snowflake();
    expect(
      (
        await finish(f, await start(otherOrg, "install", otherGuild), {
          guildId: otherGuild,
        })
      ).error,
    ).toBe("conflict");
    expect((await status(otherOrg)).isInstalled).toBeFalsy();
    expect((await status(owner)).discordUserId).toBe(f.discordUserId);
    expect(f.messages).toHaveLength(1);
  });
  it("requires disconnect before changing a user's Discord identity and releases unused ownership", async () => {
    const f = await fixture();
    const owner = await f.actor();
    await installed(f, owner);
    expect(
      (
        await finish(f, await start(owner, "connect"), {
          discordUserId: snowflake(),
        })
      ).error,
    ).toBe("conflict");
    authenticate(owner);
    await accept(
      clients()(integrationsDiscordContract).disconnect({ headers, query: {} }),
      [200],
    );
    expect((await status(owner)).isConnected).toBeFalsy();
    const member = await f.actor(owner.orgId, "org:member");
    expect((await finish(f, await start(member, "connect"))).status).toBe(
      "connected",
    );
    expect((await status(member)).discordUserId).toBe(f.discordUserId);
  });
  it("does not reserve a replacement Discord identity after an occupied-user binding fails", async () => {
    const f = await fixture();
    const owner = await f.actor();
    await installed(f, owner);
    const replacement = snowflake();
    const started = await start(owner, "connect");
    const landing = await verified(f, started, { discordUserId: replacement });
    expect((await approve(started, landing)).status).toBe(200);
    expect((await complete(started)).status).toBe(409);
    expect((await complete(started)).status).toBe(400);
    expect((await status(owner)).discordUserId).toBe(f.discordUserId);
    const otherOwner = await f.actor();
    const otherGuild = snowflake();
    await installed(f, otherOwner, {
      guildId: otherGuild,
      discordUserId: replacement,
    });
    await expect(status(otherOwner)).resolves.toMatchObject({
      isConnected: true,
      guildId: otherGuild,
      discordUserId: replacement,
    });
    expect((await status(owner)).discordUserId).toBe(f.discordUserId);
    expect(f.messages).toHaveLength(2);
  });
  it("keeps separate attempts correlated to independent consent and completion proofs", async () => {
    const f = await fixture();
    const actor = await f.actor();
    const first = await start(actor, "install", f.guildId);
    const second = await start(actor, "install", f.guildId);
    const firstLanding = await verified(f, first);
    const secondLanding = await verified(f, second);
    expect(
      (
        await approve(
          first,
          firstLanding,
          actor,
          approvalProof(second, secondLanding),
        )
      ).status,
    ).toBe(400);
    expect((await complete(first)).status).toBe(409);
    expect((await approve(first, firstLanding)).status).toBe(200);
    expect((await complete(first, actor, second.completionToken)).status).toBe(
      400,
    );
    expect((await complete(first)).status).toBe(200);
    expect((await approve(second, secondLanding)).status).toBe(200);
    expect((await complete(second)).status).toBe(200);
    expect(f.messages).toHaveLength(1);
  });
  it("allows only one org to win concurrent claims for the same verified guild", async () => {
    const f = await fixture();
    const firstOwner = await f.actor();
    const secondOwner = await f.actor();
    const first = await start(firstOwner, "install", f.guildId);
    const second = await start(secondOwner, "install", f.guildId);
    const results = await Promise.all([
      finish(f, first),
      finish(f, second, { discordUserId: snowflake() }),
    ]);
    expect(
      results
        .map((result) => {
          return result.status;
        })
        .sort(),
    ).toStrictEqual(["error", "installed"]);
    const statuses = [await status(firstOwner), await status(secondOwner)];
    expect(
      statuses.filter((result) => {
        return result.isConnected;
      }),
    ).toHaveLength(1);
    expect(
      statuses.filter((result) => {
        return result.isInstalled;
      }),
    ).toHaveLength(1);
    expect(f.messages).toHaveLength(1);
  });
  it("keeps one guild per workspace when two approved installations race without reserving the losing guild", async () => {
    const f = await fixture();
    const owner = await f.actor();
    const secondGuild = snowflake();
    const cases = [
      { attempt: await start(owner, "install", f.guildId), guildId: f.guildId },
      {
        attempt: await start(owner, "install", secondGuild),
        guildId: secondGuild,
      },
    ];
    const results = await Promise.all(
      cases.map(async ({ attempt, guildId }) => {
        return await finish(f, attempt, { guildId });
      }),
    );
    expect(
      results
        .map((result) => {
          return result.status;
        })
        .sort(),
    ).toStrictEqual(["error", "installed"]);
    const loser =
      cases[
        results.findIndex((result) => {
          return result.status === "error";
        })
      ];
    if (!loser) {
      throw new Error("Expected one conflicting guild installation");
    }
    expect((await complete(loser.attempt)).status).toBe(400);
    const bound = await status(owner);
    expect(bound.isConnected).toBeTruthy();
    expect(bound.guildId).not.toBe(loser.guildId);
    const otherOwner = await f.actor();
    await installed(f, otherOwner, {
      guildId: loser.guildId,
      discordUserId: snowflake(),
    });
    expect((await status(otherOwner)).guildId).toBe(loser.guildId);
    expect((await status(owner)).guildId).toBe(bound.guildId);
    expect(f.messages).toHaveLength(2);
  });
  it("allows only one account to win concurrent Discord identity claims across guilds", async () => {
    const f = await fixture();
    const firstOwner = await f.actor();
    const secondOwner = await f.actor();
    const secondGuild = snowflake();
    const first = await start(firstOwner, "install", f.guildId);
    const second = await start(secondOwner, "install", secondGuild);
    const results = await Promise.all([
      finish(f, first),
      finish(f, second, { guildId: secondGuild }),
    ]);
    expect(
      results
        .map((result) => {
          return result.status;
        })
        .sort(),
    ).toStrictEqual(["error", "installed"]);
    const statuses = [await status(firstOwner), await status(secondOwner)];
    expect(
      statuses.filter((result) => {
        return result.isConnected;
      }),
    ).toHaveLength(1);
    expect(
      statuses.filter((result) => {
        return result.isInstalled;
      }),
    ).toHaveLength(1);
    expect(f.messages).toHaveLength(1);
  });
  it("does not reserve the losing identity when two verified senders race for one workspace member", async () => {
    const f = await fixture();
    const admin = await f.actor();
    await installed(f, admin);
    const member = await f.actor(admin.orgId, "org:member");
    const cases = [
      { attempt: await start(member, "connect"), sender: snowflake() },
      { attempt: await start(member, "connect"), sender: snowflake() },
    ];
    const results = await Promise.all(
      cases.map(async ({ attempt, sender }) => {
        return await finish(f, attempt, { discordUserId: sender });
      }),
    );
    expect(
      results
        .map((result) => {
          return result.status;
        })
        .sort(),
    ).toStrictEqual(["connected", "error"]);
    const losingIndex = results.findIndex((result) => {
      return result.status === "error";
    });
    const loser = cases[losingIndex];
    if (!loser) {
      throw new Error("Expected one conflicting verified sender");
    }
    expect((await complete(loser.attempt)).status).toBe(400);
    const bound = await status(member);
    expect(bound.isConnected).toBeTruthy();
    expect(
      cases.map(({ sender }) => {
        return sender;
      }),
    ).toContain(bound.discordUserId);
    expect(bound.discordUserId).not.toBe(loser.sender);
    const otherOwner = await f.actor();
    const otherGuild = snowflake();
    await installed(f, otherOwner, {
      guildId: otherGuild,
      discordUserId: loser.sender,
    });
    expect((await status(otherOwner)).discordUserId).toBe(loser.sender);
    expect((await status(member)).discordUserId).toBe(bound.discordUserId);
    expect(f.messages).toHaveLength(3);
  });
  it("commits one connection and welcome for simultaneous legitimate same-owner attempts", async () => {
    const f = await fixture();
    const actor = await f.actor();
    const first = await start(actor, "install", f.guildId);
    const second = await start(actor, "install", f.guildId);
    const results = await Promise.all([finish(f, first), finish(f, second)]);
    expect(
      results.map((result) => {
        return result.status;
      }),
    ).toStrictEqual(["installed", "installed"]);
    expect((await status(actor)).isConnected).toBeTruthy();
    expect(f.messages).toHaveLength(1);
  });
  it("rejects a concurrent replay of the same provider state before a second write or welcome", async () => {
    const f = await fixture();
    const actor = await f.actor();
    const started = await start(actor, "install", f.guildId);
    const results = await Promise.all([finish(f, started), finish(f, started)]);
    expect(
      results
        .map((result) => {
          return result.status;
        })
        .sort(),
    ).toStrictEqual(["error", "installed"]);
    expect((await status(actor)).isConnected).toBeTruthy();
    expect(f.messages).toHaveLength(1);
  });
  it("does not revive an uninstalled guild from an already-open member connect attempt", async () => {
    const f = await fixture();
    const actor = await f.actor();
    await installed(f, actor);
    const started = await start(actor, "connect");
    authenticate(actor);
    await accept(
      clients()(integrationsDiscordContract).disconnect({
        headers,
        query: { action: "uninstall" },
      }),
      [200],
    );
    expect((await finish(f, started)).error).toBe("invalid_state");
    await expect(status(actor)).resolves.toMatchObject({
      isInstalled: false,
      isConnected: false,
    });
    expect(f.messages).toHaveLength(1);
  });
  it("cancels a real request during provider verification without binding or welcoming", async () => {
    const f = await fixture();
    const actor = await f.actor();
    const started = await start(actor, "install", f.guildId);
    const entered = createDeferredPromise<void>(context.signal);
    const release = createDeferredPromise<void>(context.signal);
    server.use(
      http.get(`${API}/oauth2/@me`, async () => {
        entered.resolve();
        await release.promise;
        return HttpResponse.json({
          application: { id: f.botId },
          scopes: ["bot", "applications.commands", "identify", "guilds"],
          expires: new Date(now() + 60_000).toISOString(),
          user: { id: f.discordUserId, username: "member" },
        });
      }),
    );
    const code = randomUUID();
    f.grants.set(code, {
      guildId: f.guildId,
      discordUserId: f.discordUserId,
      scopes: ["bot", "applications.commands", "identify", "guilds"],
    });
    const controller = new AbortController();
    const request = clients()(discordOauthContract).callback({
      query: { code, state: started.state, guild_id: f.guildId },
      fetchOptions: { signal: controller.signal },
    });
    const settled = settleIncludingAbort(() => {
      return request;
    });
    await entered.promise;
    controller.abort(new DOMException("Cancelled by browser", "AbortError"));
    release.resolve();
    const result = await settled;
    expect(result.ok).toBeFalsy();
    expect((await status(actor)).isInstalled).toBeFalsy();
    expect(f.messages).toStrictEqual([]);
  });
  it("authorizes the exact DM recipient independently before a welcome, without undoing connection", async () => {
    const f = await fixture();
    const actor = await f.actor();
    server.use(
      http.get(`${API}/channels/:channelId`, ({ params }) => {
        return HttpResponse.json({
          id: params.channelId,
          type: 1,
          recipients: [{ id: snowflake(), username: "other-user" }],
        });
      }),
    );
    await installed(f, actor);
    expect((await status(actor)).isConnected).toBeTruthy();
    expect(f.messages).toStrictEqual([]);
    await installed(f, actor);
    expect(f.messages).toStrictEqual([]);
  });

  it("neither the anonymous callback nor approval binds; only approved owner completion binds once", async () => {
    const f = await fixture();
    const actor = await f.actor();
    const started = await start(actor, "install", f.guildId);
    expect((await complete(started)).status).toBe(409);
    const landing = await verified(f, started);
    expect(landing.searchParams.get("discord")).toBe("pending");
    await expect(status(actor)).resolves.toMatchObject({
      isInstalled: false,
      isConnected: false,
    });
    expect(f.messages).toStrictEqual([]);
    expect((await complete(started)).status).toBe(409);
    expect((await approve(started, landing)).status).toBe(200);
    await expect(status(actor)).resolves.toMatchObject({
      isInstalled: false,
      isConnected: false,
    });
    expect(f.messages).toStrictEqual([]);
    expect((await approve(started, landing)).status).toBe(400);
    expect((await complete(started)).status).toBe(200);
    expect((await complete(started)).status).toBe(400);
    expect((await status(actor)).isConnected).toBeTruthy();
    expect(f.messages).toHaveLength(1);
  });
  it.each(["different-account", "different-org"])(
    "rejects attacker-start/victim-consent %s without granting the attacker access",
    async (variant) => {
      const f = await fixture();
      const attacker = await f.actor();
      const victim = await f.actor(
        variant === "different-account" ? attacker.orgId : undefined,
        "org:admin",
        variant === "different-org" ? attacker.userId : undefined,
      );
      const started = await start(attacker, "install", f.guildId);
      const landing = await verified(f, started, {
        discordUserId: snowflake(),
      });
      expect((await approve(started, landing, victim)).status).toBe(403);
      expect((await complete(started)).status).toBe(409);
      expect((await complete(started, victim)).status).toBe(403);
      expect((await status(attacker)).isConnected).toBeFalsy();
      expect((await status(victim)).isConnected).toBeFalsy();
      expect(f.messages).toStrictEqual([]);
    },
  );
  it.each([
    "member-before-approve",
    "admin-before-approve",
    "switch-before-approve",
    "member-before-complete",
    "admin-before-complete",
    "switch-before-complete",
  ])("revalidates %s after provider verification", async (variant) => {
    const f = await fixture();
    const actor = await f.actor();
    const started = await start(actor, "install", f.guildId);
    const landing = await verified(f, started);
    if (variant.endsWith("before-complete")) {
      expect((await approve(started, landing)).status).toBe(200);
    }
    if (variant.startsWith("member")) {
      f.actors.splice(0);
    }
    if (variant.startsWith("admin")) {
      actor.orgRole = "org:member";
    }
    if (variant.startsWith("switch")) {
      await updateFeatureSwitchesForUser(context, actor, {
        [FeatureSwitchKey.DiscordIntegration]: false,
      });
    }
    const result = variant.endsWith("before-complete")
      ? await complete(started)
      : await approve(started, landing);
    expect(result.status).toBe(403);
    expect((await status(actor)).isInstalled).toBeFalsy();
    expect(f.messages).toStrictEqual([]);
  });
  it.each(["bot-gone", "sender-gone", "bot-replaced", "guild-admin-revoked"])(
    "rechecks live %s after approval before any write",
    async (variant) => {
      const f = await fixture();
      const actor = await f.actor();
      const started = await start(actor, "install", f.guildId);
      const landing = await verified(f, started);
      expect((await approve(started, landing)).status).toBe(200);
      if (variant === "bot-gone") {
        f.provider.botMissing = true;
      }
      if (variant === "bot-replaced") {
        f.provider.botApplicationId = snowflake();
      }
      if (variant === "sender-gone") {
        server.use(
          http.get(`${API}/guilds/:guildId/members/${f.discordUserId}`, () => {
            return HttpResponse.json({}, { status: 404 });
          }),
        );
      }
      if (variant === "guild-admin-revoked") {
        server.use(
          http.get(`${API}/guilds/:guildId`, ({ params }) => {
            return HttpResponse.json({
              id: params.guildId,
              name: "OAuth guild",
              owner_id: snowflake(),
            });
          }),
          http.get(`${API}/guilds/:guildId/roles`, ({ params }) => {
            return HttpResponse.json([
              { id: params.guildId, name: "@everyone", permissions: "0" },
            ]);
          }),
        );
      }
      expect((await complete(started)).status).toBe(503);
      expect((await status(actor)).isInstalled).toBeFalsy();
      expect(f.messages).toStrictEqual([]);
    },
  );
  it("rechecks Clerk authorization after slow native provider work during completion", async () => {
    const f = await fixture();
    const actor = await f.actor();
    const started = await start(actor, "install", f.guildId);
    const landing = await verified(f, started);
    expect((await approve(started, landing)).status).toBe(200);
    server.use(
      http.get(`${API}/guilds/:guildId/members/:userId`, ({ params }) => {
        f.actors.splice(0);
        return HttpResponse.json({
          user: {
            id: params.userId,
            username: "member",
            bot: params.userId === f.botId,
          },
          roles: [],
        });
      }),
    );
    expect((await complete(started)).status).toBe(403);
    expect((await status(actor)).isInstalled).toBeFalsy();
    expect(f.messages).toStrictEqual([]);
  });
  it.each(["verified", "approved"])(
    "does not extend original expiry for %s evidence",
    async (phase) => {
      const f = await fixture();
      const actor = await f.actor();
      const initial = now();
      mockNow(initial);
      const started = await start(actor, "install", f.guildId);
      const landing = await verified(f, started);
      if (phase === "approved") {
        expect((await approve(started, landing)).status).toBe(200);
      }
      mockNow(initial + 600_001);
      expect((await approve(started, landing)).status).toBe(400);
      expect((await complete(started)).status).toBe(400);
      expect((await status(actor)).isInstalled).toBeFalsy();
      expect(f.messages).toStrictEqual([]);
    },
  );
  it("atomically consumes concurrent approvals and concurrent completions once", async () => {
    const f = await fixture();
    const actor = await f.actor();
    const started = await start(actor, "install", f.guildId);
    const landing = await verified(f, started);
    const approvals = await Promise.all([
      approve(started, landing),
      approve(started, landing),
    ]);
    expect(
      approvals
        .map((result) => {
          return result.status;
        })
        .sort(),
    ).toStrictEqual([200, 400]);
    const completed = await Promise.all([complete(started), complete(started)]);
    expect(
      completed
        .map((result) => {
          return result.status;
        })
        .sort(),
    ).toStrictEqual([200, 400]);
    expect((await status(actor)).isConnected).toBeTruthy();
    expect(f.messages).toHaveLength(1);
  });
  it("does not grant access from query markers, lost opener proof, malformed capabilities or uint64 overflow", async () => {
    const f = await fixture();
    const actor = await f.actor();
    const started = await start(actor, "install", f.guildId);
    const landing = await verified(f, started);
    expect(
      (await approve(started, landing, actor, started.completionToken)).status,
    ).toBe(400);
    expect(
      (await complete(started, actor, randomBytes(32).toString("base64url")))
        .status,
    ).toBe(400);
    const raw = setupRawAppRequest({ context, routes });
    for (const suffix of ["approve", "complete"]) {
      await accept(
        raw(`/api/integrations/discord/oauth/${suffix}?discord=installed`, {
          method: "POST",
          headers: {
            ...actorHeaders(actor),
            "content-type": "application/json",
          },
          body: JSON.stringify({ state: started.state }),
        }),
        [400],
      );
      await accept(
        raw(`/api/integrations/discord/oauth/${suffix}`, {
          method: "POST",
          headers: {
            ...actorHeaders(actor),
            "content-type": "application/json",
          },
          body: JSON.stringify({
            state: "x".repeat(44),
            ...(suffix === "approve"
              ? { approvalProof: "x".repeat(44) }
              : { completionToken: "x".repeat(44) }),
          }),
        }),
        [400],
      );
    }
    await accept(
      clients()(discordOauthContract).start({
        headers: actorHeaders(actor),
        body: { flow: "install", guildId: "18446744073709551616" },
      }),
      [400],
    );
    expect((await status(actor)).isConnected).toBeFalsy();
    expect(f.messages).toStrictEqual([]);
  });
  it("preserves a same-owner new-guild connection during concurrent last-old-guild disconnect using only public OAuth and provider gates", async () => {
    const f = await fixture();
    const oldOwner = await f.actor();
    await installed(f, oldOwner);
    const secondGuild = snowflake();
    const secondAdmin = await f.actor();
    await installed(f, secondAdmin, {
      guildId: secondGuild,
      discordUserId: snowflake(),
    });
    const sameOwner = await f.actor(
      secondAdmin.orgId,
      "org:member",
      oldOwner.userId,
    );
    for (let execution = 0; execution < 4; execution++) {
      const started = await start(sameOwner, "connect", secondGuild);
      const landing = await verified(f, started, { guildId: secondGuild });
      expect(landing.searchParams.get("discord_error")).toBeNull();
      expect((await approve(started, landing)).status).toBe(200);
      const entered = createDeferredPromise<void>(context.signal);
      const release = createDeferredPromise<void>(context.signal);
      server.use(
        http.get(
          `${API}/guilds/${secondGuild}/members/${f.discordUserId}`,
          async () => {
            if (!entered.settled()) {
              entered.resolve();
            }
            await release.promise;
            return HttpResponse.json({
              user: { id: f.discordUserId, username: "member" },
              roles: [],
            });
          },
        ),
      );
      const completing = complete(started);
      await entered.promise;
      authenticate(oldOwner);
      const disconnecting = accept(
        clients()(integrationsDiscordContract).disconnect({
          headers: actorHeaders(oldOwner),
          query: {},
        }),
        [200],
      );
      release.resolve();
      expect((await completing).status).toBe(200);
      await disconnecting;
      expect((await status(oldOwner)).isConnected).toBeFalsy();
      await expect(status(sameOwner)).resolves.toMatchObject({
        isConnected: true,
        guildId: secondGuild,
        discordUserId: f.discordUserId,
      });
      authenticate(sameOwner);
      await accept(
        clients()(integrationsDiscordContract).disconnect({
          headers: actorHeaders(sameOwner),
          query: {},
        }),
        [200],
      );
      expect((await finish(f, await start(oldOwner, "connect"))).status).toBe(
        "connected",
      );
    }
  });
  it("excludes actual callback query and approval Location from real OTel spans while preserving provider query handling and other request tracing", async () => {
    const f = await fixture();
    const actor = await f.actor();
    const exporter = new InMemorySpanExporter();
    const provider = new BasicTracerProvider({
      spanProcessors: [new SimpleSpanProcessor(exporter)],
    });
    expect(trace.setGlobalTracerProvider(provider)).toBeTruthy();
    onTestFinished(async () => {
      trace.disable();
      await provider.shutdown();
    });
    const started = await start(actor, "install", f.guildId);
    const landing = await verified(f, started);
    expect(landing.searchParams.get("discord")).toBe("pending");
    const proof = approvalProof(started, landing);
    const codes = [...f.grants.keys()];
    expect((await approve(started, landing)).status).toBe(200);
    expect((await complete(started)).status).toBe(200);
    expect((await status(actor)).isConnected).toBeTruthy();
    await provider.forceFlush();
    const spans = exporter.getFinishedSpans();
    expect(
      spans.some((span) => {
        return span.name.includes("/oauth/start");
      }),
    ).toBeTruthy();
    expect(
      spans.some((span) => {
        return span.name.includes("/oauth/callback");
      }),
    ).toBeFalsy();
    const exported = JSON.stringify(
      spans.map((span) => {
        return {
          name: span.name,
          attributes: span.attributes,
          events: span.events,
        };
      }),
    );
    expect(
      hasSecret(exported, [
        started.state,
        started.completionToken,
        proof,
        ...codes,
        landing.toString(),
      ]),
    ).toBeFalsy();
    expect(
      spans.some((span) => {
        return span.attributes["http.response.status_code"] === 200;
      }),
    ).toBeTruthy();
  });
});
