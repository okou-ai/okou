import { mapsContract } from "@okouai/api-contracts/contracts/maps";
import { command } from "ccstate";

import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { setResHeader$ } from "../context/hono";
import { bodyResultOf } from "../context/request";
import type { RouteEntry } from "../route-entry";
import { mapsSearch$ } from "../services/maps.service";

const searchBody$ = bodyResultOf(mapsContract.search);

const mapsSearchRoute$ = command(async ({ get, set }, signal: AbortSignal) => {
  const bodyResult = await get(searchBody$);
  signal.throwIfAborted();
  if (!bodyResult.ok) {
    return bodyResult.response;
  }
  return await set(
    mapsSearch$,
    { auth: get(organizationAuthContext$), body: bodyResult.data },
    signal,
  );
});

const authenticatedMapsSearchRoute$ = authRoute(
  {
    requireOrganization: true,
    missingOrganizationStatus: 401,
    requiredCapability: "maps:read",
  },
  mapsSearchRoute$,
);

const privateMapsSearchRoute$ = command(
  async ({ set }, signal: AbortSignal) => {
    set(setResHeader$, "Cache-Control", "private, no-store");
    return await set(authenticatedMapsSearchRoute$, signal);
  },
);

export const mapsRoutes: readonly RouteEntry[] = [
  { route: mapsContract.search, handler: privateMapsSearchRoute$ },
];
