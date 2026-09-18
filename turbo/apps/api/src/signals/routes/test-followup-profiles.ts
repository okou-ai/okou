import { testFollowupProfilesContract } from "@okouai/api-contracts/contracts/test-followup-profiles";
import { command } from "ccstate";
import { request$ } from "../context/hono";
import { bodyResultOf } from "../context/request";
import { writeDb$ } from "../external/db";
import type { RouteEntry } from "../route-entry";
import { refreshFollowupProfiles } from "../services/chat-followup-preferences.service";
import {
  isTestEndpointAllowed,
  testEndpointNotFoundResponse,
} from "./test-endpoint-helpers";

const body$ = bodyResultOf(testFollowupProfilesContract.refresh);
const refresh$ = command(async ({ get, set }, signal: AbortSignal) => {
  if (!isTestEndpointAllowed(get(request$))) {
    return testEndpointNotFoundResponse();
  }
  const body = await get(body$);
  signal.throwIfAborted();
  if (!body.ok) {
    return body.response;
  }
  const result = await refreshFollowupProfiles(
    set(writeDb$),
    body.data,
    signal,
  );
  return { status: 200 as const, body: result };
});

export const testFollowupProfilesRoutes: readonly RouteEntry[] = [
  {
    route: testFollowupProfilesContract.refresh,
    handler: refresh$,
  },
];
