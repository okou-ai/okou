import { describe, expect, it } from "vitest";
import {
  isFrontierModelProductLine,
  modelProductLine,
} from "../model-product-line";

/**
 * The per-model lines are asserted against `PI_MODEL_POLICY` in
 * `pi-admission-policy.test.ts`. These cases pin the derivation itself: the ID
 * shapes vendors and gateways actually ship, and the direction the classifier
 * fails in when it does not recognise one.
 */
describe("model product line", () => {
  it.each([
    // The line sits after the version for OpenAI and DeepSeek, before it for
    // Anthropic, and behind a gateway vendor prefix on shared gateways.
    ["gpt-6-astra", "astra"],
    ["claude-fable-5-1", "fable"],
    ["deepseek-v4.1-flash", "flash"],
    ["anthropic/claude-fable-5.1", "fable"],
    ["openai/gpt-6-astra", "astra"],
    // Position carries no meaning, so an ID that leads with its line still
    // classifies. A guard whose job is exclusion must not read this as "no
    // line" and let it through.
    ["fable-6", "fable"],
    // An unrecorded line classifies as `null` rather than guessing.
    ["claude-haiku-4-5", null],
    ["gpt-5.5", null],
    [null, null],
  ])("derives the product line of %s", (model, expected) => {
    expect(modelProductLine(model)).toBe(expected);
  });

  it.each([
    ["claude-fable-5-1", true],
    ["gpt-6-astra", true],
    ["fable-6", true],
    ["claude-opus-5", false],
    ["gpt-5.6-sol", false],
    ["deepseek-v4-pro", false],
  ])("decides whether %s is on a frontier line", (model, expected) => {
    expect(isFrontierModelProductLine(model)).toBe(expected);
  });
});
