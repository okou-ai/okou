import { createHmac, randomBytes } from "node:crypto";
import {
  DISCORD_GATEWAY_AUTH_TEST_VECTORS,
  DISCORD_GATEWAY_SIGNATURE_HEADER,
  DISCORD_GATEWAY_TIMESTAMP_HEADER,
  discordGatewaySigningPayload,
} from "@okouai/api-contracts/contracts/discord-gateway";

import { createApp } from "../../../app-factory";
import { testContext } from "../../../__tests__/test-context";
import { mockEnv } from "../../../lib/env";
import { mockNow, now } from "../../../lib/time";
import { discordGatewayRoutes } from "../discord-gateway";

const context = testContext();
const APPLICATION_ID = "111111111111111111";
const SECRET = randomBytes(32).toString("hex");

function configureGateway(secret = SECRET): void {
  mockEnv("DISCORD_APPLICATION_ID", APPLICATION_ID);
  mockEnv("DISCORD_BOT_TOKEN", "synthetic-discord-bot-token");
  mockEnv("DISCORD_PUBLIC_KEY", "a".repeat(64));
  mockEnv("DISCORD_GATEWAY_SECRET", secret);
}

function signature(body: string, timestamp: string): string {
  return createHmac("sha256", SECRET)
    .update(discordGatewaySigningPayload(timestamp, body))
    .digest("hex");
}

function postRaw(
  body: string,
  timestamp: string,
  signed = signature(body, timestamp),
) {
  const app = createApp({
    signal: context.signal,
    routes: discordGatewayRoutes,
  });
  return app.request("/api/internal/discord/gateway", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      [DISCORD_GATEWAY_TIMESTAMP_HEADER]: timestamp,
      [DISCORD_GATEWAY_SIGNATURE_HEADER]: signed,
    },
    body,
  });
}

function eventBody(
  payload: Record<string, unknown>,
  eventType = "MESSAGE_CREATE",
): string {
  return JSON.stringify({
    version: 1,
    applicationId: APPLICATION_ID,
    eventType,
    eventId: "synthetic-event",
    payload,
  });
}

describe("Discord Gateway authentication and ignored transport events", () => {
  beforeEach(() => {
    configureGateway();
  });

  it.each(DISCORD_GATEWAY_AUTH_TEST_VECTORS)(
    "accepts the exact shared HMAC vector bytes: $timestamp",
    async (vector) => {
      configureGateway(vector.secret);
      mockNow(Number(vector.timestamp) * 1000);
      // A different configured app rejects the authenticated request before
      // any provider identity or database access.
      mockEnv("DISCORD_APPLICATION_ID", "99999999999999999999");
      const response = await postRaw(
        vector.rawBody,
        vector.timestamp,
        vector.signature,
      );
      expect(response.status).toBe(403);
      await expect(response.json()).resolves.toStrictEqual({
        error: { code: "FORBIDDEN", message: "Invalid application" },
      });
    },
  );

  it("rejects signed bodies whose bytes changed", async () => {
    const body = eventBody(
      { id: "222222222222222222", unavailable: true },
      "GUILD_DELETE",
    );
    const timestamp = String(Math.floor(now() / 1000));
    const response = await postRaw(
      `${body}\n`,
      timestamp,
      signature(body, timestamp),
    );
    expect(response.status).toBe(401);
  });

  it.each([-301, 301])(
    "rejects a signed timestamp outside the past/future window (%s)",
    async (offset) => {
      const body = eventBody(
        { id: "222222222222222222", unavailable: true },
        "GUILD_DELETE",
      );
      const timestamp = String(Math.floor(now() / 1000) + offset);
      const response = await postRaw(body, timestamp);
      expect(response.status).toBe(401);
    },
  );

  it("rejects partially numeric timestamps and malformed signatures", async () => {
    const body = eventBody({});
    const timestamp = `${Math.floor(now() / 1000)}suffix`;
    expect((await postRaw(body, timestamp)).status).toBe(401);
    expect(
      (await postRaw(body, String(Math.floor(now() / 1000)), "a")).status,
    ).toBe(401);
  });

  it("rejects a transport-supplied Okou owner", async () => {
    const body = JSON.stringify({
      version: 1,
      applicationId: APPLICATION_ID,
      eventType: "MESSAGE_CREATE",
      eventId: "synthetic-event",
      userId: "untrusted-user",
      payload: {},
    });
    const response = await postRaw(body, String(Math.floor(now() / 1000)));
    expect(response.status).toBe(400);
  });

  it("acknowledges a temporary unavailable guild without uninstalling it", async () => {
    const body = eventBody(
      { id: "222222222222222222", unavailable: true },
      "GUILD_DELETE",
    );
    const response = await postRaw(body, String(Math.floor(now() / 1000)));
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toStrictEqual({
      ok: true,
      outcome: "ignored",
      reason: "guild-unavailable",
    });
  });

  it.each([
    { author: { id: "333333333333333333", username: "bot", bot: true } },
    { webhook_id: "444444444444444444" },
    { edited_timestamp: "2026-09-24T00:00:00Z" },
    { type: 6 },
  ])(
    "intentionally ignores unsupported message producers or updates: %j",
    async (patch) => {
      const body = eventBody({
        id: "555555555555555555",
        channel_id: "666666666666666666",
        author: { id: "333333333333333333", username: "human" },
        content: "hello",
        mentions: [],
        attachments: [],
        type: 0,
        ...patch,
      });
      const response = await postRaw(body, String(Math.floor(now() / 1000)));
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toStrictEqual({
        ok: true,
        outcome: "ignored",
        reason: "unsupported-message",
      });
    },
  );

  it("rejects an oversized authenticated message body", async () => {
    const body = eventBody({ content: "x".repeat(1024 * 1024) });
    const response = await postRaw(body, String(Math.floor(now() / 1000)));
    expect(response.status).toBe(413);
  });

  it("does not accept traffic when app configuration is absent", async () => {
    mockEnv("DISCORD_GATEWAY_SECRET", undefined);
    const response = await postRaw(
      eventBody({}),
      String(Math.floor(now() / 1000)),
    );
    expect(response.status).toBe(503);
  });
});
