import type { ModelSettings } from "@okouai/api-contracts/contracts/model-reasoning-effort";
import type { TestContext } from "../../../signals/__tests__/test-helpers.ts";
import { buildProvider, buildRunModel } from "./chat-model-builders.ts";

export function accountModels(
  context: TestContext,
  models: string[],
  selectedModel: string | null,
  modelSettings: ModelSettings = {},
  serviceTier: "priority" | null = null,
) {
  const codex = buildProvider({
    id: "3cdb6113-43b3-408c-a0ce-bb02b96a3c93",
    type: "codex-oauth-token",
    framework: "codex",
  });
  const claude = buildProvider({
    id: "64110467-c547-4231-902d-e2efade7dce2",
    type: "claude-code-oauth-token",
  });
  context.mocks.data.personalModelProviders([codex, claude]);
  const rows = models.map((model) => {
    return buildRunModel({
      model,
      modelProviderId: model.startsWith("claude") ? claude.id : codex.id,
    });
  });
  context.mocks.data.availableRunModels(rows);
  context.mocks.data.userModelPreference({
    selectedModel,
    modelSettings,
    serviceTier,
    updatedAt: null,
    selectedImageModel: null,
  });
  return { rows, codex, claude };
}
