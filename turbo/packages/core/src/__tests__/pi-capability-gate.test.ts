import { describe, expect, it, vi } from "vitest";
import { isPiExecutionRoute } from "../pi-execution";
import type { PiRuntimeIdentity } from "../pi-runtime-capability";

const UNRESOLVABLE: PiRuntimeIdentity = {
  provider: "anthropic",
  model: "claude-sonnet-5",
};

/**
 * Stand in for a pinned runtime that stopped carrying one identity. Admission
 * must then fall back to the legacy loop instead of building a Pi session that
 * `session-runtime.ts` would refuse to create.
 *
 * The production interface cannot reach this state on its own: every model the
 * policy table admits has capability data, and `pi-runtime-capability.test.ts`
 * in `@okouai/pi-agent-runtime` keeps that true against the real resolver. The
 * capability-excluded `claude-opus-5-5`, `gpt-6-sol`, and `gpt-6-luna`
 * are refused one layer earlier by the policy table, so they never exercise
 * the gate. Substituting the capability
 * lookup is the only way to prove the gate itself is load-bearing.
 */
vi.mock("../pi-runtime-capability", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../pi-runtime-capability")>();
  return {
    ...actual,
    isPiRuntimeIdentityResolvable: (identity: PiRuntimeIdentity): boolean => {
      return identity.provider === UNRESOLVABLE.provider &&
        identity.model === UNRESOLVABLE.model
        ? false
        : actual.isPiRuntimeIdentityResolvable(identity);
    },
  };
});

describe("Pi capability gate", () => {
  it.each([
    ["built-in", "anthropic-api-key"],
    ["built-in", "openrouter-api-key"],
    ["anthropic-api-key", "anthropic-api-key"],
    ["aws-bedrock", "aws-bedrock"],
    ["custom-anthropic-messages", "custom-anthropic-messages"],
  ])(
    "refuses an unresolvable model on %s via %s",
    (modelProviderType, runtimeProviderType) => {
      expect(
        isPiExecutionRoute({
          selectedModel: UNRESOLVABLE.model,
          modelProviderType,
          runtimeProviderType,
          codexServiceTier: undefined,
        }),
      ).toBe(false);
    },
  );

  it("leaves every other admitted model alone", () => {
    for (const selectedModel of ["claude-opus-5", "deepseek-v4-pro"]) {
      expect(
        isPiExecutionRoute({
          selectedModel,
          modelProviderType: "built-in",
          runtimeProviderType:
            selectedModel === "claude-opus-5"
              ? "anthropic-api-key"
              : "deepseek",
          codexServiceTier: undefined,
        }),
      ).toBe(true);
    }
  });
});
