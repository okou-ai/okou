import { describe, expect, it } from "vitest";

import { getModelDisplayName } from "../model-display-name";

describe("getModelDisplayName", () => {
  it("uses friendly labels for OpenAI model IDs", () => {
    expect(getModelDisplayName("gpt-6-astra")).toBe("GPT 6 Astra");
    expect(getModelDisplayName("openai/gpt-6-astra")).toBe("GPT 6 Astra");
    expect(getModelDisplayName("gpt-5.6-sol")).toBe("GPT 5.6 Sol");
    expect(getModelDisplayName("gpt-5.6-terra")).toBe("GPT 5.6 Terra");
    expect(getModelDisplayName("gpt-5.6-luna")).toBe("GPT 5.6 Luna");
    expect(getModelDisplayName("gpt-5.5")).toBe("GPT 5.5");
  });

  it("falls back to raw IDs for historical retired models", () => {
    expect(getModelDisplayName("kimi-k3")).toBe("kimi-k3");
    expect(getModelDisplayName("claude-opus-4-7")).toBe("claude-opus-4-7");
  });

  it("uses friendly labels for Claude Opus 5 model IDs", () => {
    expect(getModelDisplayName("claude-opus-5")).toBe("Claude Opus 5");
    expect(getModelDisplayName("anthropic/claude-opus-5")).toBe(
      "Claude Opus 5",
    );
  });

  it("uses friendly labels for Claude Fable 5.1 model IDs", () => {
    expect(getModelDisplayName("claude-fable-5-1")).toBe("Claude Fable 5.1");
    expect(getModelDisplayName("anthropic/claude-fable-5.1")).toBe(
      "Claude Fable 5.1",
    );
  });

  it("uses friendly labels for DeepSeek V4 models", () => {
    expect(getModelDisplayName("deepseek-v4.1-flash")).toBe(
      "DeepSeek V4.1 Flash",
    );
    expect(getModelDisplayName("deepseek-v4-flash")).toBe("DeepSeek V4 Flash");
    expect(getModelDisplayName("deepseek-v4-pro")).toBe("DeepSeek V4 Pro");
  });

  it("uses catalog labels for canonical image models and primary aliases", () => {
    expect(getModelDisplayName("fal-ai/flux-2-pro")).toBe("FLUX.2 Pro");
    expect(getModelDisplayName("flux-2-pro")).toBe("FLUX.2 Pro");
    expect(getModelDisplayName("ideogram/v4")).toBe("Ideogram 4");
    expect(getModelDisplayName("ideogram-4")).toBe("Ideogram 4");
  });

  it("does not resolve removed secondary image aliases", () => {
    expect(getModelDisplayName("flux2-pro")).toBe("flux2-pro");
    expect(getModelDisplayName("ideogram-v4")).toBe("ideogram-v4");
  });

  it("falls back to the raw model ID when no display name is defined", () => {
    expect(getModelDisplayName("custom/model")).toBe("custom/model");
  });
});
