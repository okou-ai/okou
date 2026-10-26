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
import { http, HttpResponse } from "msw";
import { beforeEach, describe, expect, it, onTestFinished } from "vitest";
import { z } from "zod";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { mockEnv } from "../../../lib/env";
import { mockNow, now } from "../../../lib/time";
import { server } from "../../../mocks/server";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { discordInteractionsRoutes } from "../discord-interactions";
import { integrationsDiscordRoutes } from "../integrations-discord";

import { createAuthOrgAgentsBddApi } from "./helpers/api-bdd-auth-org";
import {
  removePublicDiscordBinding,
  mockDiscordApplication,
  mockDiscordMemberships,
  createPublicDiscordBinding,
  uniqueDiscordSnowflake,
} from "./helpers/discord";
import { DISCORD_TEST_APPLICATION_ID } from "./helpers/discord-fixture";

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
    custom_id: z.string().max(100).optional(),
    url: z.url().optional(),
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

async function fixture(
  owner = actor(),
  discordUserId = uniqueDiscordSnowflake(),
) {
  mockDiscordMemberships(context, [owner]);
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

function guildSender(scope: Fixture): DiscordSender {
  return {
    discordUserId: scope.binding.discordUserId,
    guildId: scope.binding.guildId,
    channelId: scope.channelId,
  };
}

function commandPayload(
  sender: DiscordSender,
  name: DiscordCommandInteraction["data"]["name"],
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
      name,
    },
  };
}

function selectPayload(
  sender: DiscordSender,
  customId: string,
  value: string,
): DiscordComponentInteraction {
  return {
    ...commandPayload(sender, "connect"),
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
      query: {},
    }),
    [200],
  );
}

beforeEach(() => {
  mockEnv("DISCORD_APPLICATION_ID", applicationId);
  mockEnv("DISCORD_PUBLIC_KEY", publicKey);
  mockEnv("DISCORD_BOT_TOKEN", randomBytes(32).toString("hex"));
  mockEnv("DISCORD_GATEWAY_SECRET", randomBytes(32).toString("hex"));
  mockDiscordApplication(0);
  accountApi.acceptAgentStorageWrites();
});

describe("Discord account preferences through private controls", () => {
  it("disconnects only the invoked workspace and exposes that change through status", async () => {
    const first = await fixture();
    const second = await fixture(
      actor(undefined, first.owner.userId),
      first.binding.discordUserId,
    );
    mockDiscordMemberships(context, [first.owner, second.owner]);
    const discord = discordHttp([first, second]);
    const sender = guildSender(first);
    const menu = selectMenu(
      await discord.send(commandPayload(sender, "connect")),
    );
    await discord.send(
      selectPayload(sender, menu.custom_id, first.binding.connectionId),
    );

    const message = await discord.send(commandPayload(sender, "disconnect"));

    expect(message.content).toContain("disconnected from this workspace");
    expect((await readStatus(first.owner)).isConnected).toBeFalsy();
    expect((await readStatus(second.owner)).isConnected).toBeTruthy();
  });

  it.each(["server", "DM"])(
    "shows the account connection status in a %s with one workspace",
    async (surface) => {
      const scope = await fixture();
      const sender = {
        discordUserId: scope.binding.discordUserId,
        channelId: scope.channelId,
        ...(surface === "server" ? { guildId: scope.binding.guildId } : {}),
      };
      const discord = discordHttp(
        [scope],
        surface === "DM" ? sender : undefined,
      );
      const message = await discord.send(commandPayload(sender, "connect"));

      expect(message.content).toContain("You are already connected to Okou.");
      expect(message.components).toStrictEqual([]);
    },
  );

  it.each(["DM", "guild"] as const)(
    "requires and saves an explicit workspace choice in a %s",
    async (surface) => {
      const first = await fixture();
      const second = await fixture(
        actor(undefined, first.owner.userId),
        first.binding.discordUserId,
      );
      mockDiscordMemberships(context, [first.owner, second.owner]);
      const sender =
        surface === "guild"
          ? guildSender(first)
          : {
              discordUserId: first.binding.discordUserId,
              channelId: uniqueDiscordSnowflake(),
            };
      const discord = discordHttp(
        [first, second],
        surface === "DM" ? sender : undefined,
      );

      const undecided = await discord.send(commandPayload(sender, "connect"));
      const choice = selectMenu(undecided);
      expect(undecided.content).toContain("Choose your workspace for Discord");
      expect(
        new Set(
          choice.options.map((option) => {
            return option.value;
          }),
        ),
      ).toStrictEqual(
        new Set([first.binding.connectionId, second.binding.connectionId]),
      );
      expect(
        (await readStatus(first.owner)).dmSelectionConnectionId,
      ).toBeNull();

      const selected = await discord.send(
        selectPayload(sender, choice.custom_id, second.binding.connectionId),
      );

      expect(selected.content).toContain("Workspace selected for Discord");
      expect((await readStatus(second.owner)).dmSelectionConnectionId).toBe(
        second.binding.connectionId,
      );
      expect(
        preselected(await discord.send(commandPayload(sender, "connect"))),
      ).toStrictEqual([second.binding.connectionId]);
    },
  );

  it.each([
    "sender",
    "channel",
    "expired",
    "disconnect",
    "membership",
  ] as const)(
    "keeps the selected DM workspace when an org control changes %s authority",
    async (changed) => {
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
      const menu = selectMenu(
        await discord.send(commandPayload(sender, "connect")),
      );
      await discord.send(
        selectPayload(sender, menu.custom_id, first.binding.connectionId),
      );
      if (changed === "disconnect") {
        await disconnect(second.owner);
      } else if (changed === "membership") {
        mockDiscordMemberships(context, [first.owner]);
      } else if (changed === "expired") {
        mockNow(now() + 15 * 60 * 1000);
      }
      const moved = {
        ...sender,
        ...(changed === "sender"
          ? { discordUserId: uniqueDiscordSnowflake() }
          : {}),
        ...(changed === "channel"
          ? { channelId: uniqueDiscordSnowflake() }
          : {}),
      };
      const rejected = await discord.send(
        selectPayload(moved, menu.custom_id, second.binding.connectionId),
      );

      expect(rejected.content).toContain("expired or your access has changed");
      expect((await readStatus(first.owner)).dmSelectionConnectionId).toBe(
        first.binding.connectionId,
      );
    },
  );

  it("preselects the selected DM workspace", async () => {
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
    const workspaces = await discord.send(commandPayload(sender, "connect"));
    expect(preselected(workspaces)).toStrictEqual([]);
    await discord.send(
      selectPayload(
        sender,
        selectMenu(workspaces).custom_id,
        first.binding.connectionId,
      ),
    );
    expect(
      preselected(await discord.send(commandPayload(sender, "connect"))),
    ).toStrictEqual([first.binding.connectionId]);
  });
});
