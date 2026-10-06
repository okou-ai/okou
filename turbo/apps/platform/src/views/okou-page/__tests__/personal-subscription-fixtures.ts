import type { ModelProviderResponse } from "@okouai/api-contracts/contracts/model-providers";
import type { TestContext } from "../../../signals/__tests__/test-helpers.ts";

/** Explicit connected accounts for model-choice tests; recovery tests supply their own accounts. */
export function installConnectedPersonalSubscriptions(
  context: TestContext,
): void {
  const types = ["codex-oauth-token", "claude-code-oauth-token"] as const;
  const accounts: ModelProviderResponse[] = types.map((type, index) => {
    return {
      id: `e8000000-0000-4000-a000-00000000000${index + 1}`,
      type,
      framework: type === "codex-oauth-token" ? "codex" : "claude-code",
      secretName: null,
      authMethod: null,
      secretNames: null,
      isDefault: false,
      isActive: true,
      selectedModel: null,
      needsReconnect: false,
      lastRefreshErrorCode: null,
      createdAt: "2026-10-01T00:00:00Z",
      updatedAt: "2026-10-01T00:00:00Z",
    };
  });
  context.mocks.data.personalModelProviders(accounts);
}
