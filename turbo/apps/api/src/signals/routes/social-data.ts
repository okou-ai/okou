import { socialDataContract } from "@okouai/api-contracts/contracts/social-data";
import { command } from "ccstate";

import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { setResHeader$ } from "../context/hono";
import { bodyResultOf, pathParamsOf, queryOf } from "../context/request";
import { waitUntil } from "../context/wait-until";
import type { RouteEntry } from "../route-entry";
import {
  advanceSocialDataJob$,
  cancelSocialDataJob$,
  createSocialDataJob$,
  getSocialDataJob$,
  listSocialDataJobs$,
  quoteSocialData$,
  SOCIAL_DATA_RECONCILIATION_TIMEOUT_MS,
} from "../services/social-data.service";

const quoteBody$ = bodyResultOf(socialDataContract.quote);
const createBody$ = bodyResultOf(socialDataContract.create);
const cancelBody$ = bodyResultOf(socialDataContract.cancel);
const getParams$ = pathParamsOf(socialDataContract.get);
const cancelParams$ = pathParamsOf(socialDataContract.cancel);
const listQuery$ = queryOf(socialDataContract.list);

const quoteSocialDataRoute$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    set(setResHeader$, "Cache-Control", "private, no-store");
    const body = await get(quoteBody$);
    signal.throwIfAborted();
    if (!body.ok) {
      return body.response;
    }
    return await set(
      quoteSocialData$,
      { auth: get(organizationAuthContext$), body: body.data },
      signal,
    );
  },
);

const createSocialDataRoute$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    set(setResHeader$, "Cache-Control", "private, no-store");
    const body = await get(createBody$);
    signal.throwIfAborted();
    if (!body.ok) {
      return body.response;
    }
    const response = await set(
      createSocialDataJob$,
      { auth: get(organizationAuthContext$), body: body.data },
      signal,
    );
    if (response.status === 202 && response.body.billing.state === "pending") {
      waitUntil(
        set(
          advanceSocialDataJob$,
          response.body.jobId,
          AbortSignal.timeout(SOCIAL_DATA_RECONCILIATION_TIMEOUT_MS),
        ),
      );
    }
    return response;
  },
);

const getSocialDataRoute$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    set(setResHeader$, "Cache-Control", "private, no-store");
    return await set(
      getSocialDataJob$,
      { auth: get(organizationAuthContext$), jobId: get(getParams$).jobId },
      signal,
    );
  },
);

const listSocialDataRoute$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    set(setResHeader$, "Cache-Control", "private, no-store");
    return await set(
      listSocialDataJobs$,
      { auth: get(organizationAuthContext$), query: get(listQuery$) },
      signal,
    );
  },
);

const cancelSocialDataRoute$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    set(setResHeader$, "Cache-Control", "private, no-store");
    const body = await get(cancelBody$);
    signal.throwIfAborted();
    if (!body.ok) {
      return body.response;
    }
    return await set(
      cancelSocialDataJob$,
      { auth: get(organizationAuthContext$), jobId: get(cancelParams$).jobId },
      signal,
    );
  },
);

const socialDataAuth = {
  requireOrganization: true,
  missingOrganizationStatus: 401,
  requiredCapability: "social:read",
} as const;

export const socialDataRoutes: readonly RouteEntry[] = [
  {
    route: socialDataContract.quote,
    handler: authRoute(socialDataAuth, quoteSocialDataRoute$),
  },
  {
    route: socialDataContract.create,
    handler: authRoute(socialDataAuth, createSocialDataRoute$),
  },
  {
    route: socialDataContract.get,
    handler: authRoute(socialDataAuth, getSocialDataRoute$),
  },
  {
    route: socialDataContract.list,
    handler: authRoute(socialDataAuth, listSocialDataRoute$),
  },
  {
    route: socialDataContract.cancel,
    handler: authRoute(socialDataAuth, cancelSocialDataRoute$),
  },
];
