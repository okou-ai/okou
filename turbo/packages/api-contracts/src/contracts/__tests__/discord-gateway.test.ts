import { createHmac, webcrypto } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  DISCORD_GATEWAY_AUTH_TEST_VECTORS,
  discordGatewayEnvelopeSchema,
  discordGatewaySigningPayload,
} from "../discord-gateway";

describe("Discord Gateway wire contract", () => {
  it.each(DISCORD_GATEWAY_AUTH_TEST_VECTORS)(
    "preserves raw bytes for Node and Web Crypto signatures ($signature)",
    async ({ secret, timestamp, rawBody, signature }) => {
      const signedPayload = discordGatewaySigningPayload(timestamp, rawBody);
      expect(
        createHmac("sha256", secret)
          .update(signedPayload, "utf8")
          .digest("hex"),
      ).toBe(signature);

      const encoder = new TextEncoder();
      const key = await webcrypto.subtle.importKey(
        "raw",
        encoder.encode(secret),
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["sign"],
      );
      const digest = await webcrypto.subtle.sign(
        "HMAC",
        key,
        encoder.encode(signedPayload),
      );
      expect(Buffer.from(digest).toString("hex")).toBe(signature);
      expect(
        discordGatewayEnvelopeSchema.safeParse(JSON.parse(rawBody)).success,
      ).toBe(true);
    },
  );

  it("rejects transport-supplied Okou authority and unsupported envelope versions", () => {
    const envelope = {
      version: 1,
      applicationId: "123456789012345678",
      eventType: "MESSAGE_CREATE",
      eventId: "MESSAGE_CREATE:987654321098765432",
      payload: { id: "987654321098765432" },
    };
    for (const changes of [
      { orgId: "org_attacker" },
      { userId: "user_attacker" },
      { version: 2 },
      { eventType: "MESSAGE_UPDATE" },
    ]) {
      expect(
        discordGatewayEnvelopeSchema.safeParse({ ...envelope, ...changes })
          .success,
      ).toBe(false);
    }
  });
});
