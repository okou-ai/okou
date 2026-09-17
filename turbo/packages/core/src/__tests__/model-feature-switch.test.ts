import { describe, expect, it } from "vitest";

import { FeatureSwitchKey } from "../feature-switch-key";
import {
  isChatEffortEnabled,
  isCodexFastModeEnabled,
} from "../model-feature-switch";

describe("isChatEffortEnabled", () => {
  it("should follow its own switch", () => {
    expect(
      isChatEffortEnabled({ overrides: { [FeatureSwitchKey.Effort]: true } }),
    ).toBe(true);
    expect(
      isChatEffortEnabled({ overrides: { [FeatureSwitchKey.Effort]: false } }),
    ).toBe(false);
  });
});

describe("isCodexFastModeEnabled", () => {
  it("should follow effort as well as its own rollout", () => {
    expect(
      isCodexFastModeEnabled({
        overrides: { [FeatureSwitchKey.Effort]: true },
      }),
    ).toBe(true);
    expect(
      isCodexFastModeEnabled({
        overrides: {
          [FeatureSwitchKey.Effort]: false,
          [FeatureSwitchKey.CodexFastMode]: true,
        },
      }),
    ).toBe(true);
    expect(
      isCodexFastModeEnabled({
        overrides: {
          [FeatureSwitchKey.Effort]: false,
          [FeatureSwitchKey.CodexFastMode]: false,
        },
      }),
    ).toBe(false);
  });
});
