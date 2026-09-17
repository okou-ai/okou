import { createErrorResponse } from "@okouai/api-contracts/contracts/errors";
import { morningBriefDeliveryPreviewContract } from "@okouai/api-contracts/contracts/morning-brief-delivery-preview";
import { command } from "ccstate";

import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { request$ } from "../context/hono";
import { bodyResultOf } from "../context/request";
import type { RouteEntry } from "../route-entry";
import {
  deliverMorningBriefResult$,
  type MorningBriefDeliveryRejection,
} from "../services/morning-brief-delivery.service";
import {
  isPreviewEndpointAllowed,
  previewEndpointNotFoundResponse,
} from "./preview-endpoint-access";

/**
 * The development / protected-preview entrypoint for native delivery.
 *
 * The environment gate runs before authentication, so production answers 404
 * without doing any auth work and stays 404 even when `simpleMorningBrief` is
 * on for the caller. Everything after it is ordinary: the owner comes from the
 * authenticated organization and user, and the only input is a reference to a
 * result that already exists for that owner.
 */

function rejectionCatalog(): Record<
  MorningBriefDeliveryRejection,
  {
    readonly status: 404 | 409;
    readonly code: string;
    readonly message: string;
  }
> {
  return {
    "result-not-found": {
      status: 404,
      code: "MORNING_BRIEF_RESULT_NOT_FOUND",
      message: "No Morning Brief result exists for this reference.",
    },
    "result-not-deliverable": {
      status: 409,
      code: "MORNING_BRIEF_RESULT_NOT_DELIVERABLE",
      message:
        "This generation has no accepted deliverable result. A skip, a failure and an unfinished attempt are all undeliverable.",
    },
    "result-expired": {
      status: 409,
      code: "MORNING_BRIEF_RESULT_EXPIRED",
      message:
        "This result is past its retention. An expired result is never recreated to repeat a delivery.",
    },
    "morning-brief-unavailable": {
      status: 409,
      code: "MORNING_BRIEF_UNAVAILABLE",
      message:
        "Morning Brief is not currently installed and enabled for this member, or its installation changed since the result was produced.",
    },
    "implementation-disabled": {
      status: 409,
      code: "MORNING_BRIEF_IMPLEMENTATION_DISABLED",
      message:
        "The simple-morning-brief implementation is off for this caller.",
    },
    "owner-revoked": {
      status: 409,
      code: "MORNING_BRIEF_OWNER_REVOKED",
      message:
        "Morning Brief ownership was revoked or the membership generation changed. Nothing was delivered.",
    },
    "destination-unavailable": {
      status: 409,
      code: "MORNING_BRIEF_DESTINATION_UNAVAILABLE",
      message: "This member has no Agent that can own a Morning Brief thread.",
    },
  };
}

const body$ = bodyResultOf(morningBriefDeliveryPreviewContract.preview);

const deliver$ = command(async ({ get, set }, signal: AbortSignal) => {
  const body = await get(body$);
  signal.throwIfAborted();
  if (!body.ok) {
    return body.response;
  }
  const auth = get(organizationAuthContext$);
  const outcome = await set(
    deliverMorningBriefResult$,
    {
      orgId: auth.orgId,
      userId: auth.userId,
      resultAttemptId: body.data.resultAttemptId,
    },
    signal,
  );
  signal.throwIfAborted();

  if (outcome.kind === "rejected") {
    const rejection = rejectionCatalog()[outcome.reason];
    if (rejection.status === 404) {
      return createErrorResponse("NOT_FOUND", rejection.message);
    }
    return {
      status: 409 as const,
      body: { error: { code: rejection.code, message: rejection.message } },
    };
  }

  return {
    status: 200 as const,
    body: {
      result: outcome.kind,
      delivery: {
        chatThreadId: outcome.chatThreadId,
        chatEventId: outcome.chatEventId,
        emailResolution: outcome.emailResolution,
        deliveredAt: outcome.deliveredAt,
      },
    },
  };
});

const authorizedDeliver$ = authRoute(
  {
    requireOrganization: true,
    missingOrganizationStatus: 401,
    requiredCapability: "agent:write",
  },
  deliver$,
);

const run$ = command(async ({ get, set }, signal: AbortSignal) => {
  if (!isPreviewEndpointAllowed(get(request$))) {
    return previewEndpointNotFoundResponse();
  }
  return await set(authorizedDeliver$, signal);
});

export const morningBriefDeliveryPreviewRoutes: readonly RouteEntry[] = [
  { route: morningBriefDeliveryPreviewContract.preview, handler: run$ },
];
