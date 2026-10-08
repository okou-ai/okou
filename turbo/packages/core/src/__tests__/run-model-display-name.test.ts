import { describe, expect, it } from "vitest";

import { AUTO_RUN_MODEL } from "../auto-run-model";
import {
  getModelDisplayName,
  getRunModelDisplayName,
} from "../model-display-name";

describe("getRunModelDisplayName", () => {
  it.each([null, undefined, "fast"] as const)(
    "omits Auto from integration footers with service tier %s",
    (serviceTier) => {
      expect(
        getRunModelDisplayName(AUTO_RUN_MODEL, serviceTier),
      ).toBeUndefined();
    },
  );

  it("keeps Auto's display name outside integration footers", () => {
    expect(getModelDisplayName(AUTO_RUN_MODEL)).toBe("Auto");
  });

  it.each([null, undefined] as const)(
    "keeps explicit model labels with service tier %s",
    (serviceTier) => {
      expect(getRunModelDisplayName("claude-sonnet-5-5", serviceTier)).toBe(
        "Claude Sonnet 5.5",
      );
    },
  );

  it("keeps the Fast label for an explicitly selected model", () => {
    expect(getRunModelDisplayName("gpt-6-sol", "fast")).toBe("GPT 6 Sol Fast");
  });

  it("keeps the raw ID for an unknown historical model", () => {
    expect(getRunModelDisplayName("custom/model", null)).toBe("custom/model");
  });
});
