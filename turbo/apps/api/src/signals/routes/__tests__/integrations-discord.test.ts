import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { integrationsDiscordContract } from "@okouai/api-contracts/contracts/integrations-discord";
import { testDiscordStateContract } from "@okouai/api-contracts/contracts/test-discord-state";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp, setupRawAppRequest } from "../../../__tests__/test-helpers";
import { mockEnv, mockOptionalEnv } from "../../../lib/env";
import { discordStatePreviewRoutes } from "../discord-state-preview";
import { integrationsDiscordRoutes } from "../integrations-discord";
import {
  configureDiscordApp,
  deleteDiscordFixture,
  mockDiscordMemberships,
  seedDiscordFixture,
  uniqueDiscordSnowflake,
  type DiscordActor,
  type DiscordFixture,
} from "./helpers/discord";
import { updateFeatureSwitchesForUser } from "./helpers/feature-switches";
import { createFixtureTracker, createRouteMocks } from "./helpers/route-test";
import { createBddApi } from "./helpers/api-bdd";

const context = testContext();
const track = createFixtureTracker((fixture: DiscordFixture) => {
  return deleteDiscordFixture(context, fixture);
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

function fixturesClient() {
  return setupApp({ context, routes: discordStatePreviewRoutes })(
    testDiscordStateContract,
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
  > = {},
): Promise<DiscordFixture> {
  await enable(value);
  return await track(seedDiscordFixture(context, { ...value, ...options }));
}

async function status(value: DiscordActor) {
  return (
    await accept(client().getStatus({ headers: authenticate(value) }), [200])
  ).body;
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
    await accept(
      client().setAgentPreference({ headers: {}, body: { agentId: null } }),
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
  });

  it("keeps configured bindings unavailable until their owner enables the feature", async () => {
    const { actor } = createActors();
    const owner = actor();
    await track(seedDiscordFixture(context, owner));

    await expect(status(owner)).resolves.toMatchObject({
      isAvailable: false,
      isInstalled: false,
      isConnected: false,
      guildId: null,
      discordUserId: null,
      contextMode: "unavailable",
      onboarding: "oauth_deferred",
      dmBindings: [],
    });
    await accept(
      client().disconnect({ headers: authenticate(owner), query: {} }),
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
      onboarding: "oauth_deferred",
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
      onboarding: "oauth_deferred",
      dmSelectionConnectionId: null,
      dmBindings: [
        {
          connectionId: installed.connectionId,
          guildId: installed.guildId,
          guildName: "Customer workspace",
        },
      ],
    });
    mockEnv("DISCORD_MESSAGE_CONTENT_ENABLED", "true");
    await expect(status(owner)).resolves.toMatchObject({ contextMode: "full" });
  });

  it("disconnects only the caller while preserving the guild and another verified user", async () => {
    const { actor } = createActors();
    const owner = actor();
    const first = await fixture(owner);
    const peer = actor({ orgId: owner.orgId });
    const second = await fixture(peer, { guildId: first.guildId });

    await accept(
      client().disconnect({ headers: authenticate(owner), query: {} }),
      [200],
    );

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
    await expect(status(owner)).resolves.toMatchObject({ isInstalled: true });

    restore();
    await accept(
      client().disconnect({
        headers: authenticate(owner),
        query: { action: "uninstall" },
      }),
      [200],
    );
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
    await expect(status(firstOwner)).resolves.toMatchObject({
      dmSelectionConnectionId: second.connectionId,
    });

    await accept(
      client().disconnect({ headers: authenticate(secondOwner), query: {} }),
      [200],
    );
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
  });

  it("rejects DM selections for another Discord sender or another Okou user", async () => {
    const { actor } = createActors();
    const owner = actor();
    const current = await fixture(owner);
    const differentSender = actor({ userId: owner.userId });
    const wrongSenderBinding = await fixture(differentSender);
    const differentUser = actor();
    const wrongUserBinding = await fixture(differentUser, {
      discordUserId: current.discordUserId,
    });

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
    expect((await status(owner)).dmBindings).toStrictEqual([
      {
        connectionId: current.connectionId,
        guildId: current.guildId,
        guildName: current.guildName,
      },
    ]);
  });

  it("selects only accessible agents and restores the organization default on reset", async () => {
    const { actor } = createActors();
    const owner = actor();
    await fixture(owner);
    const api = createBddApi(context);
    api.acceptAgentStorageWrites();
    const ownerProfile = api.user(owner);
    const defaultAgentId = await api.bootstrapLimitedFreeOnboarding(
      ownerProfile,
      { displayName: "Workspace default" },
    );
    const ownAgent = await api.createAgent(ownerProfile, {
      visibility: "private",
      displayName: "Personal Discord agent",
    });
    const peer = actor({ orgId: owner.orgId });
    const peerProfile = api.user(peer);
    const privateAgent = await api.createAgent(peerProfile, {
      visibility: "private",
      displayName: "Peer private agent",
    });
    const outsider = actor();
    const outsideProfile = api.user(outsider);
    const outsideAgent = await api.createAgent(outsideProfile, {
      visibility: "public",
      displayName: "Different workspace agent",
    });

    for (const agentId of [
      privateAgent.agentId,
      outsideAgent.agentId,
      randomUUID(),
    ]) {
      await accept(
        client().setAgentPreference({
          headers: authenticate(owner),
          body: { agentId },
        }),
        [404],
      );
    }
    await accept(
      client().setAgentPreference({
        headers: authenticate(owner),
        body: { agentId: ownAgent.agentId },
      }),
      [200],
    );
    await expect(status(owner)).resolves.toMatchObject({
      defaultAgentId: ownAgent.agentId,
      defaultAgentName: "Personal Discord agent",
    });

    await accept(
      client().setAgentPreference({
        headers: authenticate(owner),
        body: { agentId: null },
      }),
      [200],
    );
    await expect(status(owner)).resolves.toMatchObject({ defaultAgentId });

    await api.deleteAgent(ownerProfile, ownAgent.agentId);
    await api.deleteAgent(peerProfile, privateAgent.agentId);
    await api.deleteAgent(outsideProfile, outsideAgent.agentId);
  });
});

