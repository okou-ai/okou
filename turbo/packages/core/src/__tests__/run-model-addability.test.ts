import { describe, expect, it } from "vitest";

import { FeatureSwitchKey } from "../feature-switch-key";
import { isRunModelAddable } from "../run-model-addability";

describe("run model addability", () => {
  it("keeps ordinary models independent of the Okou rollout", () => {
    expect(isRunModelAddable("gpt-5.6-luna", {})).toBe(true);
    expect(isRunModelAddable("unknown-history-id", {})).toBe(true);
  });

  it("gates adding every Okou model with the personal switch", () => {
    for (const model of ["okou-1.0", "okou-1.0-pro", "okou-1.0-max"]) {
      expect(isRunModelAddable(model, {})).toBe(false);
      expect(
        isRunModelAddable(model, {
          overrides: { [FeatureSwitchKey.OkouModels]: true },
        }),
      ).toBe(true);
    }
  });
});
