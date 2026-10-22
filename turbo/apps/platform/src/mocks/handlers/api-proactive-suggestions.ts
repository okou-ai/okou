import {
  proactiveSuggestionsContract,
  type ProactiveSuggestionsPreference,
} from "@okouai/api-contracts/contracts/proactive-suggestions";
import {
  proactiveActionContract,
  type ProactiveActionPreference,
} from "@okouai/api-contracts/contracts/proactive-action";
import { mockApi } from "../msw-contract.ts";

let preference: ProactiveSuggestionsPreference = {
  enabled: false,
  status: "paused",
  unavailableReason: null,
};
let action: ProactiveActionPreference = {
  enabled: false,
  status: "paused",
  unavailableReason: null,
};
export function resetMockProactiveSuggestions(): void {
  preference = { enabled: false, status: "paused", unavailableReason: null };
  action = { enabled: false, status: "paused", unavailableReason: null };
}
export const apiProactiveSuggestionsHandlers = [
  mockApi(proactiveSuggestionsContract.get, ({ respond }) =>
    respond(
      200,
      action.enabled
        ? {
            ...preference,
            status: "paused",
            unavailableReason: "proactive-action-enabled",
          }
        : preference,
    ),
  ),
  mockApi(proactiveSuggestionsContract.update, ({ body, respond }) => {
    preference = {
      ...preference,
      enabled: body.enabled,
      status: body.enabled ? "enabled" : "paused",
    };
    return respond(200, preference);
  }),
  mockApi(proactiveActionContract.get, ({ respond }) => respond(200, action)),
  mockApi(proactiveActionContract.update, ({ body, respond }) => {
    action = {
      ...action,
      enabled: body.enabled,
      status: body.enabled ? "enabled" : "paused",
    };
    return respond(200, action);
  }),
];
