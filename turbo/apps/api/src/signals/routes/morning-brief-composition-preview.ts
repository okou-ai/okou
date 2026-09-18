import { createErrorResponse } from "@okouai/api-contracts/contracts/errors";
import { morningBriefCompositionPreviewContract } from "@okouai/api-contracts/contracts/morning-brief-composition-preview";
import { command } from "ccstate";

import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { request$ } from "../context/hono";
import { bodyResultOf } from "../context/request";
import type { RouteEntry } from "../route-entry";
import { composeMorningBrief$ } from "../services/morning-brief-composition.service";
import { executeMorningBriefComposedGeneration$ } from "../services/morning-brief-composed-generation.service";
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
      // The caller's budget, which the composition may only tighten with.
      deadlineAt:
        body.data.deadlineAt === undefined
          ? null
          : new Date(body.data.deadlineAt),
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
        sources: outcome.sources,
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

const generateBody$ = bodyResultOf(
  morningBriefCompositionPreviewContract.generate,
);

/**
 * The registered entry point that actually generates from every source.
 *
 * It runs the same engine a natively scheduled brief runs — one reservation,
 * one platform-funded request, one accepted result — for the authenticated
 * owner and the supplied anchor only. No owner, workspace, account, model,
 * prompt, source set or credential can be supplied, and nothing accepted here
 * is delivered anywhere.
 */
const generateInner$ = command(async ({ get, set }, signal: AbortSignal) => {
  const auth = get(organizationAuthContext$);
  const body = await get(generateBody$);
  signal.throwIfAborted();
  if (!body.ok) {
    return body.response;
  }
  const execution = await set(
    executeMorningBriefComposedGeneration$,
    {
      owner: { orgId: auth.orgId, userId: auth.userId },
      scheduledFor: new Date(body.data.anchor),
      purpose: "preview",
    },
    signal,
  );
  signal.throwIfAborted();

  if (execution.kind === "invalid-anchor") {
    return createErrorResponse("BAD_REQUEST", execution.message);
  }
  if (execution.kind === "denied") {
    return {
      status: 403 as const,
      body: {
        error: {
          message: `Morning Brief generation is unavailable: ${execution.reason}`,
          code: "FORBIDDEN" as const,
        },
      },
    };
  }
  if (execution.kind === "conflict") {
    return {
      status: 409 as const,
      body: {
        error: {
          code: "MORNING_BRIEF_GENERATION_CONFLICT",
          message: `This morning is already owned by another attempt: ${execution.reason}. No second provider request is made.`,
        },
      },
    };
  }
  if (execution.kind === "authority-changed") {
    return {
      status: 200 as const,
      body: { result: "authority-changed" as const },
    };
  }
  if (execution.kind === "incomplete") {
    return {
      status: 200 as const,
      body: {
        result: "incomplete" as const,
        reason: execution.reason,
        detail: execution.detail,
      },
    };
  }
  if (execution.kind === "not-executed") {
    return {
      status: 200 as const,
      body: { result: "not-executed" as const, reason: execution.reason },
    };
  }
  if (execution.kind === "collection-failed") {
    return {
      status: 200 as const,
      body: {
        result: "collection-failed" as const,
        occurrence: execution.occurrence,
      },
    };
  }
  if (execution.kind === "collection-completed-without-generation") {
    return {
      status: 200 as const,
      body: {
        result: "collection-completed-without-generation" as const,
        occurrence: execution.occurrence,
      },
    };
  }
  return {
    status: 200 as const,
    body: {
      result:
        execution.kind === "generated"
          ? ("generated" as const)
          : ("already-generated" as const),
      occurrence: execution.occurrence,
      generation: execution.generation,
    },
  };
});

const generateRoute$ = command(async ({ get, set }, signal: AbortSignal) => {
  // Deployment gate before authentication: production never admits this route.
  if (!isTestEndpointAllowed(get(request$))) {
    return testEndpointNotFoundResponse();
  }
  return await set(authRoute(composeAuth, generateInner$), signal);
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
  {
    route: morningBriefCompositionPreviewContract.generate,
    handler: generateRoute$,
  },
];
