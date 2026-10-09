import { createBddIntegrationApi } from "./helpers/api-bdd-integrations";
import { createMiscRoutesApi } from "./helpers/api-bdd-misc";
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

import { userModelPreferenceContract } from "@okouai/api-contracts/contracts/user-model-preference";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { http, HttpResponse } from "msw";
import { beforeEach, describe, expect, it, onTestFinished } from "vitest";
import { z } from "zod";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { mockEnv } from "../../../lib/env";
import {
  clearMockMonotonicNow,
  mockMonotonicNow,
  mockNow,
  now,
} from "../../../lib/time";
import { server } from "../../../mocks/server";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { createRunsApi } from "./helpers/api-bdd-runs";
import { discordInteractionsRoutes } from "../discord-interactions";
import { integrationsDiscordRoutes } from "../integrations-discord";

import { userModelPreferenceRoutes } from "../user-model-preference";
import { createAuthOrgAgentsBddApi } from "./helpers/api-bdd-auth-org";
import { createChatFilesBddApi } from "./helpers/api-bdd-chat-files";
import {
  removePublicDiscordBinding,
  mockDiscordMemberships,
  createPublicDiscordBinding,
  uniqueDiscordSnowflake,
} from "./helpers/discord";
import {
  DISCORD_TEST_APPLICATION_ID,
  discordChatThreads,
  discordMessageForTest,
  mockDiscordProvider,
  postDiscordMessage,
  setupConnectedDiscordActor,
} from "./helpers/discord-fixture";
import { createWebhookCallbackApi } from "./helpers/api-bdd-webhooks";
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
const applicationId = DISCORD_TEST_APPLICATION_ID;

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
      .array(
        z.object({
          label: z.string(),
          value: z.string(),
          default: z.literal(true).optional(),
        }),
      )
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
  await enableDiscord(owner);
  const binding = await createPublicDiscordBinding(context, {
    flow: "install",
    userId: owner.userId,
    orgId: owner.orgId,
    orgRole: owner.orgRole,
    botUserId: applicationId,
    discordUserId,
    guildName: `Guild ${owner.orgId}`,
  });
  onTestFinished(async () => {
    mockDiscordMemberships(context, [owner]);
    await removePublicDiscordBinding(context, binding);
    await deleteFeatureSwitchesForUser(context, owner);
  });
  return {
    owner,
    binding,
    channelId: uniqueDiscordSnowflake(),
  };
}

type Fixture = Awaited<ReturnType<typeof fixture>> & {
  readonly parentChannelId?: string;
};

async function routedModelFixture(owner = actor()) {
  const connected = await setupConnectedDiscordActor(context, {
    userId: owner.userId,
    orgId: owner.orgId,
  });
  // The Gateway fixture configures the bot; this suite owns interaction signing.
  mockEnv("DISCORD_PUBLIC_KEY", publicKey);
  onTestFinished(async () => {
    mockDiscordMemberships(context, [owner]);
    await removePublicDiscordBinding(context, connected.fixture);
    await deleteFeatureSwitchesForUser(context, owner);
  });
  const { headers, preference } = await configureModelPreferences({ owner });
  await accept(
    preference.update({
      headers,
      body: { selectedModel: "claude-fable-5-1", serviceTier: null },
    }),
    [200],
  );
  const provider = mockDiscordProvider(connected);
  const message = discordMessageForTest(connected, {
    channelId: provider.guildChannelId,
    content: `<@${connected.botUserId}> Start the routed model picker thread`,
  });
  provider.messages.set(message.id, message);
  await postDiscordMessage(context, message);
  await flushWaitUntilForTest();
  const [thread] = await discordChatThreads(context, connected);
  if (!thread) {
    throw new Error(
      "Expected Gateway admission to create the Discord conversation",
    );
  }
  const chat = createChatFilesBddApi(context);
  const { events } = await chat.listThreadEvents(connected.actor, thread.id);
  const input = events.find((event) => {
    return event.eventType === "input.prompt" && event.runId !== undefined;
  });
  if (!input?.runId) {
    throw new Error("Expected the Discord conversation to admit a Run");
  }
  const runs = createRunsApi(context);
  await runs.heartbeatRunner(connected.runnerGroup);
  const claim = await runs.claimRunnerJob(input.runId);
  await createWebhookCallbackApi(context).requestAgentComplete(
    {
      runId: input.runId,
      exitCode: 1,
      error: "The task could not be completed",
    },
    { authorization: `Bearer ${claim.sandboxToken}` },
    [200],
  );
  await flushWaitUntilForTest();
  await accept(
    preference.update({
      headers,
      body: { selectedModel: null, serviceTier: null },
    }),
    [200],
  );
  return {
    owner,
    binding: connected.fixture,
    channelId: message.id,
    parentChannelId: provider.guildChannelId,
    threadId: thread.id,
  };
}

