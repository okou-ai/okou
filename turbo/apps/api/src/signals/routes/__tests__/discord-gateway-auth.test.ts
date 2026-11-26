import { createHmac } from "node:crypto";
import {
  DISCORD_GATEWAY_SIGNATURE_HEADER,
  DISCORD_GATEWAY_TIMESTAMP_HEADER,
  discordGatewayContract,
  type DiscordGatewayEnvelope,
} from "@okouai/api-contracts/contracts/discord-gateway";
import { describe, expect, it } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp, setupRawAppRequest } from "../../../__tests__/test-helpers";
import { env } from "../../../lib/env";
import { now } from "../../../lib/time";
import { discordGatewayRoutes } from "../discord-gateway";
import { configureDiscordApp, uniqueDiscordSnowflake } from "./helpers/discord";

const context = testContext();

/** Configures the Discord app and returns its Gateway identity. */
function configuredGateway() {
  configureDiscordApp();
  const applicationId = env("DISCORD_APPLICATION_ID");
  const secret = env("DISCORD_GATEWAY_SECRET");
  if (!applicationId || !secret) {
    throw new Error("Expected the Discord Gateway to be configured");
  }
  return { applicationId, secret };
}

/** Headers the Gateway signs over `<timestamp>.<body>` with the shared secret. */
function gatewayHeaders(secret: string, body: string) {
  const timestamp = Math.floor(now() / 1000).toString();
  return {
    [DISCORD_GATEWAY_TIMESTAMP_HEADER]: timestamp,
    [DISCORD_GATEWAY_SIGNATURE_HEADER]: createHmac("sha256", secret)
      .update(`${timestamp}.${body}`)
      .digest("hex"),
  };
}

async function submitMessage(overrides: Readonly<Record<string, unknown>>) {
  const { applicationId, secret } = configuredGateway();
  const messageId = uniqueDiscordSnowflake();
  const envelope: DiscordGatewayEnvelope = {
    version: 1,
    applicationId,
    eventType: "MESSAGE_CREATE",
    eventId: `MESSAGE_CREATE:${messageId}`,
    payload: {
      id: messageId,
      channel_id: uniqueDiscordSnowflake(),
      guild_id: uniqueDiscordSnowflake(),
      author: { id: uniqueDiscordSnowflake(), username: "member" },
      content: "hello",
      mentions: [],
      attachments: [],
      timestamp: new Date(now()).toISOString(),
      type: 0,
      ...overrides,
    },
  };
  const response = await accept(
    setupApp({ context, routes: discordGatewayRoutes })(
      discordGatewayContract,
    ).post({
      headers: gatewayHeaders(secret, JSON.stringify(envelope)),
      body: envelope,
    }),
    [200],
  );
  return response.body;
}

const UNSUPPORTED_MESSAGE = Object.freeze({
  ok: true,
  outcome: "ignored",
  reason: "unsupported-message",
});

describe("Discord Gateway authentication and ignored transport events", () => {
  it("discord-gateway-auth-003 rejects a signed event whose bytes changed after signing", async () => {
    const { applicationId, secret } = configuredGateway();
    const signedBody = JSON.stringify({
      version: 1,
      applicationId,
      eventType: "GUILD_DELETE",
      eventId: `GUILD_DELETE:${uniqueDiscordSnowflake()}`,
      payload: { id: uniqueDiscordSnowflake(), unavailable: true },
    });

    const response = await setupRawAppRequest({
      context,
      routes: discordGatewayRoutes,
    })("/api/internal/discord/gateway", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...gatewayHeaders(secret, signedBody),
      },
      body: `${signedBody}\n`,
    });

    expect(response.status).toBe(401);
  });

  it("discord-gateway-auth-011 ignores a message from a bot author", async () => {
    await expect(
      submitMessage({
        author: { id: "333333333333333333", username: "bot", bot: true },
      }),
    ).resolves.toMatchObject(UNSUPPORTED_MESSAGE);
  });

  it("discord-gateway-auth-012 ignores a message from a webhook producer", async () => {
    await expect(
      submitMessage({ webhook_id: "444444444444444444" }),
    ).resolves.toMatchObject(UNSUPPORTED_MESSAGE);
  });

  it("discord-gateway-auth-013 ignores an edited message", async () => {
    await expect(
      submitMessage({ edited_timestamp: "2026-09-24T00:00:00Z" }),
    ).resolves.toMatchObject(UNSUPPORTED_MESSAGE);
  });

  it("discord-gateway-auth-014 ignores a message of Discord type 6", async () => {
    await expect(submitMessage({ type: 6 })).resolves.toMatchObject(
      UNSUPPORTED_MESSAGE,
    );
  });
});
