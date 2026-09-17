import { morningBriefCalendarCollectionPreviewContract } from "@okouai/api-contracts/contracts/morning-brief-calendar-collection-preview";
import { command } from "ccstate";

import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { request$ } from "../context/hono";
import { bodyResultOf } from "../context/request";
import { clerk$ } from "../external/clerk";
import { writeDb$ } from "../external/db";
import type { RouteEntry } from "../route-entry";
import {
  collectMorningBriefCalendar,
  MORNING_BRIEF_CALENDAR_SOURCE_BUDGET_MS,
} from "../services/morning-brief-calendar-collection.service";
import {
  admitMorningBriefCollection,
  startMorningBriefSourceDeadline,
} from "../services/morning-brief-connector-reader.service";
import {
  isTestEndpointAllowed,
  testEndpointNotFoundResponse,
} from "./test-endpoint-helpers";

/**
 * The developer preview that makes calendar collection a real, reachable
 * consumer of the shared Morning Brief OAuth reader.
 *
 * It is registered in the ordinary application composition, so the production
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

const body$ = bodyResultOf(
  morningBriefCalendarCollectionPreviewContract.collect,
);

const collectCalendarInner$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const auth = get(organizationAuthContext$);
    const body = await get(body$);
    signal.throwIfAborted();
    if (!body.ok) {
      return body.response;
    }
    // A legitimate credential refresh and the erasure-admission transaction
    // both write, so this reader needs the writable handle even though it
    // only collects.
    const db = set(writeDb$);
    // The source deadline starts before the admission that reads canonical
    // state and this member's live membership, so a slow preflight shortens the
    // collection rather than handing it a fresh budget.
    const deadline = startMorningBriefSourceDeadline(
      MORNING_BRIEF_CALENDAR_SOURCE_BUDGET_MS,
    );
    // The anchor is the only caller input. Owner, Agent, installation,
    // timezone, account and every provider path come from canonical state.
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
      // A spent budget is not a refusal of authority, and admission is the one
      // phase with no collection envelope to answer with.
      return {
        status: 504 as const,
        body: {
          error: {
            message:
              "Morning Brief calendar preview is unavailable: deadline-exceeded",
            code: "GATEWAY_TIMEOUT" as const,
          },
        },
      };
    }
    if (admission.kind === "denied") {
      return forbidden(
        `Morning Brief calendar preview is unavailable: ${admission.reason}`,
      );
    }
    const collection = await collectMorningBriefCalendar(
      { db, clerk: get(clerk$), scope: admission.scope, deadline },
      signal,
    );
    signal.throwIfAborted();
    return { status: 200 as const, body: collection };
  },
);

const collectCalendarRoute$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    // Deployment gate before authentication: production never admits this route.
    if (!isTestEndpointAllowed(get(request$))) {
      return testEndpointNotFoundResponse();
    }
    return await set(authRoute(collectAuth, collectCalendarInner$), signal);
  },
);

export const morningBriefCalendarCollectionPreviewRoutes: readonly RouteEntry[] =
  [
    {
      route: morningBriefCalendarCollectionPreviewContract.collect,
      handler: collectCalendarRoute$,
    },
  ];
