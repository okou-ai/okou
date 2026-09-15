import { sharedThreadsContract } from "@okouai/api-contracts/contracts/shared-threads";
import { command } from "ccstate";

import { badRequestMessage, notFound } from "../../lib/error";
import { deleteSharedThread$ } from "../services/shared-thread-artifacts.service";
import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { requestSignal$, setResHeader$ } from "../context/hono";
import { bodyResultOf, pathParamsOf } from "../context/request";
import {
  createSharedThread$,
  readSharedThread$,
  readSharedThreadMeta$,
} from "../services/shared-thread.service";
import type { RouteEntry } from "../route-entry";
import { PUBLIC_BRAND } from "@okouai/core/public-brand";

const createBody$ = bodyResultOf(sharedThreadsContract.create);

const noShareableMessages = Object.freeze({
  status: 400 as const,
  body: Object.freeze({
    error: Object.freeze({
      message: "The selection contains no shareable messages",
      code: "NO_SHAREABLE_MESSAGES" as const,
    }),
  }),
});

const sharedThreadTooLarge = Object.freeze({
  status: 413 as const,
  body: Object.freeze({
    error: Object.freeze({
      message: "The selected messages are too large to share",
      code: "SHARED_THREAD_TOO_LARGE" as const,
    }),
  }),
});

const sharedThreadAttachmentsForbidden = Object.freeze({
  status: 403 as const,
  body: {
    error: {
      message: "Sharing attachments requires file:read capability",
      code: "FORBIDDEN",
    },
  },
});

const createSharedThreadInner$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const creationSignal = AbortSignal.any([signal, get(requestSignal$)]);
    const auth = get(organizationAuthContext$);
    const publicBrand = PUBLIC_BRAND;
    const body = await get(createBody$);
    signal.throwIfAborted();
    creationSignal.throwIfAborted();
    if (!body.ok) {
      return body.response;
    }

    const params = get(pathParamsOf(sharedThreadsContract.create));
    const result = await set(
      createSharedThread$,
      {
        orgId: auth.orgId,
        userId: auth.userId,
        threadId: params.threadId,
        eventIds: body.data.eventIds,
        publicBrand,
        canReadAttachments:
          auth.tokenType !== "agent" ||
          auth.capabilities?.includes("file:read") === true,
      },
      creationSignal,
    );
    signal.throwIfAborted();
    creationSignal.throwIfAborted();
    if (result.kind === "thread-not-found") {
      return notFound("Chat thread not found");
    }
    if (result.kind === "no-shareable-messages") {
      return noShareableMessages;
    }
    if (result.kind === "too-large") {
      return sharedThreadTooLarge;
    }
    if (result.kind === "attachments-forbidden") {
      return sharedThreadAttachmentsForbidden;
    }
    if (result.kind === "artifact-unavailable") {
      return badRequestMessage(
        "A selected artifact or hosted dependency is unavailable for sharing",
      );
    }
    return { status: 201 as const, body: { id: result.id } };
  },
);

const getSharedThread$ = command(async ({ get, set }, signal: AbortSignal) => {
  const params = get(pathParamsOf(sharedThreadsContract.get));
  const row = await set(readSharedThread$, params.id, signal);
  signal.throwIfAborted();
  set(setResHeader$, "Cache-Control", "no-store");
  if (!row) {
    return notFound("Shared conversation not found");
  }
  return { status: 200 as const, body: row };
});

const getSharedThreadMeta$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const params = get(pathParamsOf(sharedThreadsContract.meta));
    const row = await set(readSharedThreadMeta$, params.id, signal);
    signal.throwIfAborted();
    if (!row) {
      set(setResHeader$, "Cache-Control", "public, max-age=60, s-maxage=60");
      return notFound("Shared conversation not found");
    }
    set(
      setResHeader$,
      "Cache-Control",
      row.hasArtifactSnapshot
        ? "no-store"
        : "public, max-age=31536000, s-maxage=31536000, immutable",
    );
    return {
      status: 200 as const,
      body: { title: row.title, publicBrand: row.publicBrand },
    };
  },
);

const deleteSharedThreadInner$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const auth = get(organizationAuthContext$);
    const { id } = get(pathParamsOf(sharedThreadsContract.delete));
    set(setResHeader$, "Cache-Control", "private, no-store");
    const deleted = await set(
      deleteSharedThread$,
      { id, userId: auth.userId, orgId: auth.orgId },
      signal,
    );
    return deleted
      ? { status: 204 as const, body: undefined }
      : notFound("Shared conversation not found");
  },
);

export const sharedThreadRoutes: readonly RouteEntry[] = [
  {
    route: sharedThreadsContract.delete,
    handler: authRoute(
      {
        requireOrganization: true,
        missingOrganizationStatus: 401,
        requiredCapability: "chat-thread:write",
      },
      deleteSharedThreadInner$,
    ),
  },
  {
    route: sharedThreadsContract.create,
    handler: authRoute(
      {
        requireOrganization: true,
        missingOrganizationStatus: 401,
        requiredCapability: "chat-event:read",
      },
      createSharedThreadInner$,
    ),
  },
  {
    route: sharedThreadsContract.get,
    handler: getSharedThread$,
  },
  {
    route: sharedThreadsContract.meta,
    handler: getSharedThreadMeta$,
  },
];
