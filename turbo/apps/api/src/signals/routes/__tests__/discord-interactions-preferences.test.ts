import {
  generateKeyPairSync,
  randomBytes,
  randomUUID,
  sign,
} from "node:crypto";

import {
  discordInteractionsContract,
  type DiscordCommandInteraction,
  type DiscordComponentInteraction,
} from "@okouai/api-contracts/contracts/discord-interactions";
import { integrationsDiscordContract } from "@okouai/api-contracts/contracts/integrations-discord";
import { modelPoliciesMainContract } from "@okouai/api-contracts/contracts/model-policies";
import { modelProvidersMainContract } from "@okouai/api-contracts/contracts/model-provider-routes";
import { userModelPreferenceContract } from "@okouai/api-contracts/contracts/user-model-preference";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { http, HttpResponse } from "msw";
import { beforeEach, describe, expect, it, onTestFinished } from "vitest";
import { z } from "zod";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { mockEnv } from "../../../lib/env";
import { mockNow, now } from "../../../lib/time";
import { server } from "../../../mocks/server";
import { createDeferredPromise } from "../../utils";
import { discordInteractionsRoutes } from "../discord-interactions";
import { integrationsDiscordRoutes } from "../integrations-discord";
import { modelPoliciesRoutes } from "../model-policies";
import { modelProvidersRoutes } from "../model-providers";
import { userModelPreferenceRoutes } from "../user-model-preference";
import { createAuthOrgAgentsBddApi } from "./helpers/api-bdd-auth-org";
import {
  deleteDiscordFixture,
  mockDiscordMemberships,
  seedDiscordFixture,
  uniqueDiscordSnowflake,
} from "./helpers/discord";
import {
  deleteFeatureSwitchesForUser,
  updateFeatureSwitchesForUser,
} from "./helpers/feature-switches";

const context = testContext();
const accountApi = createAuthOrgAgentsBddApi(context);
const keys = generateKeyPairSync("ed25519");
const publicKey = keys.publicKey
  .export({ format: "der", type: "spki" })
  .subarray(-32)
  .toString("hex");
const applicationId = "1464000000000000101";

const messageComponentSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal(2),
    custom_id: z.string().max(100),
    label: z.string(),
  }),
  z.object({
    type: z.literal(3),
    custom_id: z.string().max(100),
    min_values: z.literal(1),
    max_values: z.literal(1),
    options: z
      .array(z.object({ label: z.string(), value: z.string() }))
      .max(25),
  }),
]);

const privateMessageSchema = z.object({
  content: z.string(),
  components: z.array(
    z.object({
      type: z.literal(1),
      components: z.array(messageComponentSchema),
    }),
  ),
  allowed_mentions: z.object({ parse: z.array(z.string()) }),
});

type PrivateMessage = z.infer<typeof privateMessageSchema>;

interface DiscordSender {
  readonly discordUserId: string;
  readonly channelId: string;
  readonly guildId?: string;
}

function actor(
  orgId = `org_discord_${randomUUID()}`,
  userId = `user_discord_${randomUUID()}`,
) {
  return {
    userId,
    orgId,
    orgRole: "org:admin" as const,
    email: `${randomUUID()}@example.test`,
  };
}

type Actor = ReturnType<typeof actor>;

async function enableDiscord(owner: Actor, enabled = true): Promise<void> {
  await updateFeatureSwitchesForUser(context, owner, {
    [FeatureSwitchKey.DiscordIntegration]: enabled,
  });
}

