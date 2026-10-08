import { generateKeyPairSync, sign } from "node:crypto";

import { discordInteractionsContract } from "@okouai/api-contracts/contracts/discord-interactions";
import { beforeEach, describe, expect, it } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp, setupRawAppRequest } from "../../../__tests__/test-helpers";
import { mockEnv } from "../../../lib/env";
import { mockNow } from "../../../lib/time";
import { discordInteractionsRoutes } from "../discord-interactions";

const context = testContext();
const keyPair = generateKeyPairSync("ed25519");
const publicKey = keyPair.publicKey
  .export({ format: "der", type: "spki" })
  .subarray(-32)
  .toString("hex");
const applicationId = "123456789012345678";
const currentTime = Date.parse("2026-09-24T10:00:00.000Z");
const currentTimestamp = String(currentTime / 1000);

function apiClient() {
  return setupApp({ context, routes: discordInteractionsRoutes })(
    discordInteractionsContract,
  );
}

function pingPayload() {
  return {
    id: "223456789012345678",
    application_id: applicationId,
    token: "test-interaction-token",
    version: 1,
    type: 1,
  };
}

function commandPayload() {
  return {
    ...pingPayload(),
    type: 2,
    channel_id: "323456789012345678",
    user: { id: "423456789012345678" },
    data: {
      id: "523456789012345678",
      type: 1,
      name: "okou",
      options: [{ type: 1, name: "help" }],
    },
  };
}

function signedHeaders(
  body: string | Uint8Array,
  timestamp = currentTimestamp,
) {
  return {
    "content-type": "application/json",
    "x-signature-timestamp": timestamp,
    "x-signature-ed25519": sign(
      null,
      Buffer.concat([Buffer.from(timestamp), Buffer.from(body)]),
      keyPair.privateKey,
    ).toString("hex"),
  };
}

beforeEach(() => {
  mockNow(currentTime);
  mockEnv("DISCORD_PUBLIC_KEY", publicKey);
  mockEnv("DISCORD_APPLICATION_ID", applicationId);
  mockEnv("DISCORD_GATEWAY_SECRET", "a".repeat(64));
  mockEnv("DISCORD_BOT_TOKEN", undefined);
});

