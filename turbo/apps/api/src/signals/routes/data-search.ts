import { dataSearchContract } from "@okouai/api-contracts/contracts/data-search";
import { command } from "ccstate";
import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { setResHeader$ } from "../context/hono";
import { bodyResultOf, pathParamsOf, queryOf } from "../context/request";
import { waitUntil } from "../context/wait-until";
import type { RouteEntry } from "../route-entry";
import { listDataSearchCapabilities } from "../services/data-search-catalog";
import {
  advanceDataSearchJob$,
  cancelDataSearchJob$,
  createDataSearchJob$,
  dataSearchError,
  getDataSearchJob$,
  listDataSearchJobs$,
  quoteDataSearch$,
} from "../services/data-search.service";

const quoteBody$ = bodyResultOf(dataSearchContract.quote);
const createBody$ = bodyResultOf(dataSearchContract.create);
const cancelBody$ = bodyResultOf(dataSearchContract.cancel);
const getParams$ = pathParamsOf(dataSearchContract.get);
const cancelParams$ = pathParamsOf(dataSearchContract.cancel);
const listQuery$ = queryOf(dataSearchContract.list);
const capabilitiesQuery$ = queryOf(dataSearchContract.capabilities);
const capabilitiesRoute$ = command(({ get, set }, signal: AbortSignal) => {
  signal.throwIfAborted();
  set(setResHeader$, "Cache-Control", "private, no-store");
  const query = get(capabilitiesQuery$).query?.toLowerCase();
  const auth = get(organizationAuthContext$);
  const capabilities = listDataSearchCapabilities().filter((item) => {
    if (
      auth.tokenType === "agent" &&
      !auth.capabilities.includes("data-enrichment:read") &&
      (item.id === "people.enrich" || item.id === "people.email")
    ) {
      return false;
    }
    return (
      !query || `${item.id} ${item.description}`.toLowerCase().includes(query)
    );
  });
  return { status: 200 as const, body: { capabilities } };
});
const quoteRoute$ = command(async ({ get, set }, signal: AbortSignal) => {
  set(setResHeader$, "Cache-Control", "private, no-store");
  const body = await get(quoteBody$);
  signal.throwIfAborted();
  if (!body.ok) {
    return body.response;
  }
  const auth = get(organizationAuthContext$);
  if (
    auth.tokenType === "agent" &&
    (body.data.capability === "people.enrich" ||
      body.data.capability === "people.email") &&
    !auth.capabilities.includes("data-enrichment:read")
  ) {
    return dataSearchError(
      403,
      "FORBIDDEN",
      "This operation requires data-enrichment:read.",
    );
  }
  return await set(quoteDataSearch$, { auth, body: body.data }, signal);
});
const createRoute$ = command(async ({ get, set }, signal: AbortSignal) => {
  set(setResHeader$, "Cache-Control", "private, no-store");
  const body = await get(createBody$);
  signal.throwIfAborted();
  if (!body.ok) {
    return body.response;
  }
  const auth = get(organizationAuthContext$);
  if (
    auth.tokenType === "agent" &&
    (body.data.capability === "people.enrich" ||
      body.data.capability === "people.email") &&
    !auth.capabilities.includes("data-enrichment:read")
  ) {
    return dataSearchError(
      403,
      "FORBIDDEN",
      "This operation requires data-enrichment:read.",
    );
  }
  const response = await set(
    createDataSearchJob$,
    { auth, body: body.data },
    signal,
  );
  if (response.status === 202 && response.body.billing.state === "pending") {
    waitUntil(
      set(
        advanceDataSearchJob$,
        response.body.jobId,
        AbortSignal.timeout(240_000),
      ),
    );
  }
  return response;
});
const getRoute$ = command(async ({ get, set }, signal: AbortSignal) => {
  set(setResHeader$, "Cache-Control", "private, no-store");
  const response = await set(
    getDataSearchJob$,
    { auth: get(organizationAuthContext$), jobId: get(getParams$).jobId },
    signal,
  );
  if (response.status === 200 && response.body.billing.state === "pending") {
    waitUntil(
      set(
        advanceDataSearchJob$,
        response.body.jobId,
        AbortSignal.timeout(240_000),
      ),
    );
  }
  return response;
});
const listRoute$ = command(async ({ get, set }, signal: AbortSignal) => {
  set(setResHeader$, "Cache-Control", "private, no-store");
  return await set(
    listDataSearchJobs$,
    { auth: get(organizationAuthContext$), query: get(listQuery$) },
    signal,
  );
});
const cancelRoute$ = command(async ({ get, set }, signal: AbortSignal) => {
  set(setResHeader$, "Cache-Control", "private, no-store");
  const body = await get(cancelBody$);
  signal.throwIfAborted();
  if (!body.ok) {
    return body.response;
  }
  const response = await set(
    cancelDataSearchJob$,
    { auth: get(organizationAuthContext$), jobId: get(cancelParams$).jobId },
    signal,
  );
  if (response.status === 200 && response.body.billing.state === "pending") {
    waitUntil(
      set(
        advanceDataSearchJob$,
        response.body.jobId,
        AbortSignal.timeout(240_000),
      ),
    );
  }
  return response;
});
const auth = {
  requireOrganization: true,
  missingOrganizationStatus: 401,
  requiredCapability: "data-search:read",
} as const;
export const dataSearchRoutes: readonly RouteEntry[] = [
  {
    route: dataSearchContract.capabilities,
    handler: authRoute(auth, capabilitiesRoute$),
  },
  { route: dataSearchContract.quote, handler: authRoute(auth, quoteRoute$) },
  { route: dataSearchContract.create, handler: authRoute(auth, createRoute$) },
  { route: dataSearchContract.get, handler: authRoute(auth, getRoute$) },
  { route: dataSearchContract.list, handler: authRoute(auth, listRoute$) },
  { route: dataSearchContract.cancel, handler: authRoute(auth, cancelRoute$) },
];
