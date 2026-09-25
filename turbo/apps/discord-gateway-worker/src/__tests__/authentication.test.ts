import { DISCORD_GATEWAY_AUTH_TEST_VECTORS } from "@okouai/api-contracts/contracts/discord-gateway";
import { describe, expect, it } from "vitest";
import { signature } from "../protocol";

describe("shared Gateway authentication vectors", () => {
  it.each(DISCORD_GATEWAY_AUTH_TEST_VECTORS)(
    "signs the exact shared raw body at $timestamp",
    async (vector) => {
      expect(
        await signature(vector.secret, vector.timestamp, vector.rawBody),
      ).toBe(vector.signature);
    },
  );
});