describe("guarded verified Discord fixtures", () => {
  function body() {
    return {
      guildId: uniqueDiscordSnowflake(),
      guildName: "Fixture guild",
      botUserId: "123456789012345678",
      discordUserId: uniqueDiscordSnowflake(),
    };
  }

  it("is unavailable in production even for an authenticated admin", async () => {
    const { actor } = createActors();
    const owner = actor();
    const headers = authenticate(owner);
    const requestBody = body();
    mockEnv("ENV", "production");
    mockOptionalEnv("VERCEL_ENV", "production");

    const provision = await accept(
      fixturesClient().post({ headers, body: requestBody }),
      [404],
    );
    const remove = await accept(
      fixturesClient().delete({
        headers,
        query: { guildId: requestBody.guildId },
      }),
      [404],
    );
    expect([provision.status, remove.status]).toStrictEqual([404, 404]);
  });

  it("requires an authenticated admin in development", async () => {
    context.mocks.clerk.authenticateRequest.mockResolvedValue({
      isAuthenticated: false,
    });
    const anonymous = await accept(
      fixturesClient().post({ headers: {}, body: body() }),
      [401],
    );
    const { actor } = createActors();
    const member = actor({ orgRole: "org:member" });
    const requestBody = body();
    const headers = authenticate(member);
    const provision = await accept(
      fixturesClient().post({ headers, body: requestBody }),
      [403],
    );
    const remove = await accept(
      fixturesClient().delete({
        headers,
        query: { guildId: requestBody.guildId },
      }),
      [403],
    );
    expect([anonymous.status, provision.status, remove.status]).toStrictEqual([
      401, 403, 403,
    ]);
  });

  it("rejects supplied Okou identity fields and conflicting guild ownership", async () => {
    const { actor } = createActors();
    const owner = actor();
    const installed = await fixture(owner);
    const stranger = actor();
    const headers = authenticate(stranger);
    await accept(
      fixturesClient().post({
        headers,
        body: {
          guildId: installed.guildId,
          guildName: installed.guildName,
          botUserId: installed.botUserId,
          discordUserId: installed.discordUserId,
        },
      }),
      [409],
    );
    const forged = await setupRawAppRequest({
      context,
      routes: discordStatePreviewRoutes,
    })("/api/test/discord-state", {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({
        ...body(),
        orgId: owner.orgId,
        userId: owner.userId,
      }),
    });
    expect(forged.status).toBe(400);
    await expect(status(owner)).resolves.toMatchObject({
      isInstalled: true,
      guildId: installed.guildId,
      discordUserId: installed.discordUserId,
    });
  });

  it("converges repeated concurrent provisioning on the same verified connection", async () => {
    const { actor } = createActors();
    const owner = actor();
    await enable(owner);
    const headers = authenticate(owner);
    const requestBody = body();
    const [first, second] = await Promise.all([
      accept(fixturesClient().post({ headers, body: requestBody }), [200]),
      accept(fixturesClient().post({ headers, body: requestBody }), [200]),
    ]);
    await track(
      Promise.resolve({
        ...owner,
        ...requestBody,
        connectionId: first.body.connectionId,
      }),
    );

    expect(first.body.connectionId).toBe(second.body.connectionId);
    expect((await status(owner)).dmBindings).toStrictEqual([
      {
        connectionId: first.body.connectionId,
        guildId: requestBody.guildId,
        guildName: requestBody.guildName,
      },
    ]);
  });

  it("allows only one guild to win concurrent installation for an organization", async () => {
    const { actor } = createActors();
    const owner = actor();
    await enable(owner);
    const headers = authenticate(owner);
    const firstBody = body();
    const secondBody = body();
    const results = await Promise.all([
      accept(fixturesClient().post({ headers, body: firstBody }), [200, 409]),
      accept(fixturesClient().post({ headers, body: secondBody }), [200, 409]),
    ]);
    expect(
      results
        .map((result) => {
          return result.status;
        })
        .sort(),
    ).toStrictEqual([200, 409]);
    const winner =
      results[0]?.status === 200
        ? { response: results[0], request: firstBody }
        : { response: results[1], request: secondBody };
    if (winner.response?.status !== 200) {
      throw new Error("Expected one successful guild installation");
    }
    await track(
      Promise.resolve({
        ...owner,
        ...winner.request,
        connectionId: winner.response.body.connectionId,
      }),
    );
    await expect(status(owner)).resolves.toMatchObject({
      guildId: winner.request.guildId,
      discordUserId: winner.request.discordUserId,
    });
  });

  it("scopes fixture deletion to the authenticated organization", async () => {
    const { actor } = createActors();
    const owner = actor();
    const installed = await fixture(owner);
    const otherOwner = actor();

    await accept(
      fixturesClient().delete({
        headers: authenticate(otherOwner),
        query: { guildId: installed.guildId },
      }),
      [200],
    );
    await expect(status(owner)).resolves.toMatchObject({
      isInstalled: true,
      isConnected: true,
      guildId: installed.guildId,
    });
  });
});
