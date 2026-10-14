import { initClient } from "@okouai/api-contracts/contracts/trpc-contract";
import {
  suggestionsContract,
  type SuggestionCreate,
  type SuggestionUpdate,
} from "@okouai/api-contracts/contracts/suggestions";
import { getClientConfig, handleError } from "../core/client-factory";

export async function listSuggestions() {
  const client = initClient(suggestionsContract, await getClientConfig());
  const result = await client.list({ headers: {} });
  if (result.status === 200) return result.body;
  handleError(result, "Failed to read suggestions");
}
export async function createSuggestion(body: SuggestionCreate) {
  const client = initClient(suggestionsContract, await getClientConfig());
  const result = await client.create({ body, headers: {} });
  if (result.status === 200) return result.body;
  handleError(result, "Failed to create suggestion");
}
export async function updateSuggestion(id: string, body: SuggestionUpdate) {
  const client = initClient(suggestionsContract, await getClientConfig());
  const result = await client.update({ params: { id }, body, headers: {} });
  if (result.status === 200) return result.body;
  handleError(result, "Failed to update suggestion");
}
export async function deleteSuggestion(id: string) {
  const client = initClient(suggestionsContract, await getClientConfig());
  const result = await client.remove({ params: { id }, headers: {} });
  if (result.status === 204) return;
  handleError(result, "Failed to delete suggestion");
}