async function fixture(
  owner = actor(),
  discordUserId = uniqueDiscordSnowflake(),
) {
  mockDiscordMemberships(context, [owner]);
  const binding = await seedDiscordFixture(context, {
    userId: owner.userId,
    orgId: owner.orgId,
    orgRole: owner.orgRole,
    botUserId: applicationId,
    discordUserId,
    guildName: `Guild ${owner.orgId}`,
  });
  onTestFinished(async () => {
    mockDiscordMemberships(context, [owner]);
    await deleteDiscordFixture(context, binding);
    await deleteFeatureSwitchesForUser(context, owner);
  });
  await enableDiscord(owner);
  return { owner, binding, channelId: uniqueDiscordSnowflake() };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;

function guildSender(scope: Fixture): DiscordSender {
  return {
    discordUserId: scope.binding.discordUserId,
    guildId: scope.binding.guildId,
    channelId: scope.channelId,
  };
}

async function createAgent(
  owner: Actor,
  displayName: string | undefined,
  visibility: "public" | "private" = "private",
) {
  const agent = await accountApi.createAgent(owner, {
    ...(displayName !== undefined ? { displayName } : {}),
    visibility,
  });
  onTestFinished(async () => {
    await accountApi.deleteAgent(owner, agent.agentId);
  });
  return agent;
}

function commandPayload(
  sender: DiscordSender,
  name: DiscordCommandInteraction["data"]["options"][0]["name"],
): DiscordCommandInteraction {
  return {
    id: uniqueDiscordSnowflake(),
    application_id: applicationId,
    token: randomUUID(),
    type: 2,
    version: 1,
    channel_id: sender.channelId,
    ...(sender.guildId
      ? {
          guild_id: sender.guildId,
          member: { user: { id: sender.discordUserId } },
        }
      : { user: { id: sender.discordUserId } }),
    data: {
      id: uniqueDiscordSnowflake(),
      type: 1,
      name: "okou",
      options: [{ type: 1, name }],
    },
  };
}

function selectPayload(
  sender: DiscordSender,
  customId: string,
  value: string,
): DiscordComponentInteraction {
  return {
    ...commandPayload(sender, "switch"),
    type: 3,
    data: { component_type: 3, custom_id: customId, values: [value] },
  };
}

function buttonPayload(
  sender: DiscordSender,
  customId: string,
): DiscordComponentInteraction {
  return {
    ...commandPayload(sender, "switch"),
    type: 3,
    data: { component_type: 2, custom_id: customId },
  };
}

function selectMenu(message: PrivateMessage) {
  const component = message.components
    .flatMap((row) => {
      return row.components;
    })
    .find((entry) => {
      return entry.type === 3;
    });
  if (!component || component.type !== 3) {
    throw new Error(
      "Expected the private Discord response to contain a select menu",
    );
  }
  return component;
}

function pageButton(message: PrivateMessage, label: string) {
  const component = message.components
    .flatMap((row) => {
      return row.components;
    })
    .find((entry) => {
      return entry.type === 2 && entry.label === label;
    });
  if (!component || component.type !== 2) {
    throw new Error(`Expected a Discord ${label} button`);
  }
  return component;
}

function discordHttp(fixtures: readonly Fixture[], dm?: DiscordSender) {
  const byGuild = new Map(
    fixtures.map((scope) => {
      return [scope.binding.guildId, scope] as const;
    }),
  );
  const byChannel = new Map(
    fixtures.map((scope) => {
      return [scope.channelId, scope] as const;
    }),
  );
  const pending = new Map<
    string,
    {
      readonly channelId: string;
      readonly resolve: (message: PrivateMessage) => void;
    }
  >();
  const guildOwnerId = uniqueDiscordSnowflake();
  server.use(
    http.get("https://discord.com/api/v10/users/@me", () => {
      return HttpResponse.json({
        id: applicationId,
        username: "okou",
        bot: true,
      });
    }),
    http.get(
      "https://discord.com/api/v10/channels/:channelId",
      ({ params }) => {
        if (dm && params.channelId === dm.channelId) {
          return HttpResponse.json({
            id: dm.channelId,
            type: 1,
            recipients: [{ id: dm.discordUserId, username: "sender" }],
          });
        }
        const scope = byChannel.get(String(params.channelId));
        if (!scope) {
          return HttpResponse.json(
            { code: 10_003, message: "Unknown Channel" },
            { status: 404 },
          );
        }
        return HttpResponse.json({
          id: scope.channelId,
          type: 0,
          guild_id: scope.binding.guildId,
          permission_overwrites: [],
        });
      },
    ),
    http.get("https://discord.com/api/v10/guilds/:guildId", ({ params }) => {
      const scope = byGuild.get(String(params.guildId));
      if (!scope) {
        return HttpResponse.json(
          { code: 10_004, message: "Unknown Guild" },
          { status: 404 },
        );
      }
      return HttpResponse.json({
        id: scope.binding.guildId,
        name: "Test guild",
        owner_id: guildOwnerId,
      });
    }),
    http.get(
      "https://discord.com/api/v10/guilds/:guildId/roles",
      ({ params }) => {
        const scope = byGuild.get(String(params.guildId));
        if (!scope) {
          return HttpResponse.json(
            { code: 10_004, message: "Unknown Guild" },
            { status: 404 },
          );
        }
        return HttpResponse.json([
          {
            id: scope.binding.guildId,
            name: "@everyone",
            permissions: "68608",
            position: 0,
          },
        ]);
      },
    ),
    http.get(
      "https://discord.com/api/v10/guilds/:guildId/members/:userId",
      ({ params }) => {
        const scope = byGuild.get(String(params.guildId));
        const userId = String(params.userId);
        if (
          !scope ||
          (userId !== scope.binding.discordUserId && userId !== applicationId)
        ) {
          return HttpResponse.json(
            { code: 10_007, message: "Unknown Member" },
            { status: 404 },
          );
        }
        return HttpResponse.json({
          user: {
            id: userId,
            username: userId === applicationId ? "okou" : "sender",
            bot: userId === applicationId,
          },
          roles: [],
        });
      },
    ),
    http.post(
      "https://discord.com/api/v10/interactions/:id/:token/callback",
      async ({ request }) => {
        const callback: unknown = await request.json();
        expect(callback).toMatchObject({ type: 5, data: { flags: 64 } });
        return new HttpResponse(null, { status: 204 });
      },
    ),
    http.patch(
      "https://discord.com/api/v10/webhooks/:applicationId/:token/messages/@original",
      async ({ request, params }) => {
        const awaited = pending.get(String(params.token));
        if (!awaited) {
          throw new Error(
            "Received an interaction edit without an awaiting caller",
          );
        }
        const message = privateMessageSchema.parse(await request.json());
        pending.delete(String(params.token));
        awaited.resolve(message);
        return HttpResponse.json({
          id: uniqueDiscordSnowflake(),
          channel_id: awaited.channelId,
          author: { id: applicationId, username: "okou", bot: true },
          content: message.content,
          timestamp: new Date(now()).toISOString(),
          attachments: [],
        });
      },
    ),
  );
  return {
    async send(
      payload: DiscordCommandInteraction | DiscordComponentInteraction,
    ): Promise<PrivateMessage> {
      const delivered = createDeferredPromise<PrivateMessage>(context.signal);
      pending.set(payload.token, {
        channelId: payload.channel_id,
        resolve: delivered.resolve,
      });
      const body = JSON.stringify(payload);
      const timestamp = String(Math.floor(now() / 1000));
      const signature = sign(
        null,
        Buffer.from(`${timestamp}${body}`),
        keys.privateKey,
      ).toString("hex");
      await accept(
        setupApp({ context, routes: discordInteractionsRoutes })(
          discordInteractionsContract,
        ).post({
          body,
          headers: {
            "content-type": "application/json",
            "x-signature-timestamp": timestamp,
            "x-signature-ed25519": signature,
          },
        }),
        [202],
      );
      const message = await delivered.promise;
      expect(message.allowed_mentions.parse).toStrictEqual([]);
      return message;
    },
  };
}

async function readStatus(owner: Actor) {
  const response = await accept(
    setupApp({ context, routes: integrationsDiscordRoutes })(
      integrationsDiscordContract,
    ).getStatus({ headers: accountApi.authenticate(owner) }),
    [200],
  );
  return response.body;
}

async function disconnect(owner: Actor): Promise<void> {
  await accept(
    setupApp({ context, routes: integrationsDiscordRoutes })(
      integrationsDiscordContract,
    ).disconnect({
      headers: accountApi.authenticate(owner),
      query: { action: "disconnect" },
    }),
    [200],
  );
}

async function configureModelPreferences(scope: Fixture) {
  const headers = accountApi.authenticate(scope.owner);
  const providers = setupApp({ context, routes: modelProvidersRoutes })(
    modelProvidersMainContract,
  );
  const anthropic = await accept(
    providers.upsert({
      headers,
      body: {
        type: "anthropic-api-key",
        secret: "discord-test-anthropic-key",
      },
    }),
    [200, 201],
  );
  const openai = await accept(
    providers.upsert({
      headers,
      body: { type: "openai-api-key", secret: "discord-test-openai-key" },
    }),
    [200, 201],
  );
  const policies = setupApp({ context, routes: modelPoliciesRoutes })(
    modelPoliciesMainContract,
  );
  const initial = await accept(policies.list({ headers }), [200]);
  const defaultPolicy = {
    model: "claude-sonnet-5" as const,
    isDefault: true,
    defaultProviderType: "anthropic-api-key" as const,
    credentialScope: "org" as const,
    modelProviderId: anthropic.body.provider.id,
  };
  await accept(
    policies.update({
      headers,
      body: {
        revision: initial.body.revision,
        policies: [
          defaultPolicy,
          {
            model: "gpt-5.6-sol",
            isDefault: false,
            defaultProviderType: "openai-api-key",
            credentialScope: "org",
            modelProviderId: openai.body.provider.id,
          },
        ],
      },
    }),
    [200],
  );
  const preference = setupApp({ context, routes: userModelPreferenceRoutes })(
    userModelPreferenceContract,
  );
  return { headers, policies, preference, defaultPolicy };
}

beforeEach(() => {
  mockEnv("DISCORD_APPLICATION_ID", applicationId);
  mockEnv("DISCORD_PUBLIC_KEY", publicKey);
  mockEnv("DISCORD_BOT_TOKEN", randomBytes(32).toString("hex"));
  mockEnv("DISCORD_GATEWAY_SECRET", randomBytes(32).toString("hex"));
  accountApi.acceptAgentStorageWrites();
});

describe("Discord account preferences through private controls", () => {
  it("does not disconnect a configured account while the feature is disabled", async () => {
    const scope = await fixture();
    const discord = discordHttp([scope]);
    await enableDiscord(scope.owner, false);

    const message = await discord.send(
      commandPayload(guildSender(scope), "disconnect"),
    );

    expect(message.components).toStrictEqual([]);
    expect((await readStatus(scope.owner)).isAvailable).toBeFalsy();
    await enableDiscord(scope.owner);
    expect((await readStatus(scope.owner)).isConnected).toBeTruthy();
  });

  it("rejects a previously issued picker after its binding is revoked", async () => {
    const scope = await fixture();
    const agent = await createAgent(scope.owner, "Revoked binding agent");
    const discord = discordHttp([scope]);
    const sender = guildSender(scope);
    const menu = selectMenu(
      await discord.send(commandPayload(sender, "switch")),
    );
    expect(menu.options).toContainEqual({
      label: "Revoked binding agent",
      value: agent.agentId,
    });

    await disconnect(scope.owner);
    const rejected = await discord.send(
      selectPayload(sender, menu.custom_id, agent.agentId),
    );

    expect(rejected.content).toContain("onboarding is not available yet");
    expect(rejected.components).toStrictEqual([]);
    expect((await readStatus(scope.owner)).isConnected).toBeFalsy();
  });

  it("rechecks private-agent access and rejects a forged selection from a real picker", async () => {
    const scope = await fixture();
    const otherOwner = actor(scope.owner.orgId);
    mockDiscordMemberships(context, [scope.owner, otherOwner]);
    const baseline = await createAgent(scope.owner, "Kept preference");
    const shared = await createAgent(
      otherOwner,
      "Formerly shared agent",
      "public",
    );
    const hidden = await createAgent(otherOwner, "Never shared agent");
    const discord = discordHttp([scope]);
    const sender = guildSender(scope);
    const menu = selectMenu(
      await discord.send(commandPayload(sender, "switch")),
    );
    expect(
      menu.options.map((option) => {
        return option.value;
      }),
    ).toContain(shared.agentId);
    expect(
      menu.options.map((option) => {
        return option.value;
      }),
    ).not.toContain(hidden.agentId);
    await discord.send(selectPayload(sender, menu.custom_id, baseline.agentId));

    await accountApi.updateAgentMetadata(otherOwner, shared.agentId, {
      visibility: "private",
    });
    const revoked = await discord.send(
      selectPayload(sender, menu.custom_id, shared.agentId),
    );
    const forged = await discord.send(
      selectPayload(sender, menu.custom_id, hidden.agentId),
    );

    expect(revoked.content).toContain("no longer have access to that agent");
    expect(forged.content).toContain("no longer have access to that agent");
    const connected = await discord.send(commandPayload(sender, "connect"));
    expect(connected.content).toContain("Current agent: Kept preference.");
  });

  it.each(["sender", "channel", "expired"] as const)(
    "rejects a signed control with changed %s context",
    async (changed) => {
      const scope = await fixture();
      const original = await createAgent(scope.owner, "Original agent");
      const attempted = await createAgent(scope.owner, "Attempted agent");
      const discord = discordHttp([scope]);
      const sender = guildSender(scope);
      const menu = selectMenu(
        await discord.send(commandPayload(sender, "switch")),
      );
      await discord.send(
        selectPayload(sender, menu.custom_id, original.agentId),
      );
      const moved = {
        ...sender,
        ...(changed === "sender"
          ? { discordUserId: uniqueDiscordSnowflake() }
          : {}),
        ...(changed === "channel"
          ? { channelId: uniqueDiscordSnowflake() }
          : {}),
      };
      if (changed === "expired") {
        mockNow(now() + 15 * 60 * 1000);
      }

      const rejected = await discord.send(
        selectPayload(moved, menu.custom_id, attempted.agentId),
      );

      expect(rejected.content).toContain("expired or your access has changed");
      const connected = await discord.send(commandPayload(sender, "connect"));
      expect(connected.content).toContain("Current agent: Original agent.");
    },
  );

  it("disconnects only the invoked workspace and exposes that change through status", async () => {
    const first = await fixture();
    const second = await fixture(
      actor(undefined, first.owner.userId),
      first.binding.discordUserId,
    );
    mockDiscordMemberships(context, [first.owner, second.owner]);
    const discord = discordHttp([first, second]);

    const message = await discord.send(
      commandPayload(guildSender(first), "disconnect"),
    );

    expect(message.content).toContain("disconnected from this workspace");
    expect((await readStatus(first.owner)).isConnected).toBeFalsy();
    expect((await readStatus(second.owner)).isConnected).toBeTruthy();
  });

  it("requires and saves an explicit workspace choice for a sender with multiple DM bindings", async () => {
    const first = await fixture();
    const second = await fixture(
      actor(undefined, first.owner.userId),
      first.binding.discordUserId,
    );
    mockDiscordMemberships(context, [first.owner, second.owner]);
    const firstAgent = await createAgent(first.owner, "First workspace agent");
    const secondAgent = await createAgent(
      second.owner,
      "Second workspace agent",
    );
    const sender = {
      discordUserId: first.binding.discordUserId,
      channelId: uniqueDiscordSnowflake(),
    };
    const discord = discordHttp([first, second], sender);

    const undecided = await discord.send(commandPayload(sender, "switch"));
    const choice = selectMenu(undecided);
    expect(undecided.content).toContain("Choose your workspace for bot DMs");
    expect(
      new Set(
        choice.options.map((option) => {
          return option.value;
        }),
      ),
    ).toStrictEqual(
      new Set([first.binding.connectionId, second.binding.connectionId]),
    );
    expect((await readStatus(first.owner)).dmSelectionConnectionId).toBeNull();

    const selected = await discord.send(
      selectPayload(sender, choice.custom_id, second.binding.connectionId),
    );

    expect(selected.content).toContain("Workspace selected for bot DMs");
    expect((await readStatus(second.owner)).dmSelectionConnectionId).toBe(
      second.binding.connectionId,
    );
    const agents = selectMenu(
      await discord.send(commandPayload(sender, "switch")),
    );
    const values = agents.options.map((option) => {
      return option.value;
    });
    expect(values).toContain(secondAgent.agentId);
    expect(values).not.toContain(firstAgent.agentId);
  });

  it.each([
    { kind: "unset", displayName: undefined },
    { kind: "empty", displayName: "" },
    { kind: "long Unicode", displayName: "🚀".repeat(100) },
  ])(
    "renders $kind agent names within Discord limits",
    async ({ displayName }) => {
      const scope = await fixture();
      const agent = await createAgent(scope.owner, displayName);
      const discord = discordHttp([scope]);
      const sender = guildSender(scope);
      const menu = selectMenu(
        await discord.send(commandPayload(sender, "switch")),
      );
      const option = menu.options.find((entry) => {
        return entry.value === agent.agentId;
      });
      if (!option) {
        throw new Error("Expected the agent to remain selectable");
      }
      expect(option.label.length).toBeGreaterThan(0);
      expect(option.label.length).toBeLessThanOrEqual(100);
      expect(Buffer.from(option.label).toString("utf8")).toBe(option.label);
      const selected = await discord.send(
        selectPayload(sender, menu.custom_id, option.value),
      );
      expect(selected.content).toContain(
        "Agent selected for new Discord conversations",
      );
      expect(selected.content.length).toBeLessThanOrEqual(2000);
      const connected = await discord.send(commandPayload(sender, "connect"));
      expect(connected.content).toContain("Current agent:");
      expect(connected.content.length).toBeLessThanOrEqual(2000);
    },
  );

  it("paginates more than 25 agents and saves a selection from the later page", async () => {
    const scope = await fixture();
    const agents = [];
    for (let index = 0; index < 26; index++) {
      agents.push(await createAgent(scope.owner, `Agent ${index + 1}`));
    }
    const discord = discordHttp([scope]);
    const sender = guildSender(scope);

    const firstPage = await discord.send(commandPayload(sender, "switch"));
    const firstMenu = selectMenu(firstPage);
    expect(firstMenu.options).toHaveLength(25);
    const next = pageButton(firstPage, "Next");
    const secondPage = await discord.send(
      buttonPayload(sender, next.custom_id),
    );
    const secondMenu = selectMenu(secondPage);
    expect(secondPage.content).toContain("Page 2 of 2");
    expect(
      pageButton(secondPage, "Previous").custom_id.length,
    ).toBeLessThanOrEqual(100);
    const allValues = [...firstMenu.options, ...secondMenu.options]
      .map((option) => {
        return option.value;
      })
      .filter((value) => {
        return value !== "default";
      });
    expect(new Set(allValues)).toStrictEqual(
      new Set(
        agents.map((agent) => {
          return agent.agentId;
        }),
      ),
    );
    const option = secondMenu.options.find((entry) => {
      return entry.value !== "default";
    });
    if (!option) {
      throw new Error("Expected a selectable agent on the second page");
    }

    const selected = await discord.send(
      selectPayload(sender, secondMenu.custom_id, option.value),
    );

    expect(selected.content).toContain(
      `Agent selected for new Discord conversations: ${option.label}.`,
    );
    const connected = await discord.send(commandPayload(sender, "connect"));
    expect(connected.content).toContain(`Current agent: ${option.label}.`);
  });

  it("rechecks model policy after a picker is issued and preserves the current allowed preference", async () => {
    const scope = await fixture();
    const { headers, policies, preference, defaultPolicy } =
      await configureModelPreferences(scope);
    const discord = discordHttp([scope]);
    const sender = guildSender(scope);
    const menu = selectMenu(
      await discord.send(commandPayload(sender, "model")),
    );
    expect(
      menu.options.map((option) => {
        return option.value;
      }),
    ).toContain("gpt-5.6-sol");
    const selected = await discord.send(
      selectPayload(sender, menu.custom_id, "gpt-5.6-sol"),
    );
    expect(selected.content).toContain("Model selected for new conversations");
    const before = await accept(preference.get({ headers }), [200]);
    expect(before.body.selectedModel).toBe("gpt-5.6-sol");
    const current = await accept(policies.list({ headers }), [200]);
    await accept(
      policies.update({
        headers,
        body: { revision: current.body.revision, policies: [defaultPolicy] },
      }),
      [200],
    );

    const rejected = await discord.send(
      selectPayload(sender, menu.custom_id, "gpt-5.6-sol"),
    );

    expect(rejected.content).toContain("no longer have access to that model");
    const after = await accept(preference.get({ headers }), [200]);
    expect(after.body.selectedModel).toBe("claude-sonnet-5");
  });
  it.each([
    "disconnect",
    "feature",
    "model policy",
    "disconnect after binding read",
  ] as const)(
    "rejects a model selection revoked by %s during access revalidation",
    async (revocation) => {
      const scope = await fixture();
      const { headers, policies, preference, defaultPolicy } =
        await configureModelPreferences(scope);
      const discord = discordHttp([scope]);
      const sender = guildSender(scope);
      const menu = selectMenu(
        await discord.send(commandPayload(sender, "model")),
      );
      await discord.send(
        selectPayload(sender, menu.custom_id, "claude-sonnet-5"),
      );
      const reached = createDeferredPromise<void>(context.signal);
      const release = createDeferredPromise<void>(context.signal);
      let channelChecks = 0;
      let holdMembership = false;
      const membership =
        context.mocks.clerk.organizations.getOrganizationMembershipList;
      const membershipResponse = membership.getMockImplementation();
      if (!membershipResponse) {
        throw new Error("Expected the fixture's Clerk membership response");
      }
      membership.mockImplementation(async (...args) => {
        const response = await membershipResponse(...args);
        if (holdMembership) {
          holdMembership = false;
          reached.resolve();
          await release.promise;
        }
        return response;
      });
      server.use(
        http.get(
          `https://discord.com/api/v10/channels/${scope.channelId}`,
          async () => {
            channelChecks++;
            if (channelChecks === 2) {
              if (revocation === "disconnect after binding read") {
                holdMembership = true;
              } else {
                reached.resolve();
                await release.promise;
              }
            }
            return HttpResponse.json({
              id: scope.channelId,
              type: 0,
              guild_id: scope.binding.guildId,
              permission_overwrites: [],
            });
          },
        ),
      );
      const pending = discord.send(
        selectPayload(sender, menu.custom_id, "gpt-5.6-sol"),
      );
      await reached.promise;
      if (
        revocation === "disconnect" ||
        revocation === "disconnect after binding read"
      ) {
        await disconnect(scope.owner);
      } else if (revocation === "feature") {
        await enableDiscord(scope.owner, false);
      } else {
        const current = await accept(policies.list({ headers }), [200]);
        await accept(
          policies.update({
            headers,
            body: {
              revision: current.body.revision,
              policies: [defaultPolicy],
            },
          }),
          [200],
        );
      }
      release.resolve();
      const rejected = await pending;
      expect(rejected.content).not.toContain(
        "Model selected for new conversations",
      );
      expect(rejected.components).toStrictEqual([]);
      const after = await accept(preference.get({ headers }), [200]);
      expect(after.body.selectedModel).toBe("claude-sonnet-5");
    },
  );
});
