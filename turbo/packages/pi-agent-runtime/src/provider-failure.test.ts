import { describe, expect, it } from "vitest";
import {
  classifyProviderFailure,
  classifyProviderHttpFailure,
} from "@okouai/api-contracts/contracts/provider-failure";
import cases from "./test/fixtures/provider-failures.json";
import {
  formatRunBalanceError,
  MODEL_UNAVAILABLE_MESSAGE,
  PROVIDER_INSUFFICIENT_CREDITS_MESSAGE,
} from "@okouai/api-contracts/contracts/run-balance-errors";

describe("provider failure contract shared with guest-agent", () => {
  it.each(["billing_hard_limit_reached", "insufficient_credits"])(
    "keeps %s provider billing details private on built-in models",
    (code) => {
      const message = `API Error: 402 ${JSON.stringify({ error: { code, message: "Private provider billing details" } })}`;
      const failureReason = classifyProviderFailure(message);
      expect(
        formatRunBalanceError({ failureReason, modelProvider: "built-in" }),
      ).toBe(MODEL_UNAVAILABLE_MESSAGE);
      expect(
        formatRunBalanceError({
          failureReason,
          modelProvider: "openai-api-key",
        }),
      ).toBe(PROVIDER_INSUFFICIENT_CREDITS_MESSAGE);
    },
  );

  it.each(cases)("classifies $message", ({ message, reason }) => {
    expect(classifyProviderFailure(message)).toBe(reason ?? undefined);
  });

  it.each([
    [429, "provider_rate_limited"],
    [529, "provider_overloaded"],
    [500, "provider_server_error"],
    [503, "provider_server_error"],
    [525, "provider_server_error"],
    [599, "provider_server_error"],
    [200, undefined],
    [401, undefined],
    [403, undefined],
    [600, undefined],
    [503.5, undefined],
    [NaN, undefined],
  ])("classifies actual HTTP %s", (status, reason) => {
    expect(classifyProviderHttpFailure(Number(status))).toBe(reason);
  });
});