describe("POST /api/discord/interactions signature and protocol validation", () => {
  it("answers PING signed over the exact whitespace and UTF-8 request bytes", async () => {
    const body = JSON.stringify(
      { ...pingPayload(), locale_label: "中文" },
      null,
      2,
    );

    const response = await accept(
      apiClient().post({ body, headers: signedHeaders(body) }),
      [200],
    );

    expect(response.body).toStrictEqual({ type: 1 });
  });

  it("rejects reserialized JSON whose meaning matches the signed body", async () => {
    const body = JSON.stringify(pingPayload());

    const response = await accept(
      apiClient().post({
        body: JSON.stringify(pingPayload(), null, 2),
        headers: signedHeaders(body),
      }),
      [401],
    );
    expect(response.status).toBe(401);
  });

  it.each(["x".repeat(128), "0".repeat(126), "0".repeat(130), "0".repeat(128)])(
    "rejects invalid Ed25519 signature %s",
    async (signature) => {
      const body = JSON.stringify(pingPayload());

      const response = await accept(
        apiClient().post({
          body,
          headers: { ...signedHeaders(body), "x-signature-ed25519": signature },
        }),
        [401],
      );
      expect(response.status).toBe(401);
    },
  );

  it.each(["x-signature-ed25519", "x-signature-timestamp"])(
    "requires the %s header",
    async (missingHeader) => {
      const body = JSON.stringify(pingPayload());
      const headers = Object.fromEntries(
        Object.entries(signedHeaders(body)).filter(([key]) => {
          return key !== missingHeader;
        }),
      );

      const response = await accept(apiClient().post({ body, headers }), [401]);
      expect(response.status).toBe(401);
    },
  );

  it.each([-300, 30])(
    "accepts a signature at the %i-second time boundary",
    async (offset) => {
      const body = JSON.stringify(pingPayload());
      const timestamp = String(currentTime / 1000 + offset);

      const response = await accept(
        apiClient().post({ body, headers: signedHeaders(body, timestamp) }),
        [200],
      );
      expect(response.status).toBe(200);
    },
  );

  it.each([-301, 31])(
    "rejects a signature outside the %i-second time boundary",
    async (offset) => {
      const body = JSON.stringify(pingPayload());
      const timestamp = String(currentTime / 1000 + offset);

      const response = await accept(
        apiClient().post({ body, headers: signedHeaders(body, timestamp) }),
        [401],
      );
      expect(response.status).toBe(401);
    },
  );

  it.each([
    `${currentTimestamp}extra`,
    `${currentTimestamp}.0`,
    `+${currentTimestamp}`,
    "1e9",
  ])(
    "rejects a non-decimal timestamp %s even when correctly signed",
    async (timestamp) => {
      const body = JSON.stringify(pingPayload());

      const response = await accept(
        apiClient().post({ body, headers: signedHeaders(body, timestamp) }),
        [401],
      );
      expect(response.status).toBe(401);
    },
  );

  it("rejects a signed interaction for a different application", async () => {
    const body = JSON.stringify({
      ...pingPayload(),
      application_id: "623456789012345678",
    });

    const response = await accept(
      apiClient().post({ body, headers: signedHeaders(body) }),
      [401],
    );
    expect(response.status).toBe(401);
  });

  it.each([
    ["non-decimal snowflake", { ...pingPayload(), id: "1e18" }],
    ["overflowing snowflake", { ...pingPayload(), id: "18446744073709551616" }],
    ["numeric snowflake", { ...pingPayload(), id: 123 }],
    ["missing token", { ...pingPayload(), token: undefined }],
    ["missing actor", { ...commandPayload(), user: undefined }],
    [
      "guild with DM identity",
      { ...commandPayload(), guild_id: "723456789012345678" },
    ],
    [
      "guild with two identities",
      {
        ...commandPayload(),
        guild_id: "723456789012345678",
        member: { user: { id: "823456789012345678" } },
      },
    ],
    [
      "DM with member identity",
      {
        ...commandPayload(),
        user: undefined,
        member: { user: { id: "823456789012345678" } },
      },
    ],
    [
      "unsupported modal",
      {
        ...commandPayload(),
        type: 5,
        data: { custom_id: "not-issued", components: [] },
      },
    ],
    [
      "unsupported component",
      {
        ...commandPayload(),
        type: 3,
        data: { component_type: 4, custom_id: "not-issued" },
      },
    ],
    [
      "multiple selected values",
      {
        ...commandPayload(),
        type: 3,
        data: {
          component_type: 3,
          custom_id: "not-issued",
          values: ["one", "two"],
        },
      },
    ],
    [
      "unknown subcommand",
      {
        ...commandPayload(),
        data: {
          ...commandPayload().data,
          options: [{ type: 1, name: "unexpected" }],
        },
      },
    ],
  ])("rejects a signed malformed interaction: %s", async (_label, payload) => {
    const body = JSON.stringify(payload);

    const response = await accept(
      apiClient().post({ body, headers: signedHeaders(body) }),
      [400],
    );
    expect(response.status).toBe(400);
  });

  it("rejects signed malformed JSON", async () => {
    const body = "{";

    const response = await accept(
      apiClient().post({ body, headers: signedHeaders(body) }),
      [400],
    );
    expect(response.status).toBe(400);
  });

  it("rejects signed invalid UTF-8 without a server error", async () => {
    // The typed raw-string contract cannot represent invalid UTF-8 bytes.
    const body = new Uint8Array([0x7b, 0xff, 0x7d]);
    const request = setupRawAppRequest({
      context,
      routes: discordInteractionsRoutes,
    });

    const response = await request("/api/discord/interactions", {
      method: "POST",
      headers: signedHeaders(body),
      body,
    });

    expect(response.status).toBe(400);
  });

  it("rejects an oversized signed payload before parsing", async () => {
    const body = " ".repeat(65_537);

    const response = await accept(
      apiClient().post({ body, headers: signedHeaders(body) }),
      [400],
    );
    expect(response.status).toBe(400);
  });

  it.each(["DISCORD_APPLICATION_ID", "DISCORD_PUBLIC_KEY"] as const)(
    "reports unavailable configuration without %s",
    async (name) => {
      mockEnv(name, undefined);
      const body = JSON.stringify(pingPayload());

      const response = await accept(
        apiClient().post({ body, headers: signedHeaders(body) }),
        [503],
      );
      expect(response.status).toBe(503);
    },
  );

  it("requires bot configuration before accepting an account command", async () => {
    const body = JSON.stringify(commandPayload());

    const response = await accept(
      apiClient().post({ body, headers: signedHeaders(body) }),
      [503],
    );
    expect(response.status).toBe(503);
  });
});
