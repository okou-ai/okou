import {
  morningBriefPreferenceContract,
  type MorningBriefPreferenceResponse,
} from "@okouai/api-contracts/contracts/morning-brief-preference";

import { mockApi } from "../msw-contract.ts";

let preference: MorningBriefPreferenceResponse = {
  enabled: false,
  status: "paused",
  unavailableReason: null,
};

export function resetMockMorningBriefPreference(): void {
  preference = {
    enabled: false,
    status: "paused",
    unavailableReason: null,
  };
}

export const apiMorningBriefPreferenceHandlers = [
  mockApi(morningBriefPreferenceContract.get, ({ respond }) => {
    return respond(200, preference);
  }),
  mockApi(morningBriefPreferenceContract.update, ({ body, respond }) => {
    preference = {
      ...preference,
      enabled: body.enabled,
      status: body.enabled ? "enabled" : "paused",
    };
    return respond(200, preference);
  }),
];
