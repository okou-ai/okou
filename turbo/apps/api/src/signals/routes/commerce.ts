import { commerceContract } from "@okouai/api-contracts/contracts/commerce";
import { command } from "ccstate";

import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { bodyResultOf } from "../context/request";
import type { RouteEntry } from "../route-entry";
import { commerce$ } from "../services/commerce.service";

const searchBody$ = bodyResultOf(commerceContract.search);
const inspectBody$ = bodyResultOf(commerceContract.inspect);

const search$ = command(async ({ get, set }, signal: AbortSignal) => {
  const body = await get(searchBody$);
  signal.throwIfAborted();
  if (!body.ok) {
    return body.response;
  }
  return await set(
    commerce$,
    {
      auth: get(organizationAuthContext$),
      request: { operation: "search", body: body.data },
    },
    signal,
  );
});

const inspect$ = command(async ({ get, set }, signal: AbortSignal) => {
  const body = await get(inspectBody$);
  signal.throwIfAborted();
  if (!body.ok) {
    return body.response;
  }
  return await set(
    commerce$,
    {
      auth: get(organizationAuthContext$),
      request: { operation: "inspect", body: body.data },
    },
    signal,
  );
});

const commerceAuth = {
  requireOrganization: true,
  missingOrganizationStatus: 401,
  requiredCapability: "commerce:read",
} as const;

export const commerceRoutes: readonly RouteEntry[] = [
  { route: commerceContract.search, handler: authRoute(commerceAuth, search$) },
  {
    route: commerceContract.inspect,
    handler: authRoute(commerceAuth, inspect$),
  },
];
