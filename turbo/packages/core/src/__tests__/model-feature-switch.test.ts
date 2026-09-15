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

  // An app bundle built before the split still asks for the retired key, so a
  // user who has it keeps effort until those bundles drain.
  it("should still honour the retired switch", () => {
    expect(
      isChatEffortEnabled({
        overrides: { [FeatureSwitchKey.RefactorModelSelect]: true },
      }),
    ).toBe(true);
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
        overrides: { [FeatureSwitchKey.CodexFastMode]: true },
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