function guildSender(scope: Fixture): DiscordSender {
  return {
    discordUserId: scope.binding.discordUserId,
    guildId: scope.binding.guildId,
    channelId: scope.channelId,
  };
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
    ...commandPayload(sender, "model"),
    type: 3,
    data: { component_type: 3, custom_id: customId, values: [value] },
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

function preselected(message: PrivateMessage): string[] {
  return selectMenu(message)
    .options.filter((option) => {
      return option.default;
    })
    .map((option) => {
      return option.value;
    });
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
  const messages = new Map<string, PrivateMessage>();
  const channels = new Map<string, string>();
  const callbacks = new Map<string, unknown>();
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
        const scope =
          byChannel.get(String(params.channelId)) ??
          fixtures.find((value) => {
            return value.parentChannelId === String(params.channelId);
          });
        if (!scope) {
          return HttpResponse.json(
            { code: 10_003, message: "Unknown Channel" },
            { status: 404 },
          );
        }
        return HttpResponse.json({
          id: String(params.channelId),
          type:
            scope.parentChannelId && params.channelId === scope.channelId
              ? 11
              : 0,
          ...(scope.parentChannelId && params.channelId === scope.channelId
            ? {
                parent_id: scope.parentChannelId,
                thread_metadata: {
                  archived: false,
                  locked: false,
                  auto_archive_duration: 60,
                  archive_timestamp: new Date(now()).toISOString(),
                },
              }
            : {}),
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
            permissions: "274877975552",
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
      async ({ request, params }) => {
        callbacks.set(String(params.token), await request.json());
        return new HttpResponse(null, { status: 204 });
      },
    ),
    http.patch(
      "https://discord.com/api/v10/webhooks/:applicationId/:token/messages/@original",
      async ({ request, params }) => {
        const message = privateMessageSchema.parse(await request.json());
        messages.set(String(params.token), message);
        return HttpResponse.json({
          id: uniqueDiscordSnowflake(),
          channel_id: channels.get(String(params.token)),
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
      channels.set(payload.token, payload.channel_id);
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
      await flushWaitUntilForTest();
      const message = messages.get(payload.token);
      if (!message) {
        throw new Error(
          "Expected Discord to edit the acknowledged interaction",
        );
      }
      expect(message.allowed_mentions.parse).toStrictEqual([]);
      // Discord shows a private loading reply for a command, while a
      // component update later edits the message holding that component.
      expect(callbacks.get(payload.token)).toStrictEqual(
        payload.type === 3 ? { type: 6 } : { type: 5, data: { flags: 64 } },
      );
      return message;
    },
    callbacks,
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

async function configureModelPreferences(scope: Pick<Fixture, "owner">) {
  await createRunsApi(context).grantProEntitlement(scope.owner);
  await createBddIntegrationApi(context).configureNativeSubscriptionModels(
    scope.owner,
  );
  const headers = accountApi.authenticate(scope.owner);
  const preference = setupApp({ context, routes: userModelPreferenceRoutes })(
    userModelPreferenceContract,
  );
  await accept(
    preference.update({
      headers,
      body: { selectedModel: null, serviceTier: null },
    }),
    [200],
  );
  return { headers, preference };
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
    const sender = {
      discordUserId: first.binding.discordUserId,
      channelId: uniqueDiscordSnowflake(),
    };
    const discord = discordHttp([first, second], sender);

    const undecided = await discord.send(commandPayload(sender, "org"));
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
    expect(
      preselected(await discord.send(commandPayload(sender, "org"))),
    ).toStrictEqual([second.binding.connectionId]);
  });

  it("preselects the effective model and the selected DM workspace", async () => {
    const first = await fixture();
    const second = await fixture(
      actor(undefined, first.owner.userId),
      first.binding.discordUserId,
    );
    mockDiscordMemberships(context, [first.owner, second.owner]);
    await configureModelPreferences(first);
    const sender = {
      discordUserId: first.binding.discordUserId,
      channelId: uniqueDiscordSnowflake(),
    };
    const discord = discordHttp([first, second], sender);
    const workspaces = await discord.send(commandPayload(sender, "org"));
    expect(preselected(workspaces)).toStrictEqual([]);
    await discord.send(
      selectPayload(
        sender,
        selectMenu(workspaces).custom_id,
        first.binding.connectionId,
      ),
    );
    expect(
      preselected(await discord.send(commandPayload(sender, "org"))),
    ).toStrictEqual([first.binding.connectionId]);

    const models = await discord.send(commandPayload(sender, "model"));
    expect(models.content).toContain("existing Okou conversation");
    expect(models.components).toStrictEqual([]);
  });

  it("switches the routed server thread the model picker runs in", async () => {
    const owner = actor();
    mockDiscordMemberships(context, [owner]);
    const { headers, preference } = await configureModelPreferences({ owner });
    const chat = createChatFilesBddApi(context);
    const scope = await routedModelFixture(owner);
    const thread = { id: scope.threadId };
    const discord = discordHttp([scope]);
    const sender = guildSender(scope);

    const menu = selectMenu(
      await discord.send(commandPayload(sender, "model")),
    );
    const selected = await discord.send(
      selectPayload(sender, menu.custom_id, "gpt-6-astra"),
    );

    expect(selected.content).toContain("Model selected for this conversation");
    const after = await accept(preference.get({ headers }), [200]);
    expect(after.body.selectedModel).toBe("auto");
    expect(
      (await chat.readThreadMetadata(owner, thread.id)).selectedModel,
    ).toBe("gpt-6-astra");
    const threadEvents = await chat.requestThreadEvents(owner, {}, [200]);
    if (threadEvents.status !== 200) {
      throw new Error("Expected Discord thread events to load");
    }
    expect(threadEvents.body.events).toContainEqual(
      expect.objectContaining({
        kind: "model_selection_updated",
        chatThreadId: thread.id,
        selectedModel: "gpt-6-astra",
      }),
    );
  });

  it("switches the routed server thread to canonical Auto", async () => {
    const owner = actor();
    mockDiscordMemberships(context, [owner]);
    await configureModelPreferences({ owner });
    const chat = createChatFilesBddApi(context);
    const scope = await routedModelFixture(owner);
    const thread = { id: scope.threadId };
    const discord = discordHttp([scope]);
    const sender = guildSender(scope);

    const menu = selectMenu(
      await discord.send(commandPayload(sender, "model")),
    );
    expect(menu.options).toContainEqual(
      expect.objectContaining({ label: "Auto", value: "auto" }),
    );
    const selected = await discord.send(
      selectPayload(sender, menu.custom_id, "auto"),
    );

    expect(selected.content).toContain(
      "Model selected for this conversation: Auto.",
    );
    expect(
      (await chat.readThreadMetadata(owner, thread.id)).selectedModel,
    ).toBe("auto");
    expect(
      preselected(await discord.send(commandPayload(sender, "model"))),
    ).toStrictEqual(["auto"]);
  });

  it("rechecks personal subscription access after a picker is issued without changing the member preference", async () => {
    const scope = await routedModelFixture();
    const { headers, preference } = await configureModelPreferences(scope);
    const discord = discordHttp([scope]);
    const sender = guildSender(scope);
    const menu = selectMenu(
      await discord.send(commandPayload(sender, "model")),
    );
    expect(
      menu.options.map((option) => {
        return option.value;
      }),
    ).toContain("gpt-6-astra");
    const selected = await discord.send(
      selectPayload(sender, menu.custom_id, "gpt-6-astra"),
    );
    expect(selected.content).toContain("Model selected for this conversation");
    const before = await accept(preference.get({ headers }), [200]);
    expect(before.body.selectedModel).toBe("auto");

    await createMiscRoutesApi(context).deletePersonalModelProvider(
      scope.owner,
      "codex-oauth-token",
      [204],
    );

    const rejected = await discord.send(
      selectPayload(sender, menu.custom_id, "gpt-6-astra"),
    );

    expect(rejected.content).toContain("no longer have access to that model");
    // The thread keeps its unavailable personal model; no option, including
    // Auto, is presented as the conversation's current model.
    expect(
      preselected(await discord.send(commandPayload(sender, "model"))),
    ).toStrictEqual([]);
    const after = await accept(preference.get({ headers }), [200]);
    expect(after.body.selectedModel).toBe("auto");
  });
  it.each(["sender", "channel", "expired"] as const)(
    "rejects a signed control with changed %s context",
    async (changed) => {
      const scope = await routedModelFixture();
      const { headers, preference } = await configureModelPreferences(scope);
      const discord = discordHttp([scope]);
      const sender = guildSender(scope);
      const menu = selectMenu(
        await discord.send(commandPayload(sender, "model")),
      );
      await discord.send(
        selectPayload(sender, menu.custom_id, "claude-fable-5-1"),
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
        selectPayload(moved, menu.custom_id, "gpt-6-astra"),
      );

      expect(rejected.content).toContain("expired or your access has changed");
      const after = await accept(preference.get({ headers }), [200]);
      expect(after.body.selectedModel).toBe("auto");
    },
  );

  it("applies no selection when Discord's acknowledgement is uncertain", async () => {
    const scope = await routedModelFixture();
    await configureModelPreferences(scope);
    const discord = discordHttp([scope]);
    const sender = guildSender(scope);
    const menu = selectMenu(
      await discord.send(commandPayload(sender, "model")),
    );
    await discord.send(
      selectPayload(sender, menu.custom_id, "claude-fable-5-1"),
    );
    mockMonotonicNow(0);
    onTestFinished(clearMockMonotonicNow);
    server.use(
      http.post(
        "https://discord.com/api/v10/interactions/:id/:token/callback",
        async ({ request, params }) => {
          discord.callbacks.set(String(params.token), await request.json());
          // Discord's 3-second response window closes before the edit.
          mockMonotonicNow(10_000);
          return HttpResponse.json({ message: "Unavailable" }, { status: 503 });
        },
        { once: true },
      ),
    );

    const notice = await discord.send(
      selectPayload(sender, menu.custom_id, "gpt-6-astra"),
    );

    expect(notice.content).toContain("no changes were made");
    expect(notice.components).toStrictEqual([]);
    const reopened = await discord.send(commandPayload(sender, "model"));
    expect(preselected(reopened)).toStrictEqual(["claude-fable-5-1"]);
  });

  it.each([
    "disconnect",
    "feature",
    "subscription disconnect",
    "disconnect after binding read",
  ] as const)(
    "rejects a model selection revoked by %s during access revalidation",
    async (revocation) => {
      const scope = await routedModelFixture();
      const { headers, preference } = await configureModelPreferences(scope);
      const discord = discordHttp([scope]);
      const sender = guildSender(scope);
      const menu = selectMenu(
        await discord.send(commandPayload(sender, "model")),
      );
      await discord.send(
        selectPayload(sender, menu.custom_id, "claude-fable-5-1"),
      );
      let channelChecks = 0;
      let revokeAtMembership = false;
      let revoked = false;
      async function revokeAccess() {
        revoked = true;
        if (
          revocation === "disconnect" ||
          revocation === "disconnect after binding read"
        ) {
          await disconnect(scope.owner);
        } else if (revocation === "feature") {
          await enableDiscord(scope.owner, false);
        } else {
          await createMiscRoutesApi(context).deletePersonalModelProvider(
            scope.owner,
            "codex-oauth-token",
            [204],
          );
        }
      }
      const membership =
        context.mocks.clerk.organizations.getOrganizationMembershipList;
      const membershipResponse = membership.getMockImplementation();
      if (!membershipResponse) {
        throw new Error("Expected the fixture's Clerk membership response");
      }
      membership.mockImplementation(async (...args) => {
        const response = await membershipResponse(...args);
        if (revokeAtMembership) {
          revokeAtMembership = false;
          await revokeAccess();
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
                revokeAtMembership = true;
              } else {
                await revokeAccess();
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
      const rejected = await discord.send(
        selectPayload(sender, menu.custom_id, "gpt-6-astra"),
      );
      expect(revoked).toBeTruthy();
      expect(rejected.content).not.toContain(
        "Model selected for this conversation",
      );
      expect(rejected.components).toStrictEqual([]);
      const after = await accept(preference.get({ headers }), [200]);
      expect(after.body.selectedModel).toBe("auto");
    },
  );
});
