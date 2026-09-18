import { describe, expect, it } from "vitest";

import { FeatureSwitchKey } from "../feature-switch-key";
import { isChatEffortEnabled } from "../model-feature-switch";

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
