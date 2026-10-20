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
import { featureSwitchesContract } from "@okouai/api-contracts/contracts/feature-switches";
import { integrationsDiscordContract } from "@okouai/api-contracts/contracts/integrations-discord";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp, setupRawAppRequest } from "../../../__tests__/test-helpers";
import { mockEnv } from "../../../lib/env";
import { mockNow, now } from "../../../lib/time";
import { server } from "../../../mocks/server";
import { createDeferredPromise, settleIncludingAbort } from "../../utils";
import { discordOauthRoutes } from "../discord-oauth";
import { featureSwitchesRoutes } from "../feature-switches";
import { integrationsDiscordRoutes } from "../integrations-discord";
import { createAuthOrgAgentsBddApi } from "./helpers/api-bdd-auth-org";
import { updateFeatureSwitchesForUser } from "./helpers/feature-switches";
import { createRouteMocks } from "./helpers/route-test";

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
  const dmChannels = new Map<string, string>();
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
      let channelId = dmChannels.get(body.recipient_id);
      if (!channelId) {
        channelId = snowflake();
        dmChannels.set(body.recipient_id, channelId);
      }
      return HttpResponse.json({
        id: channelId,
        type: 1,
        recipients: [user(body.recipient_id)],
      });
    }),
    http.get(`${API}/channels/:channelId`, ({ params }) => {
      const channelId = String(params.channelId);
      const recipient = [...dmChannels].find(([, id]) => {
        return id === channelId;
      })?.[0];
      return recipient
        ? HttpResponse.json({
            id: channelId,
            type: 1,
            recipients: [user(recipient)],
          })
        : HttpResponse.json({}, { status: 404 });
    }),
    http.post(
      `${API}/channels/:channelId/messages`,
      async ({ request, params }) => {
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
          channel_id: String(params.channelId),
          content: body.content,
          author: user(botId, true),
          timestamp: new Date(now()).toISOString(),
          attachments: [],
        });
      },
    ),
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
  explicitFlow = false,
) {
  authenticate(actor);
  const response = await accept(
    clients()(discordOauthContract).start({
      headers: actorHeaders(actor),
      body: explicitFlow
        ? { flow, ...(guildId ? { guildId } : {}) }
        : flow === "connect" && guildId
          ? { guildId }
          : {},
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
    throw new Error("Expected fixed Discord settings redirect");
  }
  const url = new URL(location);
  expect(url.origin + url.pathname).toBe(
    "https://app.okou.ai/settings/discord",
  );
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
  if (landing.searchParams.get("status") !== "pending") {
    return {
      stage: "callback" as const,
      status: "error" as const,
      error: landing.searchParams.get("discord_error"),
      httpStatus: 307,
    };
  }
  const approved = await approve(started, landing);
  if (approved.status !== 200) {
    return {
      stage: "approval" as const,
      status: "error" as const,
      error: approved.body.error.code.toLowerCase(),
      httpStatus: approved.status,
    };
  }
  const completed = await complete(started);
  return completed.status === 200
    ? {
        stage: "completion" as const,
        status: completed.body.status,
        error: null,
        httpStatus: 200,
      }
    : {
        stage: "completion" as const,
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
  ).toBe("connected");
}

describe("Discord product OAuth", () => {
  it("installs the verified bot, connects the admin and welcomes only a newly committed connection", async () => {
    const f = await fixture();
    const admin: Actor = {
      orgId: `org_${randomUUID()}`,
      userId: `user_${randomUUID()}`,
      orgRole: "org:admin",
    };
    f.actors.push(admin);
    createRouteMocks(context).clerk.session(
      admin.userId,
      admin.orgId,
      admin.orgRole,
    );
    const featureApp = await setupApp({
      context,
      routes: featureSwitchesRoutes,
    });
    await accept(
      featureApp(featureSwitchesContract).update({
        headers,
        body: { switches: { [FeatureSwitchKey.DiscordIntegration]: true } },
      }),
      [200],
    );
    await expect(status(admin)).resolves.toMatchObject({
      isConnected: false,
      onboarding: "oauth",
    });
    await installed(f, admin);
    await expect(status(admin)).resolves.toMatchObject({
      isConnected: true,
      guildId: f.guildId,
      discordUserId: f.discordUserId,
      isAdmin: true,
    });
    expect(f.messages).toHaveLength(1);
    expect(f.messages[0]).toContain(`**Hi! I'm <@${f.botId}>.**`);
    expect(f.messages[0]).toContain("_No workspace agent configured yet._");
    await installed(f, admin);
    await status(admin);
    await status(admin);
    expect(f.messages).toHaveLength(1);
  });
  it("welcomes a connected user with their workspace agent and usage guidance", async () => {
    const f = fixture();
    const admin = await f.actor();
    const authOrgApi = createAuthOrgAgentsBddApi(context);
    const actor = authOrgApi.user(admin);
    authOrgApi.acceptAgentStorageWrites();
    await authOrgApi.readOnboardingStatus(actor);

    await installed(f, admin);

    expect(f.messages).toHaveLength(1);
    expect(f.messages[0]).toContain("**Workspace Agent**\n• `Okou`");
    expect(f.messages[0]).toContain(
      "**How to Use**\n• Just describe what you need help with",
    );
  });
  it("installs when Discord returns only user scopes in the token and authorization", async () => {
    const f = fixture();
    const actor = await f.actor();
    const started = await start(actor, "install", f.guildId);
    expect(started.url.searchParams.get("scope")).toBe(
      "bot applications.commands identify guilds",
    );
    expect(started.url.searchParams.get("integration_type")).toBe("0");
    expect(started.url.searchParams.get("guild_id")).toBeNull();
    expect(started.url.searchParams.get("disable_guild_select")).toBeNull();
    await expect(
      finish(f, started, {
        scopes: ["identify", "guilds"],
        tokenScopes: "identify guilds",
      }),
    ).resolves.toMatchObject({ status: "connected", httpStatus: 200 });
    await expect(status(actor)).resolves.toMatchObject({
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
    expect((await finish(f, installed)).status).toBe("connected");
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

  it("connects from a server link without a workspace installation or server-management permission", async () => {
    const f = fixture();
    const member = await f.actor(undefined, "org:member");
    f.provider.page = [
      { id: f.guildId, name: "Shared server", owner: false, permissions: "0" },
    ];
    const started = await start(member, "connect", f.guildId);
    expect(started.url.searchParams.get("scope")).toBe("identify guilds");
    expect(started.url.searchParams.get("permissions")).toBeNull();
    expect(started.url.searchParams.get("integration_type")).toBeNull();
    expect((await finish(f, started, { noGuildProof: true })).status).toBe(
      "connected",
    );
    await expect(status(member)).resolves.toMatchObject({
      isConnected: true,
      isAdmin: false,
    });
  });

  it("lets an ordinary current org member connect only their verified Discord identity", async () => {
    const f = await fixture();
    const admin = await f.actor();
    await installed(f, admin);
    const member = await f.actor(admin.orgId, "org:member");
    const memberDiscordId = snowflake();
    const started = await start(member, "connect", f.guildId);
    expect(started.url.searchParams.get("scope")).toBe("identify guilds");
    expect(
      (await finish(f, started, { discordUserId: memberDiscordId })).status,
    ).toBe("connected");
    await expect(status(member)).resolves.toMatchObject({
      isConnected: true,
      isAdmin: false,
      discordUserId: memberDiscordId,
    });
    expect((await status(admin)).discordUserId).toBe(f.discordUserId);
  });
  it("allows ordinary workspace members to connect and rejects unauthenticated or malformed owner input", async () => {
    const f = await fixture();
    const member = await f.actor(undefined, "org:member");
    authenticate(member);
    await accept(
      clients()(discordOauthContract).start({
        headers,
        body: {},
      }),
      [200],
    );
    const raw = setupRawAppRequest({ context, routes });
    await accept(
      raw("/api/integrations/discord/oauth/start", {
        method: "POST",
        headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify({
          userId: "arbitrary",
          orgId: "arbitrary",
        }),
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
        body: {},
      }),
      [401],
    );
    expect((await status(member)).isConnected).toBeFalsy();
  });
  it("allows account consent after an Okou admin becomes an ordinary workspace member", async () => {
    const f = fixture();
    const actor = await f.actor();
    const started = await start(actor, "install");
    actor.orgRole = "org:member";
    await expect(finish(f, started)).resolves.toMatchObject({
      status: "connected",
    });
    expect((await status(actor)).isConnected).toBeTruthy();
  });
  it("starts account consent without a workspace installation and reports missing configuration", async () => {
    const f = await fixture();
    const actor = await f.actor();
    authenticate(actor);
    await accept(
      clients()(discordOauthContract).start({
        headers,
        body: { guildId: f.guildId },
      }),
      [200],
    );
    mockEnv("DISCORD_OAUTH_CLIENT_SECRET", undefined);
    const response = await accept(
      clients()(discordOauthContract).start({
        headers,
        body: {},
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
    expect((await status(actor)).isConnected).toBeFalsy();
    expect((await finish(f, started)).status).toBe("connected");
  });
  it.each(["malformed-state", "oversize-code", "oversize-error"])(
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
      };
      await accept(clients()(discordOauthContract).callback({ query }), [400]);
      expect((await finish(f, started)).status).toBe("connected");
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
    expect((await status(actor)).isConnected).toBeFalsy();
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
    expect((await status(actor)).isConnected).toBeFalsy();
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
    expect((await status(actor)).isConnected).toBeFalsy();
  });
  it.each(["revoked-member", "switch-off"])(
    "revalidates %s while authorization is open",
    async (variant) => {
      const f = await fixture();
      const actor = await f.actor();
      const started = await start(actor, "install", f.guildId);
      if (variant === "revoked-member") {
        f.actors.splice(0);
      }
      if (variant === "switch-off") {
        await updateFeatureSwitchesForUser(context, actor, {
          [FeatureSwitchKey.DiscordIntegration]: false,
        });
      }
      const result = await finish(f, started);
      expect(result.status).toBe("error");
      expect((await status(actor)).isConnected).toBeFalsy();
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
    expect((await status(actor)).isConnected).toBeFalsy();
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
  it("connects independent workspaces in the same server and preserves a connection when choosing another server", async () => {
    const f = fixture();
    const owner = await f.actor();
    await installed(f, owner);
    const original = await status(owner);
    const other = await f.actor();
    await expect(
      finish(f, await start(other, "connect", f.guildId), {
        discordUserId: snowflake(),
      }),
    ).resolves.toMatchObject({ status: "connected" });
    const nextGuild = snowflake();
    await expect(
      finish(f, await start(owner, "install"), { guildId: nextGuild }),
    ).resolves.toMatchObject({ status: "connected" });
    const reconnected = await status(owner);
    expect(reconnected.guildId).toBe(nextGuild);
    expect(reconnected.dmBindings[0]?.connectionId).toBe(
      original.dmBindings[0]?.connectionId,
    );
    expect((await status(other)).isConnected).toBeTruthy();
    expect(f.messages).toHaveLength(2);
  });
  it("rejects stealing a Discord identity in the same guild and across guilds", async () => {
    const f = await fixture();
    const owner = await f.actor();
    await installed(f, owner);
    const member = await f.actor(owner.orgId, "org:member");
    expect(
      (await finish(f, await start(member, "connect", f.guildId))).error,
    ).toBe("conflict");
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
    expect((await status(otherOrg)).isConnected).toBeFalsy();
    expect((await status(owner)).discordUserId).toBe(f.discordUserId);
    expect(f.messages).toHaveLength(1);
  });
  it("requires disconnect before changing a user's Discord identity and releases unused ownership", async () => {
    const f = await fixture();
    const owner = await f.actor();
    await installed(f, owner);
    expect(
      (
        await finish(f, await start(owner, "connect", f.guildId), {
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
    expect(
      (await finish(f, await start(member, "connect", f.guildId))).status,
    ).toBe("connected");
    expect((await status(member)).discordUserId).toBe(f.discordUserId);
  });
  it("does not reserve a replacement Discord identity after an occupied-user binding fails", async () => {
    const f = await fixture();
    const owner = await f.actor();
    await installed(f, owner);
    const replacement = snowflake();
    const started = await start(owner, "connect", f.guildId);
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
  it("connects different users in different workspaces concurrently through the same server", async () => {
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
    ).toStrictEqual(["connected", "connected"]);
    const statuses = [await status(firstOwner), await status(secondOwner)];
    expect(
      statuses.filter((result) => {
        return result.isConnected;
      }),
    ).toHaveLength(2);
    expect(f.messages).toHaveLength(2);
  });
  it("keeps one account connection when the same owner connects from two servers concurrently", async () => {
    const f = fixture();
    const owner = await f.actor();
    const first = await start(owner, "install");
    const second = await start(owner, "install");
    const firstLanding = await verified(f, first);
    const secondLanding = await verified(f, second, { guildId: snowflake() });
    expect((await approve(first, firstLanding)).status).toBe(200);
    expect((await approve(second, secondLanding)).status).toBe(200);

    const ready = createDeferredPromise<void>(context.signal);
    const guilds = new Set<string>();
    server.use(
      http.get(
        `${API}/guilds/:guildId/members/${f.discordUserId}`,
        async ({ params }) => {
          guilds.add(String(params.guildId));
          if (guilds.size === 2 && !ready.settled()) {
            ready.resolve();
          }
          await ready.promise;
          return HttpResponse.json({
            user: { id: f.discordUserId, username: "member" },
            roles: [],
          });
        },
      ),
    );
    const results = await Promise.all([complete(first), complete(second)]);
    const knownErrors = new Set([
      "cancelled",
      "unavailable",
      "forbidden",
      "provider_error",
      "invalid_authorization",
      "guild_unverified",
      "bot_missing",
      "invalid_state",
      "discord_oauth_invalid_attempt",
      "discord_not_configured",
      "discord_oauth_unavailable",
      "conflict",
      "discord_oauth_failed",
      "discord_oauth_approval_required",
      "bad_request",
    ]);
    expect(
      results,
      JSON.stringify({
        orgId: owner.orgId,
        userId: owner.userId,
        attempts: results.map((result, index) => {
          const error =
            result.status === 200 ? null : result.body.error.code.toLowerCase();
          return {
            label: index === 0 ? "first" : "second",
            stage: "completion",
            httpStatus: result.status,
            error: knownErrors.has(error ?? "") ? error : null,
          };
        }),
      }),
    ).toMatchObject([
      { status: 200, body: { status: "connected" } },
      { status: 200, body: { status: "connected" } },
    ]);
    const connected = await status(owner);
    expect(connected.dmBindings).toHaveLength(1);
    expect(f.messages).toHaveLength(1);
    expect((await finish(f, await start(owner, "install"))).status).toBe(
      "connected",
    );
    const reconnected = await status(owner);
    expect(reconnected.guildId).toBe(f.guildId);
    expect(
      reconnected.dmBindings.map((binding) => {
        return binding.connectionId;
      }),
    ).toStrictEqual(
      connected.dmBindings.map((binding) => {
        return binding.connectionId;
      }),
    );
    expect(f.messages).toHaveLength(1);
    expect((await complete(first)).status).toBe(400);
    expect((await complete(second)).status).toBe(400);
  });
  it("installs into an invite's server while preserving the existing account connection", async () => {
    const f = fixture();
    const owner = await f.actor();
    await installed(f, owner);
    const before = await status(owner);
    const guildId = snowflake();
    const attempt = await start(owner, "install", guildId, true);
    expect(attempt.url.searchParams.get("guild_id")).toBe(guildId);
    expect(attempt.url.searchParams.get("disable_guild_select")).toBe("true");
    expect(attempt.url.searchParams.get("scope")?.split(" ")).toContain("bot");
    expect(attempt.url.searchParams.get("integration_type")).toBe("0");
    expect((await finish(f, attempt, { guildId })).status).toBe("connected");
    const after = await status(owner);
    expect(after.guildId).toBe(guildId);
    expect(after.discordUserId).toBe(before.discordUserId);
    expect(
      after.dmBindings.map((binding) => {
        return binding.connectionId;
      }),
    ).toStrictEqual(
      before.dmBindings.map((binding) => {
        return binding.connectionId;
      }),
    );
    expect(f.messages).toHaveLength(1);
  });
  it("rejects a different installed server than the invite target and keeps the old connection", async () => {
    const f = fixture();
    const owner = await f.actor();
    await installed(f, owner);
    const before = await status(owner);
    const attempt = await start(owner, "install", snowflake(), true);
    expect((await finish(f, attempt, { guildId: snowflake() })).status).toBe(
      "error",
    );
    await expect(status(owner)).resolves.toStrictEqual(before);
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
    ).toStrictEqual(["connected", "error"]);
    const statuses = [await status(firstOwner), await status(secondOwner)];
    expect(
      statuses.filter((result) => {
        return result.isConnected;
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
      {
        attempt: await start(member, "connect", f.guildId),
        sender: snowflake(),
      },
      {
        attempt: await start(member, "connect", f.guildId),
        sender: snowflake(),
      },
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
    const knownErrors = new Set([
      "cancelled",
      "unavailable",
      "forbidden",
      "provider_error",
      "invalid_authorization",
      "guild_unverified",
      "bot_missing",
      "invalid_state",
      "discord_oauth_invalid_attempt",
      "discord_not_configured",
      "discord_oauth_unavailable",
      "conflict",
      "discord_oauth_failed",
      "discord_oauth_approval_required",
      "bad_request",
    ]);
    expect(
      results.map((result) => {
        return result.status;
      }),
      JSON.stringify({
        orgId: actor.orgId,
        userId: actor.userId,
        attempts: results.map((result, index) => {
          return {
            label: index === 0 ? "first" : "second",
            stage: result.stage,
            httpStatus: result.httpStatus,
            error: knownErrors.has(result.error ?? "") ? result.error : null,
          };
        }),
      }),
    ).toStrictEqual(["connected", "connected"]);
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
    ).toStrictEqual(["connected", "error"]);
    expect((await status(actor)).isConnected).toBeTruthy();
    expect(f.messages).toHaveLength(1);
  });
  it("does not reconnect an account from a pending attempt after disconnect", async () => {
    const f = await fixture();
    const actor = await f.actor();
    await installed(f, actor);
    const started = await start(actor, "connect", f.guildId);
    authenticate(actor);
    await accept(
      clients()(integrationsDiscordContract).disconnect({
        headers,
        query: {},
      }),
      [200],
    );
    expect((await finish(f, started)).error).toBe("invalid_state");
    await expect(status(actor)).resolves.toMatchObject({
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
    expect((await status(actor)).isConnected).toBeFalsy();
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
    expect(Object.fromEntries(landing.searchParams)).toStrictEqual({
      status: "pending",
      guild_id: f.guildId,
    });
    await expect(status(actor)).resolves.toMatchObject({
      isConnected: false,
    });
    expect(f.messages).toStrictEqual([]);
    expect((await complete(started)).status).toBe(409);
    expect((await approve(started, landing)).status).toBe(200);
    await expect(status(actor)).resolves.toMatchObject({
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
    "switch-before-approve",
    "member-before-complete",
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
    if (variant.startsWith("switch")) {
      await updateFeatureSwitchesForUser(context, actor, {
        [FeatureSwitchKey.DiscordIntegration]: false,
      });
    }
    const result = variant.endsWith("before-complete")
      ? await complete(started)
      : await approve(started, landing);
    expect(result.status).toBe(403);
    expect((await status(actor)).isConnected).toBeFalsy();
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
      expect((await status(actor)).isConnected).toBeFalsy();
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
    expect((await status(actor)).isConnected).toBeFalsy();
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
      expect((await status(actor)).isConnected).toBeFalsy();
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
  it("does not grant access from query markers, lost opener proof or malformed capabilities", async () => {
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
      expect(
        (await finish(f, await start(oldOwner, "connect", f.guildId))).status,
      ).toBe("connected");
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
    expect(landing.searchParams.get("status")).toBe("pending");
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
