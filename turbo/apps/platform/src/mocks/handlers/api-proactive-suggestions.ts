import {
  proactiveSuggestionsContract,
  type ProactiveSuggestionsPreference,
} from "@okouai/api-contracts/contracts/proactive-suggestions";
import type { ProactivePreference } from "@okouai/api-contracts/contracts/proactive";
import { mockApi } from "../msw-contract.ts";
import { proactiveJobsContract } from "@okouai/api-contracts/contracts/proactive-jobs";
import { proactiveLearningContract } from "@okouai/api-contracts/contracts/proactive-nightly";

let preference: ProactiveSuggestionsPreference = {
  enabled: false,
  status: "paused",
  unavailableReason: null,
};
let jobs: ProactivePreference = {
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
  jobs = { enabled: false, status: "paused", unavailableReason: null };
  learning = { enabled: false, status: "paused", unavailableReason: null };
}
export const apiProactiveSuggestionsHandlers = [
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
  mockApi(proactiveJobsContract.get, ({ respond }) => respond(200, jobs)),
  mockApi(proactiveJobsContract.update, ({ body, respond }) => {
    jobs = {
      enabled: body.enabled,
      status: body.enabled ? "enabled" : "paused",
      unavailableReason: null,
    };
    return respond(200, jobs);
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
