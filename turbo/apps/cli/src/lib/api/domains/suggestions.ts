import { initClient } from "@okouai/api-contracts/contracts/trpc-contract";
import {
  feedContract,
  type SuggestionCreate,
  type SuggestionUpdate,
} from "@okouai/api-contracts/contracts/feed";
import { getClientConfig, handleError } from "../core/client-factory";
export async function listSuggestions(options?: {
  readonly all?: boolean;
  readonly type?: "suggestion" | "event";
  readonly after?: string;
}) {
  if (options?.all && options.type === "event") {
    throw new Error(
      "--all is only available for suggestion curation. Use --type event without --all.",
    );
  }
  const client = initClient(feedContract, await getClientConfig());
  const result = options?.all
    ? await client.manage({
        headers: {},
        query: { after: options.after, type: "suggestion" },
      })
    : await client.list({ headers: {}, query: { type: options?.type } });
  if (result.status === 200) return result.body;
  handleError(result, "Failed to read suggestions");
}
export async function createSuggestion(body: SuggestionCreate) {
  const client = initClient(feedContract, await getClientConfig());
  const result = await client.create({ body, headers: {} });
  if (result.status === 200) return result.body;
  handleError(result, "Failed to create suggestion");
}
export async function updateSuggestion(id: string, body: SuggestionUpdate) {
  const client = initClient(feedContract, await getClientConfig());
  const result = await client.update({ params: { id }, body, headers: {} });
  if (result.status === 200) return result.body;
  handleError(result, "Failed to update suggestion");
}
export async function deleteSuggestion(id: string) {
  const client = initClient(feedContract, await getClientConfig());
  const result = await client.remove({ params: { id }, headers: {} });
  if (result.status === 204) return;
  handleError(result, "Failed to delete suggestion");
}
