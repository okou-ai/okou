import { morningBriefGmailCollectionPreviewContract } from "@okouai/api-contracts/contracts/morning-brief-gmail-collection-preview";
import { command } from "ccstate";

import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { request$ } from "../context/hono";
import { bodyResultOf } from "../context/request";
import { clerk$ } from "../external/clerk";
import { writeDb$ } from "../external/db";
import type { RouteEntry } from "../route-entry";
import {
  admitMorningBriefCollection,
  freezeMorningBriefSourceSelection,
  startMorningBriefSourceDeadline,
} from "../services/morning-brief-connector-reader.service";
import {
  collectMorningBriefGmail,
  MORNING_BRIEF_GMAIL_SOURCE_BUDGET_MS,
} from "../services/morning-brief-gmail-collection.service";
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

/**
 * The source budget ran out before an installation was resolved.
 *
 * Admission is the one phase with no collection envelope to answer with: the
 * timezone and window that envelope names are exactly what it had not read yet.
 * A spent budget is not a refusal of authority, so it is reported as its own
 * outcome instead of borrowing the denial status.
 */
function sourceDeadlineExceeded() {
  return {
    status: 504 as const,
    body: {
      error: {
        message:
          "Morning Brief Gmail preview is unavailable: deadline-exceeded",
        code: "GATEWAY_TIMEOUT" as const,
      },
    },
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
    // The source deadline starts here, before the admission that reads the
    // canonical installation and this member's live Clerk membership, so a slow
    // preflight shortens the collection rather than handing it a fresh budget.
    const deadline = startMorningBriefSourceDeadline(
      MORNING_BRIEF_GMAIL_SOURCE_BUDGET_MS,
    );
    // The anchor is the only caller input. Owner, Agent, installation, account
    // and every provider path are derived from canonical state.
    const admission = await admitMorningBriefCollection(
      {
        db,
        clerk: get(clerk$),
        orgId: auth.orgId,
        userId: auth.userId,
        anchor: new Date(body.data.anchor),
        deadline,
      },
      signal,
    );
    signal.throwIfAborted();
    if (admission.kind === "unavailable") {
      return sourceDeadlineExceeded();
    }
    if (admission.kind === "denied") {
      return forbidden(
        `Morning Brief Gmail preview is unavailable: ${admission.reason}`,
      );
    }
    // One source, so admission is also the moment its account choice freezes.
    const authority = await freezeMorningBriefSourceSelection(
      db,
      admission.scope,
      "gmail",
    );
    signal.throwIfAborted();
    const collection = await collectMorningBriefGmail(
      { db, clerk: get(clerk$), scope: admission.scope, authority, deadline },
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
