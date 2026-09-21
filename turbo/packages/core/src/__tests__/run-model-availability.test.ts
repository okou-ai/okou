import { describe, expect, it } from "vitest";

import { FeatureSwitchKey } from "../feature-switch-key";
import {
  availableRunModels,
  isRunModelAvailable,
} from "../run-model-availability";

describe("run model availability", () => {
  it("keeps ordinary models independent of the Okou rollout", () => {
    expect(isRunModelAvailable("gpt-5.6-luna", {})).toBe(true);
    expect(isRunModelAvailable("unknown-history-id", {})).toBe(true);
  });

  it("gates every Okou alias with the same effective switch", () => {
    for (const model of ["okou-1-0", "okou-1-0-pro", "okou-1-0-max"]) {
      expect(isRunModelAvailable(model, {})).toBe(false);
      expect(
        isRunModelAvailable(model, {
          overrides: { [FeatureSwitchKey.OkouModels]: true },
        }),
      ).toBe(true);
    }
  });

  it("filters a selectable catalog without changing its order", () => {
    const models = ["okou-1-0", "gpt-5.6-luna"] as const;
    expect(availableRunModels(models, {})).toEqual(["gpt-5.6-luna"]);
    expect(
      availableRunModels(models, {
        overrides: { [FeatureSwitchKey.OkouModels]: true },
      }),
    ).toEqual(models);
  });
});
