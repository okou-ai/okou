import { describe, expect, it } from "vitest";
import { FeatureSwitchKey } from "../feature-switch-key";
import { isFeatureEnabled } from "../feature-switch";
import {
  isTailscaleAccessEnabled,
  isVncAccessEnabled,
} from "../remote-control-features";

describe.each([
  [FeatureSwitchKey.VncAccess, isVncAccessEnabled],
  [FeatureSwitchKey.TailscaleAccess, isTailscaleAccessEnabled],
] as const)("%s feature admission", (legacySwitch, enabled) => {
  it("includes Bingjie's guided setup across workspaces without changing the legacy rollout", () => {
    const context = {
      userId: "user_3EWY21Oe3f15kfs3yYmbGgDb3NV",
      orgId: "external-workspace",
    };
    expect(isFeatureEnabled(legacySwitch, context)).toBe(false);
    expect(enabled(context)).toBe(true);
    expect(
      enabled({
        ...context,
        overrides: { [FeatureSwitchKey.RemoteControlGuidedSetup]: false },
      }),
    ).toBe(false);
    for (const other of [
      {},
      { userId: "another-user" },
      { email: "bingjie@okou.ai" },
    ]) {
      expect(enabled(other)).toBe(false);
    }
  });

  it.each([
    [false, false, false],
    [true, false, true],
    [false, true, true],
    [true, true, true],
  ])("handles legacy=%s and guided=%s", (legacy, guided, expected) => {
    expect(
      enabled({
        overrides: {
          [legacySwitch]: legacy,
          [FeatureSwitchKey.RemoteControlGuidedSetup]: guided,
        },
      }),
    ).toBe(expected);
  });
});
