import { describe, expect, it } from "vitest";
import {
  classifyProviderFailure,
  classifyProviderHttpFailure,
} from "@okouai/api-contracts/contracts/provider-failure";
import cases from "./test/fixtures/provider-failures.json";

describe("provider failure contract shared with guest-agent", () => {
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
