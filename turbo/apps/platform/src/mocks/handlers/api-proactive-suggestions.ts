import {
  proactiveSuggestionsContract,
  type ProactiveSuggestionsPreference,
} from "@okouai/api-contracts/contracts/proactive-suggestions";
import { mockApi } from "../msw-contract.ts";

let preference: ProactiveSuggestionsPreference = {
  enabled: false,
  status: "paused",
  unavailableReason: null,
};
export function resetMockProactiveSuggestions(): void {
  preference = { enabled: false, status: "paused", unavailableReason: null };
}
export const apiProactiveSuggestionsHandlers = [
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
