import { scrapeContract } from "@okouai/api-contracts/contracts/scrape";
import { command } from "ccstate";

import { providerUnavailable } from "../../lib/error";
import { logger } from "../../lib/log";
import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { setResHeader$ } from "../context/hono";
import { bodyResultOf } from "../context/request";
import { clerkReadUnavailable } from "../external/clerk";
import type { RouteEntry } from "../route-entry";
import { scrape$ } from "../services/scrape.service";
import { settle } from "../utils";

const L = logger("Scrape");

const scrapeBody$ = bodyResultOf(scrapeContract.scrape);

const scrapeInner$ = command(async ({ get, set }, signal: AbortSignal) => {
  const auth = get(organizationAuthContext$);
  const bodyResult = await get(scrapeBody$);
  signal.throwIfAborted();
  if (!bodyResult.ok) {
    return bodyResult.response;
  }
  return await set(scrape$, { auth, body: bodyResult.data }, signal);
});

const authenticatedScrape$ = authRoute(
  {
    requireOrganization: true,
    missingOrganizationStatus: 401,
    requiredCapability: "scrape:read",
  },
  scrapeInner$,
);

const scrapeRoute$ = command(async ({ set }, signal: AbortSignal) => {
  const result = await settle(set(authenticatedScrape$, signal), signal);
  if (result.ok) {
    return result.value;
  }

  const unavailable = clerkReadUnavailable(result.error);
  if (!unavailable) {
    throw result.error;
  }

  L.error("Clerk read unavailable during scrape authentication", {
    type: "provider_unavailable",
    provider: "clerk",
    provider_status: unavailable.providerStatus,
    failure_class: unavailable.failureClass,
    method: "POST",
    route: "/api/scrape",
  });
  set(setResHeader$, "Cache-Control", "no-store");
  return providerUnavailable(
    "Authentication provider is temporarily unavailable",
  );
});

export const scrapeRoutes: readonly RouteEntry[] = [
  {
    route: scrapeContract.scrape,
    handler: scrapeRoute$,
  },
];
