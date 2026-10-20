import { randomUUID } from "node:crypto";
import { z } from "zod";
import { beforeEach, describe, expect, it } from "vitest";
import { http, HttpResponse } from "msw";
import { server } from "../../../mocks/server";
import { integrationsDiscordContract } from "@okouai/api-contracts/contracts/integrations-discord";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp, setupRawAppRequest } from "../../../__tests__/test-helpers";
import { mockEnv } from "../../../lib/env";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { createDeferredPromise, settleIncludingAbort } from "../../utils";
import { integrationsDiscordRoutes } from "../integrations-discord";
import {
  configureDiscordApp,
  removePublicDiscordBinding,
  mockDiscordApplication,
  mockDiscordMemberships,
  createPublicDiscordBinding,
  type DiscordActor,
  type DiscordFixture,
} from "./helpers/discord";
import { updateFeatureSwitchesForUser } from "./helpers/feature-switches";
import { createFixtureTracker, createRouteMocks } from "./helpers/route-test";
import { createBddApi } from "./helpers/api-bdd";
import { createAuthOrgAgentsBddApi } from "./helpers/api-bdd-auth-org";
import { channelsPublishedTo } from "./helpers/realtime-publications";
import { claimPublicDiscordTestRun } from "./helpers/discord-run";

const context = testContext();
const track = createFixtureTracker((fixture: DiscordFixture) => {
  return removePublicDiscordBinding(context, fixture);
});

beforeEach(() => {
  mockEnv("ENV", "development");
  configureDiscordApp();
  mockEnv("DISCORD_OAUTH_CLIENT_SECRET", "discord-test-client-secret");
});

function createActors() {
  const actors: DiscordActor[] = [];
  return {
    actor(options: Partial<DiscordActor> = {}): DiscordActor {
      const value = {
        userId: options.userId ?? `user_${randomUUID()}`,
        orgId: options.orgId ?? `org_${randomUUID()}`,
        orgRole: options.orgRole ?? "org:admin",
      } as const;
      actors.push(value);
      mockDiscordMemberships(context, actors);
      return value;
    },
    restore(): void {
      mockDiscordMemberships(context, actors);
    },
  };
}

function authenticate(value: DiscordActor) {
  createRouteMocks(context).clerk.session(
    value.userId,
    value.orgId,
    value.orgRole,
  );
  return { authorization: "Bearer clerk-session" };
}

function client() {
  return setupApp({ context, routes: integrationsDiscordRoutes })(
    integrationsDiscordContract,
  );
}

async function enable(value: DiscordActor): Promise<void> {
  await updateFeatureSwitchesForUser(context, value, {
    [FeatureSwitchKey.DiscordIntegration]: true,
  });
}

async function fixture(
  value: DiscordActor,
  options: Partial<
    Pick<
      DiscordFixture,
      "guildId" | "guildName" | "discordUserId" | "botUserId"
    >
  > & { readonly flow?: "install" | "connect" } = {},
): Promise<DiscordFixture> {
  await enable(value);
  const binding = await track(
    createPublicDiscordBinding(context, {
      ...value,
      flow: "install",
      ...options,
    }),
  );
  await flushWaitUntilForTest();
  // Assertions below observe settings mutations, not OAuth setup broadcasts.
  context.mocks.ably.publish.mockClear();
  context.mocks.ably.channelGet.mockClear();
  return binding;
}

async function status(value: DiscordActor) {
  return (
    await accept(client().getStatus({ headers: authenticate(value) }), [200])
  ).body;
}

async function expectDiscordChanges(userIds: readonly string[]): Promise<void> {
  await flushWaitUntilForTest();
  expect(
    [...channelsPublishedTo(context.mocks, "discord:changed")].sort(),
  ).toStrictEqual(
    userIds
      .map((userId) => {
        return `user:${userId}`;
      })
      .sort(),
  );
  expect(
    context.mocks.ably.publish.mock.calls
      .filter((call) => {
        return call[0] === "discord:changed";
      })
      .map((call) => {
        return call[1];
      }),
  ).toStrictEqual(
    userIds.map(() => {
      return null;
    }),
  );
}

