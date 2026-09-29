import { describe, expect, it } from "vitest";

import { IMAGE_MODEL_PRICE_TIER } from "../media-model-price-tiers";

describe("media model price tiers", () => {
  it("exposes a price tier for every image model", () => {
    expect(IMAGE_MODEL_PRICE_TIER).toEqual({
      "gpt-image-1": "$$",
      "gpt-image-2": "$$$",
      "gpt-image-2.5-flare": "$$$",
      "gpt-image-2.5-sunburst": "$$$",
      "fal-ai/flux-pro/v1.1": "$$$",
      "fal-ai/flux-pro/v1.1-ultra": "$$$",
      "fal-ai/flux-2-pro": "$$",
      "alibaba/qwen-image-3/text-to-image": "$$",
      "ideogram/v4": "$",
      "fal-ai/bytedance/seedream/v4/text-to-image": "$$",
      "dola-seedream-5-0-pro-260628": "$$",
      "seedream-5-0-lite-260128": "$$",
      "fal-ai/nano-banana-2": "$$$",
      "google/nano-banana-2-lite": "$$",
    });
  });
});
