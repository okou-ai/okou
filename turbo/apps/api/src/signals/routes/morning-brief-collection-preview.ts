import { createErrorResponse } from "@okouai/api-contracts/contracts/errors";
import { morningBriefCollectionPreviewContract } from "@okouai/api-contracts/contracts/morning-brief-collection-preview";
import { command } from "ccstate";

import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { request$ } from "../context/hono";
import { bodyResultOf } from "../context/request";
import type { RouteEntry } from "../route-entry";
import {
  executeMorningBriefSlackCollection$,
  type MorningBriefCollectionConflict,
} from "../services/morning-brief-collection-executor.service";
import {
  isPreviewEndpointAllowed,
  previewEndpointNotFoundResponse,
} from "./preview-endpoint-access";

/**
 * The development / protected-preview entrypoint for Slack collection.
 *
 * It is registered in the ordinary API route table, so an operator can actually
 * invoke it on a development server or a protected preview deployment. The
 * environment gate runs before authentication, so production answers 404
 * without doing any auth work, and it stays 404 even when `simpleMorningBrief`
 * is on for the caller.
 *
 * Everything else about this route is ordinary: the owner comes from the
 * authenticated organization and user, the native Slack read capability is
 * required, and the only input is the scheduled anchor. No owner, workspace,
 * channel, credential or cron secret can be supplied.
 */

function conflictResponse(reason: MorningBriefCollectionConflict): {
  readonly code: string;
  readonly message: string;
} {
  const responses: Record<
    MorningBriefCollectionConflict,
    { readonly code: string; readonly message: string }
  > = {
    "in-progress": {
      code: "MORNING_BRIEF_COLLECTION_IN_PROGRESS",
      message:
        "Another attempt holds an unexpired lease on this occurrence. Retry after it finishes or its lease expires.",
    },
    "retry-pending": {
      code: "MORNING_BRIEF_COLLECTION_RETRY_PENDING",
      message:
        "The previous attempt was rate limited. Retry after the reported Retry-After has elapsed.",
    },
    "attempts-exhausted": {
      code: "MORNING_BRIEF_COLLECTION_ATTEMPTS_EXHAUSTED",
      message: "This occurrence has consumed every permitted attempt.",
    },
    expired: {
      code: "MORNING_BRIEF_COLLECTION_EXPIRED",
      message:
        "This occurrence is older than the permitted collection lifetime.",
    },
    "binding-changed": {
      code: "MORNING_BRIEF_COLLECTION_BINDING_CHANGED",
      message:
        "The membership, installation, Agent or Slack binding changed since this occurrence was admitted. It cannot be retried under a different owner.",
    },
    "owner-revoked": {
      code: "MORNING_BRIEF_COLLECTION_OWNER_REVOKED",
      message:
        "Morning Brief collection ownership was revoked while this attempt ran. No collected data was accepted.",
    },
    "claim-lost": {
      code: "MORNING_BRIEF_COLLECTION_CLAIM_LOST",
      message:
        "This attempt no longer owns the occurrence. Its collected data was discarded.",
    },
  };
  return responses[reason];
}

const body$ = bodyResultOf(morningBriefCollectionPreviewContract.collect);

const collect$ = command(async ({ get, set }, signal: AbortSignal) => {
  const body = await get(body$);
  signal.throwIfAborted();
  if (!body.ok) {
    return body.response;
  }
  const auth = get(organizationAuthContext$);
  const scheduledFor = new Date(body.data.scheduledFor);
  const execution = await set(
    executeMorningBriefSlackCollection$,
    {
      owner: { orgId: auth.orgId, userId: auth.userId },
      scheduledFor,
    },
    signal,
  );
  signal.throwIfAborted();

  if (execution.kind === "invalid-anchor") {
    return createErrorResponse("BAD_REQUEST", execution.message);
  }
  if (execution.kind === "conflict") {
    const conflict = conflictResponse(execution.reason);
    return {
      status: 409 as const,
      body: { error: { code: conflict.code, message: conflict.message } },
    };
  }
  if (execution.kind === "not-executed") {
    return {
      status: 200 as const,
      body: { result: "not-executed" as const, reason: execution.reason },
    };
  }
  if (execution.kind === "already-completed") {
    return {
      status: 200 as const,
      body: {
        result: "already-completed" as const,
        occurrence: execution.occurrence,
        bundle: null,
      },
    };
  }
  if (execution.kind === "failed") {
    return {
      status: 200 as const,
      body: {
        result: "failed" as const,
        occurrence: execution.occurrence,
        failure: {
          outcome: execution.occurrence.outcome,
          ...(execution.retryAfterSeconds !== undefined && {
            retryAfterSeconds: execution.retryAfterSeconds,
          }),
        },
      },
    };
  }
  return {
    status: 200 as const,
    body: {
      result: "collected" as const,
      occurrence: execution.occurrence,
      bundle: execution.bundle,
    },
  };
});

const authorizedCollect$ = authRoute(
  {
    requireOrganization: true,
    missingOrganizationStatus: 401,
    requiredCapability: "slack:read",
  },
  collect$,
);

const run$ = command(async ({ get, set }, signal: AbortSignal) => {
  if (!isPreviewEndpointAllowed(get(request$))) {
    return previewEndpointNotFoundResponse();
  }
  return await set(authorizedCollect$, signal);
});

export const morningBriefCollectionPreviewRoutes: readonly RouteEntry[] = [
  { route: morningBriefCollectionPreviewContract.collect, handler: run$ },
];