async function registerMemberCache(value: DiscordActor): Promise<void> {
  const api = createAuthOrgAgentsBddApi(context);
  const profile = api.user(value);
  const { token } = await api.createCliToken(profile);
  context.mocks.clerk.users.getOrganizationMembershipList.mockResolvedValueOnce(
    {
      data: [
        {
          role: value.orgRole ?? "org:admin",
          organization: { id: value.orgId },
        },
      ],
    },
  );
  await api.requestReadMeWithBearer(token, profile, [200]);
}

describe("Discord server installation links", () => {
  const invite = "https://discord.gg/example";
  const guild = { id: "1559819014036000790", name: "New server" };

  async function resolve(invitation: string) {
    const owner = createActors().actor();
    await enable(owner);
    return client().installLink({
      headers: authenticate(owner),
      body: { invite: invitation },
    });
  }

  it.each([
    invite,
    "https://discord.com/invite/example?utm_source=share",
    "https://discordapp.com/invite/example/",
  ])(
    "resolves %s without an existing binding or provider credentials",
    async (invitation) => {
      mockEnv("APP_URL", "https://preview-app.example");
      const lookups: string[] = [];
      server.use(
        http.get(
          "https://discord.com/api/v10/invites/example",
          ({ request }) => {
            lookups.push(request.method);
            expect(request.headers.get("authorization")).toBeNull();
            expect(
              new URL(request.url).searchParams.get("with_expiration"),
            ).toBe("true");
            return HttpResponse.json({ type: 0, guild, expires_at: null });
          },
        ),
      );
      const result = await accept(resolve(invitation), [200]);
      expect(result.body).toStrictEqual({
        url: `https://preview-app.example/settings/discord/install?guild_id=${guild.id}`,
        guildId: guild.id,
        guildName: guild.name,
      });
      expect(lookups).toStrictEqual(["GET"]);
      await expectDiscordChanges([]);
    },
  );

  it.each([
    "https://attacker.example/invite/example",
    "https://discord.gg.attacker.example/example",
    "https://discord.gg@attacker.example/example",
    "http://discord.gg/example",
    "https://discord.gg:444/example",
    "https://discord.gg/example/another",
    "https://discord.com/channels/123",
  ])(
    "rejects an unsupported URL without fetching it: %s",
    async (invitation) => {
      const response = await accept(resolve(invitation), [400]);
      expect(response.body.error.code).toBe("BAD_REQUEST");
    },
  );

  it.each([
    { providerStatus: 404, body: {}, expected: 404 },
    { providerStatus: 200, body: { type: 1 }, expected: 400 },
    {
      providerStatus: 200,
      body: { type: 0, guild, expires_at: "2020-01-01T00:00:00Z" },
      expected: 404,
    },
    {
      providerStatus: 429,
      body: { retry_after: 5, global: false },
      expected: 429,
    },
    { providerStatus: 500, body: {}, expected: 502 },
  ] as const)(
    "handles provider status $providerStatus as $expected",
    async ({ providerStatus, body, expected }) => {
      server.use(
        http.get("https://discord.com/api/v10/invites/example", () => {
          return HttpResponse.json(body, { status: providerStatus });
        }),
      );
      expect((await resolve(invite)).status).toBe(expected);
    },
  );

  it("requires authentication and the Discord feature switch", async () => {
    context.mocks.clerk.authenticateRequest.mockResolvedValue({
      isAuthenticated: false,
    });
    await accept(
      client().installLink({ headers: {}, body: { invite } }),
      [401],
    );
    const owner = createActors().actor();
    await updateFeatureSwitchesForUser(context, owner, {
      [FeatureSwitchKey.DiscordIntegration]: false,
    });
    const response = await accept(
      client().installLink({ headers: authenticate(owner), body: { invite } }),
      [403],
    );
    expect(response.body.error.code).toBe("FORBIDDEN");
  });
});

