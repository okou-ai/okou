import type { McpChatThread } from "@okouai/api-contracts/contracts/mcp-chat-threads";
import { runModelCatalog } from "@okouai/db/schema/run-model-catalog";
import { command } from "ccstate";
import { db$ } from "../external/db";
import { listAvailableRunModels$ } from "./run-models.service";

/** Read the Web run model projection plus persisted replacement identities once. */
export const mcpChatThreadModels$ = command(
  async (
    { get, set },
    principal: { readonly userId: string; readonly orgId: string },
    selectedModels: readonly (string | null)[],
    signal: AbortSignal,
  ): Promise<ReadonlyMap<string | null, McpChatThread["model"]>> => {
    if (selectedModels.length === 0) {
      return new Map();
    }
    const [listing, replacements] = await Promise.all([
      set(listAvailableRunModels$, principal, signal),
      get(db$)
        .select({
          model: runModelCatalog.model,
          replacedBy: runModelCatalog.replacedBy,
        })
        .from(runModelCatalog),
    ]);
    signal.throwIfAborted();
    const byModel = new Map(
      replacements.map((row) => {
        return [row.model, row.replacedBy];
      }),
    );
    // A listed model is not a promise of current Run admission. Quota
    // and transient provider availability are checked by the ordinary send;
    // they must not erase a stored model's canonical replacement in a read.
    const listed = new Set(
      listing.models.map((runModel) => {
        return runModel.model;
      }),
    );
    const result = new Map<string | null, McpChatThread["model"]>();
    for (const selectedModel of new Set(selectedModels)) {
      let finalModel = selectedModel;
      const visited = new Set<string>();
      while (finalModel !== null && byModel.has(finalModel)) {
        if (visited.has(finalModel)) {
          throw new Error("Model catalog replacement cycle");
        }
        visited.add(finalModel);
        const replacement = byModel.get(finalModel);
        if (!replacement) {
          break;
        }
        finalModel = replacement;
      }
      if (finalModel === null) {
        // Auto resolves its run model on send.
        result.set(selectedModel, {
          selectedModel,
          effectiveModel: null,
          source: "org_default",
          admission: "checked_on_send",
        });
        continue;
      }
      // An unavailable stored selection is rejected on send; it never runs as
      // the default model.
      const available = listed.has(finalModel);
      result.set(selectedModel, {
        selectedModel,
        effectiveModel: available ? finalModel : null,
        source: available ? "thread" : null,
        admission: "checked_on_send",
      });
    }
    return result;
  },
);
