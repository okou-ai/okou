import { generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { discordInteractionsContract } from "@okouai/api-contracts/contracts/discord-interactions";
import { http, HttpResponse } from "msw";
import { describe, expect, it } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { env, mockEnv } from "../../../lib/env";
import { now } from "../../../lib/time";
import { server } from "../../../mocks/server";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { discordInteractionsRoutes } from "../discord-interactions";
import { configureDiscordApp, uniqueDiscordSnowflake } from "./helpers/discord";

const context = testContext();

const STALE_CONTROL =
  "This control has expired or your access has changed. Run the command again.";

interface DiscordCallback {
  readonly interactionId: string;
  readonly body: unknown;
}

interface DiscordReply {
  readonly interactionToken: string;
  readonly body: unknown;
}

/**
 * Configures the Discord app with a freshly generated Ed25519 key pair and
 * stands in for Discord's interaction callback and original-response APIs.
 * Discord accepts one callback per interaction and answers repeats with
 * error 40060.
 */
function configureDiscordInteractions() {
  configureDiscordApp();
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const rawPublicKey = publicKey
    .export({ format: "der", type: "spki" })
    .subarray(-32);
  mockEnv("DISCORD_PUBLIC_KEY", rawPublicKey.toString("hex"));
  const applicationId = env("DISCORD_APPLICATION_ID");
  if (!applicationId) {
    throw new Error("Expected the Discord application to be configured");
  }

  const callbacks: DiscordCallback[] = [];
  const replies: DiscordReply[] = [];
  server.use(
    http.post(
      "https://discord.com/api/v10/interactions/:interactionId/:token/callback",
      async ({ request, params }) => {
        const interactionId = String(params.interactionId);
        const acknowledged = callbacks.some((callback) => {
          return callback.interactionId === interactionId;
        });
        callbacks.push({ interactionId, body: await request.json() });
        if (acknowledged) {
          return HttpResponse.json(
            {
              code: 40_060,
              message: "Interaction has already been acknowledged.",
            },
            { status: 400 },
          );
        }
        return new HttpResponse(null, { status: 204 });
      },
    ),
    http.patch(
      `https://discord.com/api/v10/webhooks/${applicationId}/:token/messages/@original`,
      async ({ request, params }) => {
        const body: unknown = await request.json();
        replies.push({ interactionToken: String(params.token), body });
        const content =
          typeof body === "object" && body !== null && "content" in body
            ? String(body.content)
            : "";
        return HttpResponse.json({
          id: uniqueDiscordSnowflake(),
          channel_id: uniqueDiscordSnowflake(),
          author: { id: applicationId, username: "Okou", bot: true },
          content,
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
    const response = await accept(
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
    return response;
  }

  function invocation(
    sender: { readonly guildId?: string },
    payload: Readonly<Record<string, unknown>>,
  ) {
    const user = { id: uniqueDiscordSnowflake() };
    return {
      id: uniqueDiscordSnowflake(),
      application_id: applicationId,
      token: `interaction-token-${randomUUID()}`,
      version: 1,
      channel_id: uniqueDiscordSnowflake(),
      ...(sender.guildId
        ? { guild_id: sender.guildId, member: { user } }
        : { user }),
      ...payload,
    };
  }

  function slashCommand(
    name: "help" | "connect" | "disconnect",
    sender: { readonly guildId?: string } = {},
  ) {
    return invocation(sender, {
      type: 2,
      data: { id: uniqueDiscordSnowflake(), type: 1, name },
    });
  }

  return { callbacks, replies, post, invocation, slashCommand };
}

function connectGuidance(guildId?: string) {
  const url = new URL("/settings/discord", env("APP_URL"));
  if (guildId) {
    url.searchParams.set("guild_id", guildId);
  }
  return {
    content: "Please connect your account to use Okou from Discord.",
    components: [
      {
        type: 1,
        components: [
          { type: 2, style: 5, label: "Connect", url: url.toString() },
        ],
      },
    ],
  };
}

describe("Discord private account interactions", () => {
  it("discord-interactions-001 acknowledges /help once, replies privately, and ignores a replay", async () => {
    const discord = configureDiscordInteractions();
    const help = discord.slashCommand("help");

    await discord.post(help);
    await discord.post(help);

    expect(discord.callbacks[0]).toStrictEqual({
      interactionId: help.id,
      body: { type: 5, data: { flags: 64 } },
    });
    expect(discord.replies).toHaveLength(1);
    expect(discord.replies[0]?.interactionToken).toBe(help.token);
    const reply = discord.replies[0]?.body;
    expect(reply).toMatchObject({ allowed_mentions: { parse: [] } });
    const content =
      typeof reply === "object" && reply !== null && "content" in reply
        ? String(reply.content)
        : "";
    expect(content).toContain("/disconnect");
    expect(content).toContain("Commands");
    expect(content).toContain("Usage");
  });

  it("discord-interactions-002 guides an unlinked sender to connect after /connect", async () => {
    const discord = configureDiscordInteractions();

    const command = discord.slashCommand("connect");

    await discord.post(command);

    expect(discord.callbacks).toStrictEqual([
      { interactionId: command.id, body: { type: 5, data: { flags: 64 } } },
    ]);
    expect(discord.replies).toHaveLength(1);
    expect(discord.replies[0]?.body).toMatchObject(connectGuidance());
  });

  it("discord-interactions-003 guides an unlinked sender to connect after /disconnect", async () => {
    const discord = configureDiscordInteractions();

    const command = discord.slashCommand("disconnect");

    await discord.post(command);

    expect(discord.callbacks).toStrictEqual([
      { interactionId: command.id, body: { type: 5, data: { flags: 64 } } },
    ]);
    expect(discord.replies).toHaveLength(1);
    expect(discord.replies[0]?.body).toMatchObject(connectGuidance());
  });

  it("discord-interactions-004 links a server /connect directly to setup for that server", async () => {
    const discord = configureDiscordInteractions();
    const guildId = uniqueDiscordSnowflake();
    const connect = discord.slashCommand("connect", { guildId });

    await discord.post(connect);

    expect(discord.callbacks).toStrictEqual([
      { interactionId: connect.id, body: { type: 5, data: { flags: 64 } } },
    ]);
    expect(discord.replies).toHaveLength(1);
    expect(discord.replies[0]?.body).toMatchObject(connectGuidance(guildId));
  });

  it("discord-interactions-005 clears a forged picker without changing any account", async () => {
    const discord = configureDiscordInteractions();
    const expiresAt = (Math.floor(now() / 1000) + 600).toString(36);
    const picker = discord.invocation(
      {},
      {
        type: 3,
        data: {
          component_type: 3,
          custom_id: `okou:1:org:0:${expiresAt}:-:${"A".repeat(22)}`,
          values: [randomUUID()],
        },
      },
    );

    await discord.post(picker);

    expect(discord.callbacks).toStrictEqual([
      { interactionId: picker.id, body: { type: 6 } },
    ]);
    expect(discord.replies).toHaveLength(1);
    expect(discord.replies[0]?.body).toMatchObject({
      content: STALE_CONTROL,
      components: [],
    });
  });
});