describe("Discord installation link run access", () => {
  it.each([true, false])(
    "honors the run's captured Discord read capability without requiring a server binding (enabled: %s)",
    async (enabled) => {
      const { actor, restore } = createActors();
      const owner = actor();
      await updateFeatureSwitchesForUser(context, owner, {
        [FeatureSwitchKey.DiscordIntegration]: enabled,
      });
      const profile = createAuthOrgAgentsBddApi(context).user(owner);
      const run = await claimPublicDiscordTestRun(context, profile);
      // Web runs can use the CLI, but must not receive Discord-only invite guidance.
      expect(run.claim.appendSystemPrompt).not.toContain(
        "okou discord install-link",
      );
      await enable(owner);
      restore();
      server.use(
        http.get("https://discord.com/api/v10/invites/example", () => {
          return HttpResponse.json({
            type: 0,
            guild: { id: "1559819014036000790", name: "New server" },
          });
        }),
      );
      const result = await client().installLink({
        headers: run.headers,
        body: { invite: "https://discord.gg/example" },
      });
      expect(result.status).toBe(enabled ? 200 : 403);
      if (result.status === 403) {
        expect(result.body.error.message).toContain("discord:read");
      }
    },
  );
});

describe("verified Discord integration settings", () => {
  it("requires authenticated organization membership", async () => {
    context.mocks.clerk.authenticateRequest.mockResolvedValue({
      isAuthenticated: false,
    });
    const anonymousStatus = await accept(
      client().getStatus({ headers: {} }),
      [401],
    );
    expect(anonymousStatus.status).toBe(401);
    await accept(client().disconnect({ headers: {}, query: {} }), [401]);
    await accept(
      client().setDmSelection({
        headers: {},
        body: { connectionId: randomUUID() },
      }),
      [401],
    );

    createRouteMocks(context).clerk.session(`user_${randomUUID()}`, null);
    const withoutOrganization = await accept(
      client().getStatus({
        headers: { authorization: "Bearer clerk-session" },
      }),
      [401],
    );
    expect(withoutOrganization.status).toBe(401);
    await expectDiscordChanges([]);
  });

  it("keeps configured bindings unavailable until their owner enables the feature", async () => {
    const { actor, restore } = createActors();
    const owner = actor();
    await fixture(owner);
    await updateFeatureSwitchesForUser(context, owner, {
      [FeatureSwitchKey.DiscordIntegration]: false,
    });
    await flushWaitUntilForTest();
    context.mocks.ably.publish.mockClear();
    context.mocks.clerk.organizations.getOrganizationMembershipList.mockRejectedValue(
      new Error("Clerk membership unavailable"),
    );

    await expect(status(owner)).resolves.toMatchObject({
      isAvailable: false,
      isConnected: false,
      guildId: null,
      discordUserId: null,
      contextMode: "unavailable",
      onboarding: "oauth",
      dmBindings: [],
    });
    restore();
    await expectDiscordChanges([]);
  });

  it("lets users remove Discord data after the feature is rolled back", async () => {
    const { actor } = createActors();
    const owner = actor();
    const installed = await fixture(owner);
    const peer = actor({ orgId: owner.orgId });
    await fixture(peer, { flow: "connect", guildId: installed.guildId });
    await updateFeatureSwitchesForUser(context, owner, {
      [FeatureSwitchKey.DiscordIntegration]: false,
    });
    await updateFeatureSwitchesForUser(context, peer, {
      [FeatureSwitchKey.DiscordIntegration]: false,
    });
    await expect(status(owner)).resolves.toMatchObject({
      isAvailable: false,
      isConnected: false,
    });
    await accept(
      client().setDmSelection({
        headers: authenticate(owner),
        body: { connectionId: installed.connectionId },
      }),
      [404],
    );

    await accept(
      client().disconnect({ headers: authenticate(owner), query: {} }),
      [200],
    );
    await expectDiscordChanges([owner.userId]);
    await accept(
      client().disconnect({ headers: authenticate(owner), query: {} }),
      [404],
    );
    await expectDiscordChanges([owner.userId]);

    await enable(owner);
    await enable(peer);
    await expect(status(owner)).resolves.toMatchObject({
      isAvailable: true,
      isConnected: false,
    });
    await expect(status(peer)).resolves.toMatchObject({
      isConnected: true,
    });
  });

  it("reports existing bindings and unavailable context when app configuration is missing", async () => {
    const { actor } = createActors();
    const owner = actor();
    const installed = await fixture(owner);
    mockEnv("DISCORD_BOT_TOKEN", undefined);

    await expect(status(owner)).resolves.toMatchObject({
      isAvailable: false,
      isConnected: true,
      guildId: installed.guildId,
      contextMode: "unavailable",
      onboarding: "oauth",
      dmBindings: [],
    });
  });

  it("reports verified guild identity and honest MESSAGE_CONTENT availability", async () => {
    const { actor } = createActors();
    const owner = actor();
    const installed = await fixture(owner, { guildName: "Customer workspace" });

    await expect(status(owner)).resolves.toStrictEqual({
      isAvailable: true,
      isConnected: true,
      isAdmin: true,
      guildId: installed.guildId,
      guildName: "Customer workspace",
      discordUserId: installed.discordUserId,
      defaultAgentId: null,
      defaultAgentName: null,
      contextMode: "mentions_only",
      onboarding: "oauth",
      dmSelectionConnectionId: null,
      dmBindings: [
        {
          connectionId: installed.connectionId,
          guildId: installed.guildId,
          guildName: "Customer workspace",
          workspaceName: "Discord test workspace",
        },
      ],
    });
    mockDiscordApplication(1 << 18);
    await expect(status(owner)).resolves.toMatchObject({ contextMode: "full" });
  });

  it.each([
    { flags: 1 << 19 },
    { flags: 0, flagsNew: String((1n << 40n) | (1n << 18n)) },
    { flags: 0, flagsNew: String(1n << 19n) },
  ])(
    "reports full context for Discord's actual grant $flags/$flagsNew",
    async ({ flags, flagsNew }) => {
      const { actor } = createActors();
      const owner = actor();
      await fixture(owner);
      mockDiscordApplication(flags, flagsNew);
      await expect(status(owner)).resolves.toMatchObject({
        contextMode: "full",
      });
    },
  );

  it.each([
    { id: "123456789012345678", flags: 1 << 14 },
    { id: "123456789012345678", flags: 1 << 18, flags_new: "0" },
  ])(
    "reports mentions-only when the authoritative flags do not grant content",
    async (application) => {
      const { actor } = createActors();
      const owner = actor();
      await fixture(owner);
      server.use(
        http.get("https://discord.com/api/v10/applications/@me", () => {
          return HttpResponse.json(application);
        }),
      );
      await expect(status(owner)).resolves.toMatchObject({
        contextMode: "mentions_only",
      });
    },
  );

  it.each([
    { id: "123456789012345679", flags: 1 << 18 },
    { id: "123456789012345678" },
  ])(
    "does not claim content access from invalid or mismatched application metadata",
    async (application) => {
      const { actor } = createActors();
      const owner = actor();
      await fixture(owner);
      server.use(
        http.get("https://discord.com/api/v10/applications/@me", () => {
          return HttpResponse.json(application);
        }),
      );
      await expect(status(owner)).resolves.toMatchObject({
        contextMode: "unavailable",
      });
    },
  );

  it.each([401, 429, 500])(
    "reports unavailable context when application discovery fails with %i",
    async (statusCode) => {
      const { actor } = createActors();
      const owner = actor();
      await fixture(owner);
      server.use(
        http.get("https://discord.com/api/v10/applications/@me", () => {
          return HttpResponse.json(
            { retry_after: 1, global: false },
            { status: statusCode },
          );
        }),
      );
      await expect(status(owner)).resolves.toMatchObject({
        contextMode: "unavailable",
      });
    },
  );

  it("disconnects only the caller while preserving the guild and another verified user", async () => {
    const { actor } = createActors();
    const owner = actor();
    const first = await fixture(owner);
    const peer = actor({ orgId: owner.orgId });
    const second = await fixture(peer, {
      flow: "connect",
      guildId: first.guildId,
    });

    await accept(
      client().disconnect({ headers: authenticate(owner), query: {} }),
      [200],
    );
    await expectDiscordChanges([owner.userId]);

    const disconnected = await status(owner);
    expect(disconnected).toMatchObject({
      isConnected: false,
      discordUserId: null,
    });
    expect(disconnected.dmBindings).toStrictEqual([]);
    expect(disconnected.dmSelectionConnectionId).toBeNull();
    await expect(status(peer)).resolves.toMatchObject({
      isConnected: true,
      discordUserId: second.discordUserId,
    });
    await accept(
      client().disconnect({ headers: authenticate(owner), query: {} }),
      [404],
    );
    await expectDiscordChanges([owner.userId]);
  });

  it("notifies only the disconnecting user and preserves peers and cached admins", async () => {
    const { actor } = createActors();
    const owner = actor();
    const installed = await fixture(owner);
    const connected = actor({ orgId: owner.orgId });
    await fixture(connected, { flow: "connect", guildId: installed.guildId });
    const unconnectedAdmin = actor({ orgId: owner.orgId });
    const unconnectedMember = actor({
      orgId: owner.orgId,
      orgRole: "org:member",
    });
    const otherOwner = actor();
    const otherInstalled = await fixture(otherOwner);
    for (const cachedActor of [
      owner,
      unconnectedAdmin,
      unconnectedMember,
      otherOwner,
    ]) {
      await registerMemberCache(cachedActor);
    }
    await enable(unconnectedAdmin);
    await expect(status(unconnectedAdmin)).resolves.toMatchObject({
      isConnected: false,
    });
    await expectDiscordChanges([]);

    await accept(
      client().disconnect({
        headers: authenticate(owner),
        query: {},
      }),
      [200],
    );
    const recipients = [owner.userId];
    await expectDiscordChanges(recipients);
    await expect(status(connected)).resolves.toMatchObject({
      isConnected: true,
    });
    await expect(status(otherOwner)).resolves.toMatchObject({
      isConnected: true,
      guildId: otherInstalled.guildId,
    });

    await accept(
      client().disconnect({
        headers: authenticate(owner),
        query: {},
      }),
      [404],
    );
    await expectDiscordChanges(recipients);
  });

  it("hides revoked membership and refuses subsequent binding mutations", async () => {
    const { actor, restore } = createActors();
    const owner = actor();
    const installed = await fixture(owner);
    mockDiscordMemberships(context, []);

    await expect(status(owner)).resolves.toMatchObject({
      isConnected: false,
      dmBindings: [],
    });
    await accept(
      client().setDmSelection({
        headers: authenticate(owner),
        body: { connectionId: installed.connectionId },
      }),
      [404],
    );
    await accept(
      client().disconnect({ headers: authenticate(owner), query: {} }),
      [404],
    );
    await expectDiscordChanges([]);
    restore();
  });

  it("keeps DM bindings and saved choices isolated across successive user requests", async () => {
    const { actor } = createActors();
    const firstOwner = actor();
    const first = await fixture(firstOwner);
    const secondOwner = actor();
    const second = await fixture(secondOwner);

    for (const [owner, binding] of [
      [firstOwner, first],
      [secondOwner, second],
    ] as const) {
      await accept(
        client().setDmSelection({
          headers: authenticate(owner),
          body: { connectionId: binding.connectionId },
        }),
        [200],
      );
    }

    for (const [owner, binding] of [
      [firstOwner, first],
      [secondOwner, second],
      [firstOwner, first],
    ] as const) {
      const current = await status(owner);
      expect({
        discordUserId: current.discordUserId,
        dmBindings: current.dmBindings,
        dmSelectionConnectionId: current.dmSelectionConnectionId,
      }).toStrictEqual({
        discordUserId: binding.discordUserId,
        dmBindings: [
          {
            connectionId: binding.connectionId,
            guildId: binding.guildId,
            guildName: binding.guildName,
            workspaceName: "Discord test workspace",
          },
        ],
        dmSelectionConnectionId: binding.connectionId,
      });
    }
  });

  it("requires an explicit DM choice across organizations and invalidates a revoked choice", async () => {
    const { actor } = createActors();
    const firstOwner = actor();
    const first = await fixture(firstOwner);
    const secondOwner = actor({ userId: firstOwner.userId });
    const second = await fixture(secondOwner, {
      discordUserId: first.discordUserId,
    });
    const thirdOwner = actor({ userId: firstOwner.userId });
    const third = await fixture(thirdOwner, {
      discordUserId: first.discordUserId,
    });

    const ambiguous = await status(firstOwner);
    expect(ambiguous.dmSelectionConnectionId).toBeNull();
    expect(
      ambiguous.dmBindings
        .map((binding) => {
          return binding.connectionId;
        })
        .sort(),
    ).toStrictEqual(
      [first.connectionId, second.connectionId, third.connectionId].sort(),
    );
    await accept(
      client().setDmSelection({
        headers: authenticate(firstOwner),
        body: { connectionId: second.connectionId },
      }),
      [200],
    );
    await expectDiscordChanges([firstOwner.userId]);
    await expect(status(firstOwner)).resolves.toMatchObject({
      dmSelectionConnectionId: second.connectionId,
    });

    for (const connectionId of [third.connectionId, second.connectionId]) {
      await accept(
        client().setDmSelection({
          headers: authenticate(firstOwner),
          body: { connectionId },
        }),
        [200],
      );
      await expect(status(firstOwner)).resolves.toMatchObject({
        dmSelectionConnectionId: connectionId,
      });
    }
    await expectDiscordChanges([
      firstOwner.userId,
      firstOwner.userId,
      firstOwner.userId,
    ]);

    await accept(
      client().disconnect({ headers: authenticate(secondOwner), query: {} }),
      [200],
    );
    await expectDiscordChanges([
      firstOwner.userId,
      firstOwner.userId,
      firstOwner.userId,
      firstOwner.userId,
    ]);
    const revoked = await status(firstOwner);
    expect(revoked.dmSelectionConnectionId).toBeNull();
    expect(
      revoked.dmBindings
        .map((binding) => {
          return binding.connectionId;
        })
        .sort(),
    ).toStrictEqual([first.connectionId, third.connectionId].sort());
    await accept(
      client().setDmSelection({
        headers: authenticate(firstOwner),
        body: { connectionId: second.connectionId },
      }),
      [404],
    );
    await expectDiscordChanges([
      firstOwner.userId,
      firstOwner.userId,
      firstOwner.userId,
      firstOwner.userId,
    ]);
  });

  it("keeps the previous DM choice when a requested binding is disconnected while reading the body", async () => {
    const { actor } = createActors();
    const firstOwner = actor();
    const first = await fixture(firstOwner);
    const secondOwner = actor({ userId: firstOwner.userId });
    const second = await fixture(secondOwner, {
      discordUserId: first.discordUserId,
    });
    await accept(
      client().setDmSelection({
        headers: authenticate(firstOwner),
        body: { connectionId: first.connectionId },
      }),
      [200],
    );
    context.mocks.ably.publish.mockClear();
    context.mocks.ably.channelGet.mockClear();
    const reading = createDeferredPromise<void>(context.signal);
    const release = createDeferredPromise<void>(context.signal);
    const body = new ReadableStream<Uint8Array>(
      {
        async pull(controller) {
          reading.resolve();
          await release.promise;
          controller.enqueue(
            new TextEncoder().encode(
              JSON.stringify({ connectionId: second.connectionId }),
            ),
          );
          controller.close();
        },
      },
      // Do not prefetch when constructing the native Request. The gate is
      // reached only when the real route consumes its valid streamed body.
      { highWaterMark: 0 },
    );
    const request: RequestInit & { readonly duplex: "half" } = {
      method: "PUT",
      headers: {
        ...authenticate(firstOwner),
        "content-type": "application/json",
      },
      body,
      duplex: "half",
    };
    // The typed client cannot express a streamed request body.
    const pending = setupRawAppRequest({
      context,
      routes: integrationsDiscordRoutes,
    })(integrationsDiscordContract.setDmSelection.path, request);
    const outcome = await settleIncludingAbort(
      (async () => {
        await reading.promise;
        await accept(
          client().disconnect({
            headers: authenticate(secondOwner),
            query: {},
          }),
          [200],
        );
        await expectDiscordChanges([firstOwner.userId]);
        release.resolve();
        expect((await pending).status).toBe(404);
        // Disconnect publishes once; the rejected selection publishes nothing.
        await expectDiscordChanges([firstOwner.userId]);
        await expect(status(firstOwner)).resolves.toMatchObject({
          dmSelectionConnectionId: first.connectionId,
          dmBindings: [
            {
              connectionId: first.connectionId,
              guildId: first.guildId,
              guildName: first.guildName,
              workspaceName: "Discord test workspace",
            },
          ],
        });
      })(),
    );
    if (!release.settled()) {
      release.resolve();
    }
    await Promise.allSettled([pending]);
    if (!outcome.ok) {
      throw outcome.error;
    }
  });

  it("keeps the previous DM choice when the requested connection is revoked during revalidation", async () => {
    const { actor } = createActors();
    const firstOwner = actor();
    const first = await fixture(firstOwner);
    const secondOwner = actor({ userId: firstOwner.userId });
    const second = await fixture(secondOwner, {
      discordUserId: first.discordUserId,
    });
    await accept(
      client().setDmSelection({
        headers: authenticate(firstOwner),
        body: { connectionId: first.connectionId },
      }),
      [200],
    );
    context.mocks.ably.publish.mockClear();
    context.mocks.ably.channelGet.mockClear();
    const membership =
      context.mocks.clerk.organizations.getOrganizationMembershipList;
    const currentMembership = membership.getMockImplementation();
    if (!currentMembership) {
      throw new Error("Expected the genuine Clerk membership response");
    }
    let revoked = false;
    membership.mockImplementation(async (...args) => {
      const { organizationId } = z
        .object({ organizationId: z.string() })
        .parse(args[0]);
      const response = await currentMembership(...args);
      if (!revoked && organizationId === secondOwner.orgId) {
        revoked = true;
        await accept(
          client().disconnect({
            headers: authenticate(secondOwner),
            query: {},
          }),
          [200],
        );
      }
      return response;
    });

    await accept(
      client().setDmSelection({
        headers: authenticate(firstOwner),
        body: { connectionId: second.connectionId },
      }),
      [404],
    );

    expect(revoked).toBeTruthy();
    await expectDiscordChanges([firstOwner.userId]);
    await expect(status(firstOwner)).resolves.toMatchObject({
      dmSelectionConnectionId: first.connectionId,
      dmBindings: [
        {
          connectionId: first.connectionId,
          guildId: first.guildId,
          guildName: first.guildName,
          workspaceName: "Discord test workspace",
        },
      ],
    });
  });

  it("rejects DM selections for another Discord sender or another Okou user", async () => {
    const { actor } = createActors();
    const owner = actor();
    const current = await fixture(owner);
    const differentSender = actor({ userId: owner.userId });
    const wrongSenderBinding = await fixture(differentSender);
    const differentUser = actor();
    // A Discord account cannot be owned by another Okou user. The foreign
    // connection is independently installed and owned by its actual caller.
    const wrongUserBinding = await fixture(differentUser);

    for (const connectionId of [
      wrongSenderBinding.connectionId,
      wrongUserBinding.connectionId,
    ]) {
      await accept(
        client().setDmSelection({
          headers: authenticate(owner),
          body: { connectionId },
        }),
        [404],
      );
    }
    await expectDiscordChanges([]);
    expect((await status(owner)).dmBindings).toStrictEqual([
      {
        connectionId: current.connectionId,
        guildId: current.guildId,
        guildName: current.guildName,
        workspaceName: "Discord test workspace",
      },
    ]);

    await accept(
      client().setDmSelection({
        headers: authenticate(owner),
        body: { connectionId: current.connectionId },
      }),
      [200],
    );
    await expectDiscordChanges([owner.userId]);
  });

  it("always reports the organization default agent", async () => {
    const { actor } = createActors();
    const owner = actor();
    const api = createBddApi(context);
    api.acceptAgentStorageWrites();
    const ownerProfile = api.user(owner);
    const defaultAgentId = await api.bootstrapLimitedFreeOnboarding(
      ownerProfile,
      {
        displayName: "Okou",
      },
    );
    await fixture(owner);
    const ownAgent = await api.createAgent(ownerProfile, {
      visibility: "private",
      displayName: "Personal Discord agent",
    });

    await expect(status(owner)).resolves.toMatchObject({
      defaultAgentId,
      defaultAgentName: "Okou",
    });

    await api.deleteAgent(ownerProfile, ownAgent.agentId);
  });
});
