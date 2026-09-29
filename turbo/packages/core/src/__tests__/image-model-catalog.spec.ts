import { describe, expect, it } from "vitest";

import { resolveImageModel } from "../image-model-catalog";

describe("resolveImageModel", () => {
  it.each(["constructor", "toString", "__proto__"])(
    "rejects inherited object property %s as an image model",
    (model) => {
      expect(resolveImageModel(model)).toBeUndefined();
    },
  );

  it.each([
    ["gpt-image-2.5-flare", "gpt-image-2.5-flare"],
    ["fal-ai/flux-pro/v1.1", "fal-ai/flux-pro/v1.1"],
    ["flux-pro-1.1", "fal-ai/flux-pro/v1.1"],
    ["qwen-image-3", "alibaba/qwen-image-3/text-to-image"],
    ["nano-banana-2", "fal-ai/nano-banana-2"],
    ["nano-banana2", "fal-ai/nano-banana-2"],
    ["nano-banana2-lite", "google/nano-banana-2-lite"],
  ])("resolves supported model %s to %s", (model, expected) => {
    expect(resolveImageModel(model)).toBe(expected);
  });
});
