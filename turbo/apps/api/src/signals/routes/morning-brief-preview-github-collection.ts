import { createErrorResponse } from "@okouai/api-contracts/contracts/errors";
import { morningBriefGithubCollectionContract } from "@okouai/api-contracts/contracts/morning-brief-github-collection";
import { command } from "ccstate";

import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { request$ } from "../context/hono";
import { bodyResultOf } from "../context/request";
import type { RouteEntry } from "../route-entry";
import { executeMorningBriefGithubCollection$ } from "../services/morning-brief-github-collection.service";
import {
  isTestEndpointAllowed,
  testEndpointNotFoundResponse,
} from "./test-endpoint-helpers";

/**
 * The development / protected-preview entrypoint for GitHub collection.
 *
 * It is registered in the ordinary production route table, which is the point:
 * a preview surface that only exists inside its own test suite proves nothing
 * about the real application's ingress. What keeps it away from production is
 * `isTestEndpointAllowed`, evaluated *before* authentication, so production
 * answers 404 without doing any auth work — including for a caller who has
 * `simpleMorningBrief` enabled.
 *
 * Everything else about this route is ordinary. The owner is the authenticated
 * organization and user, the GitHub read capability is required, and the only
 * input is the scheduled anchor. No owner, Agent, connector account,
 * repository, query or URL can be supplied.
 */

const body$ = bodyResultOf(morningBriefGithubCollectionContract.collect);

const collect$ = command(async ({ get, set }, signal: AbortSignal) => {
  const body = await get(body$);
  signal.throwIfAborted();
  if (!body.ok) {
    return body.response;
  }
  const auth = get(organizationAuthContext$);
  const execution = await set(
    executeMorningBriefGithubCollection$,
    {
      owner: { orgId: auth.orgId, userId: auth.userId },
      anchor: new Date(body.data.scheduledFor),
    },
    signal,
  );
  signal.throwIfAborted();

  if (execution.kind === "invalid-anchor") {
    return createErrorResponse("BAD_REQUEST", execution.message);
  }
  if (execution.kind === "not-executed") {
    return {
      status: 200 as const,
      body: { result: "not-executed" as const, reason: execution.reason },
    };
  }
  return {
    status: 200 as const,
    body: { result: "collected" as const, bundle: execution.bundle },
  };
});

const authorizedCollect$ = authRoute(
  {
    requireOrganization: true,
    missingOrganizationStatus: 401,
    requiredCapability: "github:read",
  },
  collect$,
);

const run$ = command(async ({ get, set }, signal: AbortSignal) => {
  if (!isTestEndpointAllowed(get(request$))) {
    return testEndpointNotFoundResponse();
  }
  return await set(authorizedCollect$, signal);
});

export const morningBriefPreviewGithubCollectionRoutes: readonly RouteEntry[] =
  [{ route: morningBriefGithubCollectionContract.collect, handler: run$ }];
