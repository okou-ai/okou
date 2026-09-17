import { morningBriefCompositionPreviewContract } from "@okouai/api-contracts/contracts/morning-brief-composition-preview";
import { command } from "ccstate";

import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { request$ } from "../context/hono";
import { bodyResultOf } from "../context/request";
import type { RouteEntry } from "../route-entry";
import { composeMorningBrief$ } from "../services/morning-brief-composition.service";
import {
  isTestEndpointAllowed,
  testEndpointNotFoundResponse,
} from "./test-endpoint-helpers";

/**
 * The registered preview that runs the real source-independent composition.
 *
 * Its whole point is that no connector gates it. The Slack preview refuses an
 * owner without a Slack installation; this one admits the owner through the
 * shared admission, reads whichever sources they actually have, and composes
 * what it finds — a Gmail-only owner gets a Gmail brief, and an owner with
 * nothing connected gets an honest empty answer rather than a rejection.
 *
 * Production answers 404 before authentication regardless of
 * `simpleMorningBrief`, so the feature switch never exposes this surface, and a
 * preview composition is never promoted into production delivery.
 */

const composeAuth = {
  requireOrganization: true,
  missingOrganizationStatus: 401,
  requiredCapability: "agent:read",
} as const;

const body$ = bodyResultOf(morningBriefCompositionPreviewContract.compose);

const composeInner$ = command(async ({ get, set }, signal: AbortSignal) => {
  const auth = get(organizationAuthContext$);
  const body = await get(body$);
  signal.throwIfAborted();
  if (!body.ok) {
    return body.response;
  }
  const outcome = await set(
    composeMorningBrief$,
    {
      orgId: auth.orgId,
      userId: auth.userId,
      anchor: new Date(body.data.anchor),
    },
    signal,
  );
  signal.throwIfAborted();
  if (outcome.kind === "denied") {
    return {
      status: 403 as const,
      body: {
        error: {
          message: `Morning Brief composition preview is unavailable: ${outcome.reason}`,
          code: "FORBIDDEN" as const,
        },
      },
    };
  }
  if (outcome.kind === "incomplete") {
    return {
      status: 200 as const,
      body: {
        result: "incomplete" as const,
        reason: outcome.reason,
        detail: outcome.detail,
      },
    };
  }
  if (outcome.kind === "authority-changed") {
    return {
      status: 200 as const,
      body: { result: "authority-changed" as const },
    };
  }
  return {
    status: 200 as const,
    body: { result: outcome.kind, composition: outcome.result },
  };
});

const composeRoute$ = command(async ({ get, set }, signal: AbortSignal) => {
  // Deployment gate before authentication: production never admits this route.
  if (!isTestEndpointAllowed(get(request$))) {
    return testEndpointNotFoundResponse();
  }
  return await set(authRoute(composeAuth, composeInner$), signal);
});

export const morningBriefCompositionPreviewRoutes: readonly RouteEntry[] = [
  {
    route: morningBriefCompositionPreviewContract.compose,
    handler: composeRoute$,
  },
];
