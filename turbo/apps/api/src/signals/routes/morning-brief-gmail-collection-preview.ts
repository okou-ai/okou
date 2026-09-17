import { morningBriefGmailCollectionPreviewContract } from "@okouai/api-contracts/contracts/morning-brief-gmail-collection-preview";
import { command } from "ccstate";

import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { request$ } from "../context/hono";
import { bodyResultOf } from "../context/request";
import { clerk$ } from "../external/clerk";
import { writeDb$ } from "../external/db";
import type { RouteEntry } from "../route-entry";
import { admitMorningBriefCollection } from "../services/morning-brief-connector-reader.service";
import { collectMorningBriefGmail } from "../services/morning-brief-gmail-collection.service";
import {
  isTestEndpointAllowed,
  testEndpointNotFoundResponse,
} from "./test-endpoint-helpers";

/**
 * The developer preview that makes Gmail collection a real, reachable consumer
 * of the shared Morning Brief OAuth reader.
 *
 * It is registered in the ordinary application composition so the production
 * gate, authentication and ownership checks are the deployed ones. Production
 * answers 404 before authentication regardless of `simpleMorningBrief`, so the
 * feature switch never exposes this surface. There is no Settings UI, no
 * durable ownership and no scheduled delivery here; the result is ephemeral.
 */

const collectAuth = {
  requireOrganization: true,
  missingOrganizationStatus: 401,
  requiredCapability: "agent:read",
} as const;

function forbidden(message: string) {
  return {
    status: 403 as const,
    body: { error: { message, code: "FORBIDDEN" as const } },
  };
}

const body$ = bodyResultOf(morningBriefGmailCollectionPreviewContract.collect);

const collectGmailInner$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const auth = get(organizationAuthContext$);
    const body = await get(body$);
    signal.throwIfAborted();
    if (!body.ok) {
      return body.response;
    }
    // A legitimate credential refresh and the erasure-admission transaction both
    // write, so this reader needs the writable handle even though it collects.
    const db = set(writeDb$);
    // The anchor is the only caller input. Owner, Agent, installation, account
    // and every provider path are derived from canonical state.
    const admission = await admitMorningBriefCollection(
      {
        db,
        clerk: get(clerk$),
        orgId: auth.orgId,
        userId: auth.userId,
        anchor: new Date(body.data.anchor),
      },
      signal,
    );
    signal.throwIfAborted();
    if (admission.kind === "denied") {
      return forbidden(
        `Morning Brief Gmail preview is unavailable: ${admission.reason}`,
      );
    }
    const collection = await collectMorningBriefGmail(
      { db, clerk: get(clerk$), scope: admission.scope },
      signal,
    );
    signal.throwIfAborted();
    return { status: 200 as const, body: collection };
  },
);

const collectGmailRoute$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    // Deployment gate before authentication: production never admits this route.
    if (!isTestEndpointAllowed(get(request$))) {
      return testEndpointNotFoundResponse();
    }
    return await set(authRoute(collectAuth, collectGmailInner$), signal);
  },
);

export const morningBriefGmailCollectionPreviewRoutes: readonly RouteEntry[] = [
  {
    route: morningBriefGmailCollectionPreviewContract.collect,
    handler: collectGmailRoute$,
  },
];
