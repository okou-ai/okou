import { createErrorResponse } from "@okouai/api-contracts/contracts/errors";
import { morningBriefChatCollectionPreviewContract } from "@okouai/api-contracts/contracts/morning-brief-chat-collection-preview";
import { isFeatureEnabled } from "@okouai/core/feature-switch";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { command } from "ccstate";

import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { request$ } from "../context/hono";
import { bodyResultOf } from "../context/request";
import type { RouteEntry } from "../route-entry";
import { userFeatureSwitchOverrides } from "../services/feature-switches.service";
import { collectMorningBriefChat$ } from "../services/morning-brief-chat-collection.service";
import {
  isPreviewEndpointAllowed,
  previewEndpointNotFoundResponse,
} from "./preview-endpoint-access";

/**
 * The development / protected-preview entrypoint for unread Chat collection.
 *
 * It is registered in the ordinary API route table, so an operator can actually
 * invoke it on a development server or a protected preview deployment. The
 * environment gate runs before authentication, so production answers 404
 * without doing any auth work, and it stays 404 even when `simpleMorningBrief`
 * is on for the caller.
 *
 * Everything else about this route is ordinary. The owner comes from the
 * authenticated organization and user, Chat event read capability is required,
 * and the member must actually own an installed, enabled Morning Brief. The
 * only input is the scheduled anchor: no thread, owner, Agent or destination
 * can be supplied. There is no Settings surface for it and it writes nothing.
 */

const body$ = bodyResultOf(morningBriefChatCollectionPreviewContract.collect);

const collect$ = command(async ({ get, set }, signal: AbortSignal) => {
  const body = await get(body$);
  signal.throwIfAborted();
  if (!body.ok) {
    return body.response;
  }
  const auth = get(organizationAuthContext$);
  const overrides = await get(
    userFeatureSwitchOverrides(auth.orgId, auth.userId),
  );
  signal.throwIfAborted();
  if (
    !isFeatureEnabled(FeatureSwitchKey.SimpleMorningBrief, {
      orgId: auth.orgId,
      userId: auth.userId,
      overrides,
    })
  ) {
    return createErrorResponse("FORBIDDEN", "Morning Brief is not enabled");
  }

  const collection = await set(
    collectMorningBriefChat$,
    {
      owner: { orgId: auth.orgId, userId: auth.userId },
      scheduledFor: new Date(body.data.scheduledFor),
    },
    signal,
  );
  signal.throwIfAborted();

  if (collection.kind === "invalid-anchor") {
    return createErrorResponse("BAD_REQUEST", collection.message);
  }
  if (collection.kind === "not-installed") {
    return createErrorResponse(
      "FORBIDDEN",
      "This member has no enabled Morning Brief to collect for",
    );
  }
  if (collection.kind === "owner-unavailable") {
    return createErrorResponse(
      "FORBIDDEN",
      "Morning Brief collection authority was withdrawn while this collection ran",
    );
  }
  return { status: 200 as const, body: collection.collection };
});

const authorizedCollect$ = authRoute(
  {
    requireOrganization: true,
    missingOrganizationStatus: 401,
    requiredCapability: "chat-event:read",
  },
  collect$,
);

const run$ = command(async ({ get, set }, signal: AbortSignal) => {
  if (!isPreviewEndpointAllowed(get(request$))) {
    return previewEndpointNotFoundResponse();
  }
  return await set(authorizedCollect$, signal);
});

export const morningBriefChatCollectionPreviewRoutes: readonly RouteEntry[] = [
  { route: morningBriefChatCollectionPreviewContract.collect, handler: run$ },
];
