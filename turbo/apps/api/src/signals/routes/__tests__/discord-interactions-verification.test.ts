import { Buffer } from "node:buffer";
import { generateKeyPairSync, sign, type KeyObject } from "node:crypto";

import { discordInteractionsContract } from "@okouai/api-contracts/contracts/discord-interactions";
import { describe, expect, it } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { mockEnv } from "../../../lib/env";
import { now } from "../../../lib/time";
import { discordInteractionsRoutes } from "../discord-interactions";
import { uniqueDiscordSnowflake } from "./helpers/discord";

const context = testContext();

/**
 * Configures only the Discord application ID and a freshly generated Ed25519
 * interaction key; the bot command credentials stay unconfigured.
 */
function configureDiscordInteractionKey(): {
  readonly applicationId: string;
  readonly privateKey: KeyObject;
} {
  const applicationId = uniqueDiscordSnowflake();
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  mockEnv("DISCORD_APPLICATION_ID", applicationId);
  mockEnv(
    "DISCORD_PUBLIC_KEY",
    publicKey
      .export({ format: "der", type: "spki" })
      .subarray(-32)
      .toString("hex"),
  );
  return { applicationId, privateKey };
}

function pingBody(applicationId: string): string {
  return JSON.stringify(
    {
      type: 1,
      id: uniqueDiscordSnowflake(),
      application_id: applicationId,
      token: "pïng-tökén-✓-検証",
      version: 1,
    },
    null,
    2,
  );
}

function postInteraction(
  body: string,
  headers: {
    readonly "x-signature-ed25519": string;
    readonly "x-signature-timestamp": string;
  },
) {
  return accept(
    setupApp({ context, routes: discordInteractionsRoutes })(
      discordInteractionsContract,
    ).post({
      body,
      headers: { "content-type": "application/json", ...headers },
    }),
    [200, 401],
  );
}

describe("POST /api/discord/interactions signature and protocol validation", () => {
  it("discord-interactions-verification-001 answers a PING signed over the exact indented UTF-8 bytes", async () => {
    const { applicationId, privateKey } = configureDiscordInteractionKey();
    const body = pingBody(applicationId);
    const timestamp = String(Math.floor(now() / 1000));
    const signature = sign(
      null,
      Buffer.from(`${timestamp}${body}`, "utf8"),
      privateKey,
    ).toString("hex");

    const response = await postInteraction(body, {
      "x-signature-ed25519": signature,
      "x-signature-timestamp": timestamp,
    });
    expect(response.status).toBe(200);
    expect(response.body).toStrictEqual({ type: 1 });
  });

  it("discord-interactions-verification-006 rejects a PING whose Ed25519 signature is all zeros", async () => {
    const { applicationId } = configureDiscordInteractionKey();

    const response = await postInteraction(pingBody(applicationId), {
      "x-signature-ed25519": "0".repeat(128),
      "x-signature-timestamp": String(Math.floor(now() / 1000)),
    });
    expect(response.status).toBe(401);
  });

  it("discord-interactions-verification-017 rejects a correctly signed PING for a different application", async () => {
    const { privateKey } = configureDiscordInteractionKey();
    const body = pingBody(uniqueDiscordSnowflake());
    const timestamp = String(Math.floor(now() / 1000));
    const signature = sign(
      null,
      Buffer.from(`${timestamp}${body}`, "utf8"),
      privateKey,
    ).toString("hex");

    const response = await postInteraction(body, {
      "x-signature-ed25519": signature,
      "x-signature-timestamp": timestamp,
    });
    expect(response.status).toBe(401);
  });
});
