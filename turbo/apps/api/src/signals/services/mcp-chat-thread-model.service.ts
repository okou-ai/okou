import type { McpChatThread } from "@okouai/api-contracts/contracts/mcp-chat-threads";
import { runModelCatalog } from "@okouai/db/schema/run-model-catalog";
import { command } from "ccstate";
import { db$ } from "../external/db";
import { listOrgModelPoliciesWithSystemDefault$ } from "./model-policy.service";

/** Read the Web policy projection plus persisted replacement identities once. */
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
      set(listOrgModelPoliciesWithSystemDefault$, principal, signal),
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
    const available = new Set(
      listing.response.policies
        .filter((policy) => {
          return (
            policy.routeStatus === "valid" &&
            policy.memberEffective?.availability !== "unavailable"
          );
        })
        .map((policy) => {
          return policy.model;
        }),
    );
    const defaultModel = available.has(listing.systemDefaultModel)
      ? listing.systemDefaultModel
      : null;
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
      const effectivePin =
        finalModel !== null && available.has(finalModel) ? finalModel : null;
      result.set(selectedModel, {
        selectedModel,
        effectiveModel: effectivePin ?? defaultModel,
        source: effectivePin ? "thread" : defaultModel ? "org_default" : null,
        admission: "checked_on_send",
      });
    }
    return result;
  },
);
