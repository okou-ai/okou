import { commerceContract } from "@okouai/api-contracts/contracts/commerce";
import { command } from "ccstate";

import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { setResHeader$ } from "../context/hono";
import { bodyResultOf, pathParamsOf } from "../context/request";
import type { RouteEntry } from "../route-entry";
import { commerce$ } from "../services/commerce.service";
import {
  createCommerceJob$,
  getCommerceJob$,
} from "../services/commerce-job.service";

const searchBody$ = bodyResultOf(commerceContract.search);
const inspectBody$ = bodyResultOf(commerceContract.inspect);
const jobParams$ = pathParamsOf(commerceContract.getJob);

const getJob$ = command(async ({ get, set }, signal: AbortSignal) => {
  set(setResHeader$, "Cache-Control", "private, no-store");
  return await set(
    getCommerceJob$,
    {
      auth: get(organizationAuthContext$),
      id: get(jobParams$).id,
    },
    signal,
  );
});

const search$ = command(async ({ get, set }, signal: AbortSignal) => {
  const body = await get(searchBody$);
  signal.throwIfAborted();
  if (!body.ok) {
    return body.response;
  }
  set(setResHeader$, "Cache-Control", "private, no-store");
  if (body.data.async) {
    return await set(
      createCommerceJob$,
      {
        auth: get(organizationAuthContext$),
        request: { operation: "search", body: body.data },
        requestId: body.data.requestId,
      },
      signal,
    );
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
  set(setResHeader$, "Cache-Control", "private, no-store");
  if (body.data.async) {
    return await set(
      createCommerceJob$,
      {
        auth: get(organizationAuthContext$),
        request: { operation: "inspect", body: body.data },
        requestId: body.data.requestId,
      },
      signal,
    );
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
  { route: commerceContract.getJob, handler: authRoute(commerceAuth, getJob$) },
  { route: commerceContract.search, handler: authRoute(commerceAuth, search$) },
  {
    route: commerceContract.inspect,
    handler: authRoute(commerceAuth, inspect$),
  },
];
