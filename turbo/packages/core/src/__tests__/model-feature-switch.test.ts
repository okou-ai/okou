import { describe, expect, it } from "vitest";

import { FeatureSwitchKey } from "../feature-switch-key";
import { isCodexFastModeEnabled } from "../model-feature-switch";

describe("isCodexFastModeEnabled", () => {
  it("should follow its own rollout", () => {
    expect(
      isCodexFastModeEnabled({
        overrides: { [FeatureSwitchKey.CodexFastMode]: true },
      }),
    ).toBe(true);
    expect(
      isCodexFastModeEnabled({
        overrides: { [FeatureSwitchKey.CodexFastMode]: false },
      }),
    ).toBe(false);
  });
});
