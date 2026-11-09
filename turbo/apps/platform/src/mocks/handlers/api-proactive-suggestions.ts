import {
  proactiveSuggestionsContract,
  type ProactiveSuggestionsPreference,
} from "@okouai/api-contracts/contracts/proactive-suggestions";
import type { ProactivePreference } from "@okouai/api-contracts/contracts/proactive";
import { mockApi } from "../msw-contract.ts";
import { proactiveLearningContract } from "@okouai/api-contracts/contracts/proactive-nightly";
import { suggestionsContract } from "@okouai/api-contracts/contracts/suggestions";

let preference: ProactiveSuggestionsPreference = {
  enabled: false,
  status: "paused",
  unavailableReason: null,
};
let learning: ProactivePreference = {
  enabled: false,
  status: "paused",
  unavailableReason: null,
};
export function resetMockProactiveSuggestions(): void {
  preference = { enabled: false, status: "paused", unavailableReason: null };
  learning = { enabled: false, status: "paused", unavailableReason: null };
}
export const apiProactiveSuggestionsHandlers = [
  // The chat list's Okou row counts the Feed whenever Suggestions are on.
  mockApi(suggestionsContract.list, ({ respond }) =>
    respond(200, { suggestions: [] }),
  ),
  mockApi(proactiveLearningContract.get, ({ respond }) =>
    respond(200, learning),
  ),
  mockApi(proactiveLearningContract.update, ({ body, respond }) => {
    learning = {
      ...learning,
      enabled: body.enabled,
      status: body.enabled ? "enabled" : "paused",
    };
    return respond(200, learning);
  }),
  mockApi(proactiveSuggestionsContract.get, ({ respond }) =>
    respond(200, preference),
  ),
  mockApi(proactiveSuggestionsContract.update, ({ body, respond }) => {
    preference = {
      ...preference,
      enabled: body.enabled,
      status: body.enabled ? "enabled" : "paused",
    };
    return respond(200, preference);
  }),
];
