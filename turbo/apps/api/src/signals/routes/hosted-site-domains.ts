import { settle } from "../utils";
import { command } from "ccstate";
import { hostContract } from "@okouai/api-contracts/contracts/host";
import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { bodyResultOf, pathParamsOf, queryOf } from "../context/request";
import { setResHeader$ } from "../context/hono";
import {
  HostedDomainError,
  addHostedSiteDomain$,
  hostedDomainProbe$,
  readHostedSiteDomains$,
  readHostedSiteDomainSetup$,
  removeHostedSiteDomain$,
  resolveHostedCustomDomain$,
  selectHostedSiteDomain$,
  verifyHostedSiteDomain$,
} from "../services/hosted-site-domains.service";
import type { RouteEntry } from "../route-entry";

async function ownerResponse<T>(operation: Promise<T>) {
  const result = await settle(operation);
  if (result.ok) {
    return { status: 200 as const, body: result.value };
  }
  const error = result.error;
  if (error instanceof HostedDomainError) {
    return {
      status: error.status,
      body: { error: { code: error.code, message: error.message } },
    };
  }
  throw error;
}
const list$ = command(({ get, set }, signal: AbortSignal) => {
  set(setResHeader$, "Cache-Control", "private, no-store");
  return ownerResponse(
    set(
      readHostedSiteDomains$,
      {
        ...get(organizationAuthContext$),
        ...get(pathParamsOf(hostContract.siteDomains)),
      },
      signal,
    ),
  );
});
const setup$ = command(({ get, set }, signal: AbortSignal) => {
  set(setResHeader$, "Cache-Control", "private, no-store");
  return ownerResponse(
    set(
      readHostedSiteDomainSetup$,
      {
        ...get(organizationAuthContext$),
        ...get(pathParamsOf(hostContract.siteDomainSetup)),
      },
      signal,
    ),
  );
});
const add$ = command(async ({ get, set }, signal: AbortSignal) => {
  set(setResHeader$, "Cache-Control", "private, no-store");
  const body = await get(bodyResultOf(hostContract.addSiteDomain));
  signal.throwIfAborted();
  if (!body.ok) {
    return body.response;
  }
  return ownerResponse(
    set(
      addHostedSiteDomain$,
      {
        ...get(organizationAuthContext$),
        ...get(pathParamsOf(hostContract.addSiteDomain)),
        ...body.data,
      },
      signal,
    ),
  );
});
const verify$ = command(async ({ get, set }, signal: AbortSignal) => {
  set(setResHeader$, "Cache-Control", "private, no-store");
  const body = await get(bodyResultOf(hostContract.verifySiteDomain));
  signal.throwIfAborted();
  if (!body.ok) {
    return body.response;
  }
  return ownerResponse(
    set(
      verifyHostedSiteDomain$,
      {
        ...get(organizationAuthContext$),
        ...get(pathParamsOf(hostContract.verifySiteDomain)),
        ...body.data,
      },
      signal,
    ),
  );
});
const remove$ = command(async ({ get, set }, signal: AbortSignal) => {
  set(setResHeader$, "Cache-Control", "private, no-store");
  const body = await get(bodyResultOf(hostContract.removeSiteDomain));
  signal.throwIfAborted();
  if (!body.ok) {
    return body.response;
  }
  return ownerResponse(
    set(
      removeHostedSiteDomain$,
      {
        ...get(organizationAuthContext$),
        ...get(pathParamsOf(hostContract.removeSiteDomain)),
        ...body.data,
      },
      signal,
    ),
  );
});
const select$ = command(async ({ get, set }, signal: AbortSignal) => {
  set(setResHeader$, "Cache-Control", "private, no-store");
  const body = await get(bodyResultOf(hostContract.selectSiteDomain));
  signal.throwIfAborted();
  if (!body.ok) {
    return body.response;
  }
  return ownerResponse(
    set(
      selectHostedSiteDomain$,
      {
        ...get(organizationAuthContext$),
        ...get(pathParamsOf(hostContract.selectSiteDomain)),
        ...body.data,
      },
      signal,
    ),
  );
});
const resolve$ = command(async ({ get, set }, signal: AbortSignal) => {
  set(setResHeader$, "Cache-Control", "no-store");
  return {
    status: 200 as const,
    body: await set(
      resolveHostedCustomDomain$,
      get(pathParamsOf(hostContract.resolveCustomDomain)).hostname,
      signal,
    ),
  };
});
const probe$ = command(async ({ get, set }, signal: AbortSignal) => {
  set(setResHeader$, "Cache-Control", "no-store");
  return {
    status: 200 as const,
    body: await set(
      hostedDomainProbe$,
      {
        ...get(pathParamsOf(hostContract.customDomainProbe)),
        ...get(queryOf(hostContract.customDomainProbe)),
      },
      signal,
    ),
  };
});
const ownerAuth = {
  requiredCapability: "host:write",
  requireOrganization: true,
  missingOrganizationStatus: 401,
} as const;
export const hostedSiteDomainRoutes: readonly RouteEntry[] = [
  { route: hostContract.siteDomains, handler: authRoute(ownerAuth, list$) },
  {
    route: hostContract.siteDomainSetup,
    handler: authRoute(ownerAuth, setup$),
  },
  { route: hostContract.addSiteDomain, handler: authRoute(ownerAuth, add$) },
  {
    route: hostContract.verifySiteDomain,
    handler: authRoute(ownerAuth, verify$),
  },
  {
    route: hostContract.removeSiteDomain,
    handler: authRoute(ownerAuth, remove$),
  },
  {
    route: hostContract.selectSiteDomain,
    handler: authRoute(ownerAuth, select$),
  },
  { route: hostContract.resolveCustomDomain, handler: resolve$ },
  { route: hostContract.customDomainProbe, handler: probe$ },
];
