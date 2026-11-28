import { generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { discordInteractionsContract } from "@okouai/api-contracts/contracts/discord-interactions";
import { integrationsDiscordContract } from "@okouai/api-contracts/contracts/integrations-discord";
import { http, HttpResponse } from "msw";
import { describe, expect, it } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { env, mockEnv } from "../../../lib/env";
import { now } from "../../../lib/time";
import { server } from "../../../mocks/server";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { discordInteractionsRoutes } from "../discord-interactions";
import { integrationsDiscordRoutes } from "../integrations-discord";
import { createAuthOrgBddApi } from "./helpers/api-bdd-auth-org";
import { mockDiscordProvider } from "./helpers/discord-fixture";
import { createRouteMocks } from "./helpers/route-test";
import {
  configureDiscordApp,
  createPublicDiscordBinding,
  mockDiscordMemberships,
  uniqueDiscordSnowflake,
} from "./helpers/discord";

const context = testContext();
const authOrg = createAuthOrgBddApi(context);

/** A provisioned workspace whose admin installs Okou in a Discord server. */
async function linkedWorkspace() {
  const userId = `user_${randomUUID()}`;
  const orgId = `org_${randomUUID()}`;
  await authOrg.provisionWorkspace(
    authOrg.user({ userId, orgId, orgRole: "org:admin" }),
  );
  mockDiscordMemberships(context, [{ userId, orgId, orgRole: "org:admin" }]);
  return await createPublicDiscordBinding(context, {
    orgId,
    userId,
    orgRole: "org:admin",
    flow: "install",
  });
}

/** Discord app with a generated Ed25519 key; private replies are captured. */
function configureDiscordInteractions() {
  configureDiscordApp();
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  mockEnv(
    "DISCORD_PUBLIC_KEY",
    publicKey
      .export({ format: "der", type: "spki" })
      .subarray(-32)
      .toString("hex"),
  );
  const applicationId = env("DISCORD_APPLICATION_ID");
  if (!applicationId) {
    throw new Error("Expected the Discord application to be configured");
  }
  const replies: unknown[] = [];
  server.use(
    http.post(
      "https://discord.com/api/v10/interactions/:interactionId/:token/callback",
      () => {
        return new HttpResponse(null, { status: 204 });
      },
    ),
    http.patch(
      `https://discord.com/api/v10/webhooks/${applicationId}/:token/messages/@original`,
      async ({ request }) => {
        const body: unknown = await request.json();
        replies.push(body);
        return HttpResponse.json({
          id: uniqueDiscordSnowflake(),
          channel_id: uniqueDiscordSnowflake(),
          author: { id: applicationId, username: "Okou", bot: true },
          content: "",
          timestamp: new Date(now()).toISOString(),
          attachments: [],
        });
      },
    ),
  );

  async function post(interaction: Readonly<Record<string, unknown>>) {
    const body = JSON.stringify(interaction);
    const timestamp = String(Math.floor(now() / 1000));
    const signature = sign(
      null,
      Buffer.from(`${timestamp}${body}`, "utf8"),
      privateKey,
    ).toString("hex");
    await accept(
      setupApp({ context, routes: discordInteractionsRoutes })(
        discordInteractionsContract,
      ).post({
        body,
        headers: {
          "content-type": "application/json",
          "x-signature-ed25519": signature,
          "x-signature-timestamp": timestamp,
        },
      }),
      [202],
    );
    await flushWaitUntilForTest();
    return replies.at(-1);
  }

  function slashCommand(
    name: "connect" | "disconnect",
    sender: {
      readonly discordUserId: string;
      readonly channelId: string;
      readonly guildId?: string;
    },
  ) {
    const user = { id: sender.discordUserId };
    return {
      id: uniqueDiscordSnowflake(),
      application_id: applicationId,
      token: `interaction-token-${randomUUID()}`,
      version: 1,
      channel_id: sender.channelId,
      ...(sender.guildId
        ? { guild_id: sender.guildId, member: { user } }
        : { user }),
      type: 2,
      data: { id: uniqueDiscordSnowflake(), type: 1, name },
    };
  }

  return { post, slashCommand };
}

const STALE_CONTROL =
  "This control has expired or your access has changed. Run the command again.";

/** One Okou user linked to two workspaces through the same Discord identity. */
async function twoLinkedWorkspaces() {
  const userId = `user_${randomUUID()}`;
  const discordUserId = uniqueDiscordSnowflake();
  const firstActor = {
    userId,
    orgId: `org_${randomUUID()}`,
    orgRole: "org:admin" as const,
  };
  const secondActor = {
    userId,
    orgId: `org_${randomUUID()}`,
    orgRole: "org:admin" as const,
  };
  const actors = [firstActor, secondActor];
  for (const actor of actors) {
    await authOrg.provisionWorkspace(authOrg.user(actor));
  }
  mockDiscordMemberships(context, actors);
  const first = await createPublicDiscordBinding(context, {
    ...firstActor,
    flow: "install",
    discordUserId,
  });
  const second = await createPublicDiscordBinding(context, {
    ...secondActor,
    flow: "install",
    discordUserId,
  });
  return { first, second, provider: mockDiscordProvider(first) };
}

async function discordStatus(actor: { userId: string; orgId: string }) {
  createRouteMocks(context).clerk.session(actor.userId, actor.orgId);
  const response = await accept(
    setupApp({ context, routes: integrationsDiscordRoutes })(
      integrationsDiscordContract,
    ).getStatus({ headers: { authorization: "Bearer clerk-session" } }),
    [200],
  );
  return response.body;
}

interface WorkspaceMenu {
  readonly customId: string;
  readonly options: readonly { value: string; default?: boolean }[];
}

function workspaceMenu(reply: unknown): WorkspaceMenu {
  if (
    typeof reply === "object" &&
    reply !== null &&
    "components" in reply &&
    Array.isArray(reply.components)
  ) {
    const [row]: unknown[] = reply.components;
    if (
      typeof row === "object" &&
      row !== null &&
      "components" in row &&
      Array.isArray(row.components)
    ) {
      const [menu]: unknown[] = row.components;
      if (
        typeof menu === "object" &&
        menu !== null &&
        "custom_id" in menu &&
        typeof menu.custom_id === "string" &&
        "options" in menu &&
        Array.isArray(menu.options)
      ) {
        return { customId: menu.custom_id, options: menu.options };
      }
    }
  }
  throw new Error(`Expected a workspace menu, got ${JSON.stringify(reply)}`);
}

function optionValues(menu: WorkspaceMenu): string[] {
  return menu.options
    .map((option) => {
      return option.value;
    })
    .sort();
}

function defaultValues(menu: WorkspaceMenu): string[] {
  return menu.options.flatMap((option) => {
    return option.default ? [option.value] : [];
  });
}

/** Two linked workspaces and the menu returned by `/connect` from a DM or guild. */
async function workspaceChoice(where: "dm" | "guild") {
  const discord = configureDiscordInteractions();
  const { first, second, provider } = await twoLinkedWorkspaces();
  const sender =
    where === "dm"
      ? { discordUserId: first.discordUserId, channelId: provider.dmChannelId }
      : {
          discordUserId: first.discordUserId,
          channelId: provider.guildChannelId,
          guildId: first.guildId,
        };
  const command = discord.slashCommand("connect", sender);
  const picker = await discord.post(command);
  return {
    discord,
    first,
    second,
    sender,
    command,
    picker,
    menu: workspaceMenu(picker),
  };
}

/** The menu choice Discord submits from the same channel as the command. */
function menuChoice(
  command: Readonly<Record<string, unknown>>,
  customId: string,
  value: string,
) {
  return {
    ...command,
    id: uniqueDiscordSnowflake(),
    token: `interaction-token-${randomUUID()}`,
    type: 3,
    data: { component_type: 3, custom_id: customId, values: [value] },
  };
}

describe("Discord account preferences through private controls", () => {
  it("discord-interactions-preferences-002 tells a member linked to one workspace that they are already connected", async () => {
    const discord = configureDiscordInteractions();
    const binding = await linkedWorkspace();
    const provider = mockDiscordProvider(binding);

    const reply = await discord.post(
      discord.slashCommand("connect", {
        discordUserId: binding.discordUserId,
        channelId: provider.guildChannelId,
        guildId: binding.guildId,
      }),
    );

    expect(reply).toMatchObject({
      content: expect.stringContaining("You are already connected to Okou."),
    });
    expect(reply).not.toHaveProperty("components.0");
  });

  it("discord-interactions-preferences-004 (1/3) asks a DM sender to choose between both workspaces", async () => {
    const { first, second, menu, picker } = await workspaceChoice("dm");

    expect(picker).toMatchObject({
      content: expect.stringContaining("Choose your workspace for Discord."),
    });
    expect(optionValues(menu)).toStrictEqual(
      [first.connectionId, second.connectionId].sort(),
    );
    expect(defaultValues(menu)).toStrictEqual([]);
    await expect(discordStatus(second)).resolves.toMatchObject({
      dmSelectionConnectionId: null,
    });
  });

  it("discord-interactions-preferences-004 (2/3) saves the second workspace chosen from a DM", async () => {
    const { discord, second, menu, command } = await workspaceChoice("dm");

    const selected = await discord.post(
      menuChoice(command, menu.customId, second.connectionId),
    );

    expect(selected).toMatchObject({
      content: expect.stringContaining("Workspace selected for Discord."),
    });
    await expect(discordStatus(second)).resolves.toMatchObject({
      dmSelectionConnectionId: second.connectionId,
    });
  });

  it("discord-interactions-preferences-004 (3/3) preselects the saved workspace in the next DM menu", async () => {
    const { discord, second, menu, command, sender } =
      await workspaceChoice("dm");
    await discord.post(menuChoice(command, menu.customId, second.connectionId));

    const again = workspaceMenu(
      await discord.post(discord.slashCommand("connect", sender)),
    );

    expect(defaultValues(again)).toStrictEqual([second.connectionId]);
  });

  it("discord-interactions-preferences-005 (1/3) asks a guild sender to choose between both workspaces", async () => {
    const { first, second, menu, picker } = await workspaceChoice("guild");

    expect(picker).toMatchObject({
      content: expect.stringContaining("Choose your workspace for Discord."),
    });
    expect(optionValues(menu)).toStrictEqual(
      [first.connectionId, second.connectionId].sort(),
    );
    expect(defaultValues(menu)).toStrictEqual([]);
    await expect(discordStatus(second)).resolves.toMatchObject({
      dmSelectionConnectionId: null,
    });
  });

  it("discord-interactions-preferences-005 (2/3) saves the second workspace chosen from a guild", async () => {
    const { discord, second, menu, command } = await workspaceChoice("guild");

    const selected = await discord.post(
      menuChoice(command, menu.customId, second.connectionId),
    );

    expect(selected).toMatchObject({
      content: expect.stringContaining("Workspace selected for Discord."),
    });
    await expect(discordStatus(second)).resolves.toMatchObject({
      dmSelectionConnectionId: second.connectionId,
    });
  });

  it("discord-interactions-preferences-005 (3/3) preselects the saved workspace in the next guild menu", async () => {
    const { discord, second, menu, command, sender } =
      await workspaceChoice("guild");
    await discord.post(menuChoice(command, menu.customId, second.connectionId));

    const again = workspaceMenu(
      await discord.post(discord.slashCommand("connect", sender)),
    );

    expect(defaultValues(again)).toStrictEqual([second.connectionId]);
  });

  it("discord-interactions-preferences-001 disconnects only the selected workspace", async () => {
    const { discord, first, second, menu, command, sender } =
      await workspaceChoice("dm");
    await discord.post(menuChoice(command, menu.customId, first.connectionId));

    const reply = await discord.post(
      discord.slashCommand("disconnect", sender),
    );

    expect(reply).toMatchObject({
      content: expect.stringContaining(
        "You have been disconnected from this workspace",
      ),
    });
    await expect(discordStatus(first)).resolves.toMatchObject({
      isConnected: false,
    });
    await expect(discordStatus(second)).resolves.toMatchObject({
      isConnected: true,
    });
  });

  it("discord-interactions-preferences-006 keeps the saved DM workspace when another sender submits the control", async () => {
    const { discord, first, second, menu, command } =
      await workspaceChoice("dm");
    await discord.post(menuChoice(command, menu.customId, first.connectionId));

    const reply = await discord.post({
      ...menuChoice(command, menu.customId, second.connectionId),
      user: { id: uniqueDiscordSnowflake() },
    });

    expect(reply).toMatchObject({ content: STALE_CONTROL });
    await expect(discordStatus(first)).resolves.toMatchObject({
      dmSelectionConnectionId: first.connectionId,
    });
  });

  it("discord-interactions-preferences-010 keeps the saved DM workspace after the user leaves the other workspace", async () => {
    const { discord, first, second, menu, command } =
      await workspaceChoice("dm");
    await discord.post(menuChoice(command, menu.customId, first.connectionId));
    mockDiscordMemberships(context, [
      { userId: first.userId, orgId: first.orgId, orgRole: "org:admin" },
    ]);

    const reply = await discord.post(
      menuChoice(command, menu.customId, second.connectionId),
    );

    expect(reply).toMatchObject({ content: STALE_CONTROL });
    await expect(discordStatus(first)).resolves.toMatchObject({
      dmSelectionConnectionId: first.connectionId,
    });
  });
});
