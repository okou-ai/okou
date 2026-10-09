import { randomUUID } from "node:crypto";
import { z } from "zod";
import { beforeEach, describe, expect, it } from "vitest";
import { http, HttpResponse } from "msw";
import { server } from "../../../mocks/server";
import { integrationsDiscordContract } from "@okouai/api-contracts/contracts/integrations-discord";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { mockEnv } from "../../../lib/env";
import { flushWaitUntilForTest } from "../../context/wait-until";
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

const context = testContext();
const track = createFixtureTracker((fixture: DiscordFixture) => {
  return removePublicDiscordBinding(context, fixture);
});

beforeEach(() => {
  mockEnv("ENV", "development");
  configureDiscordApp();
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
    const { actor } = createActors();
    const owner = actor();
    await fixture(owner);
    await updateFeatureSwitchesForUser(context, owner, {
      [FeatureSwitchKey.DiscordIntegration]: false,
    });
    await flushWaitUntilForTest();
    context.mocks.ably.publish.mockClear();

    await expect(status(owner)).resolves.toMatchObject({
      isAvailable: false,
      isInstalled: false,
      isConnected: false,
      guildId: null,
      discordUserId: null,
      contextMode: "unavailable",
      onboarding: "oauth",
      dmBindings: [],
    });
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
      isInstalled: false,
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
    await accept(
      client().disconnect({
        headers: authenticate(owner),
        query: { action: "uninstall" },
      }),
      [200],
    );
    await expectDiscordChanges([owner.userId, owner.userId, peer.userId]);

    await enable(owner);
    await enable(peer);
    await expect(status(owner)).resolves.toMatchObject({
      isAvailable: true,
      isInstalled: false,
      isConnected: false,
    });
    await expect(status(peer)).resolves.toMatchObject({
      isInstalled: false,
      isConnected: false,
    });
    await accept(
      client().disconnect({
        headers: authenticate(owner),
        query: { action: "uninstall" },
      }),
      [404],
    );
  });

  it("reports existing bindings and unavailable context when app configuration is missing", async () => {
    const { actor } = createActors();
    const owner = actor();
    const installed = await fixture(owner);
    mockEnv("DISCORD_BOT_TOKEN", undefined);

    await expect(status(owner)).resolves.toMatchObject({
      isAvailable: false,
      isInstalled: true,
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
      isInstalled: true,
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
    { id: "123456789012345678", flags: -1 },
    { id: "123456789012345678", flags_new: "invalid" },
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

  it.each([401, 403, 429, 500])(
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

    await expect(status(owner)).resolves.toMatchObject({
      isInstalled: true,
      isConnected: false,
      discordUserId: null,
    });
    await expect(status(peer)).resolves.toMatchObject({
      isInstalled: true,
      isConnected: true,
      discordUserId: second.discordUserId,
    });
    await accept(
      client().disconnect({ headers: authenticate(owner), query: {} }),
      [404],
    );
    await expectDiscordChanges([owner.userId]);
  });

  it("requires the current admin role for uninstall and removes only that guild", async () => {
    const { actor, restore } = createActors();
    const owner = actor();
    await fixture(owner);
    const otherOwner = actor();
    const second = await fixture(otherOwner);
    mockDiscordMemberships(context, [
      { ...owner, orgRole: "org:member" },
      otherOwner,
    ]);

    await accept(
      client().disconnect({
        headers: authenticate(owner),
        query: { action: "uninstall" },
      }),
      [403],
    );
    await expectDiscordChanges([]);
    await expect(status(owner)).resolves.toMatchObject({ isInstalled: true });

    restore();
    await accept(
      client().disconnect({
        headers: authenticate(owner),
        query: { action: "uninstall" },
      }),
      [200],
    );
    await expectDiscordChanges([owner.userId]);
    await expect(status(owner)).resolves.toMatchObject({
      isAvailable: true,
      isInstalled: false,
      guildId: null,
    });
    await expect(status(otherOwner)).resolves.toMatchObject({
      isAvailable: true,
      isInstalled: true,
      guildId: second.guildId,
    });
  });

  it("notifies the uninstalling user, connected users, and cached admins once each", async () => {
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
      isInstalled: true,
      isConnected: false,
    });
    await expectDiscordChanges([]);

    await accept(
      client().disconnect({
        headers: authenticate(owner),
        query: { action: "uninstall" },
      }),
      [200],
    );
    const recipients = [
      owner.userId,
      connected.userId,
      unconnectedAdmin.userId,
    ];
    await expectDiscordChanges(recipients);
    await expect(status(connected)).resolves.toMatchObject({
      isInstalled: false,
      isConnected: false,
    });
    await expect(status(otherOwner)).resolves.toMatchObject({
      isInstalled: true,
      isConnected: true,
      guildId: otherInstalled.guildId,
    });

    await accept(
      client().disconnect({
        headers: authenticate(owner),
        query: { action: "uninstall" },
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
      isInstalled: false,
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
      randomUUID(),
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
