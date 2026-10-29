import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { isFeatureEnabled } from "@okouai/core/feature-switch";
import { sharedThreadVisibilityContract } from "@okouai/api-contracts/contracts/shared-thread-visibility";
import { loadUserFeatureSwitchContext$ } from "../services/feature-switches.service";
import {
  readSharedThreadVisibility$,
  updateSharedThreadVisibility$,
} from "../services/shared-thread-visibility.service";
import { sharedThreadsContract } from "@okouai/api-contracts/contracts/shared-threads";
import { command } from "ccstate";

import {
  badRequestMessage,
  conflict,
  notFound,
  resourceUnavailable,
} from "../../lib/error";
import { deleteSharedThread$ } from "../services/shared-thread-artifacts.service";
import {
  organizationAuthContext$,
  requiredAuthContext$,
} from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { authorization$, cookie$, setResHeader$ } from "../context/hono";
import { bodyResultOf, pathParamsOf } from "../context/request";
import {
  createSharedThread$,
  type CreateSharedThreadArgs,
  readSharedThread$,
  readSharedThreadMeta$,
} from "../services/shared-thread.service";
import type { RouteEntry } from "../route-entry";

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

const createSharedThreadResponse$ = command(
  async (
    { get, set },
    body: Pick<
      CreateSharedThreadArgs,
      "threadId" | "eventIds" | "id" | "audience"
    >,
    signal: AbortSignal,
  ) => {
    const auth = get(organizationAuthContext$);

    if (body.audience !== undefined) {
      const denied = await set(visibilityAdmission$, signal);
      if (denied) {
        return denied;
      }
    }
    const result = await set(
      createSharedThread$,
      {
        orgId: auth.orgId,
        userId: auth.userId,
        threadId: body.threadId,
        eventIds: body.eventIds,
        ...(body.audience === undefined ? {} : { audience: body.audience }),
        ...(body.id === undefined ? {} : { id: body.id }),
        canReadAttachments:
          auth.tokenType !== "agent" ||
          auth.capabilities?.includes("file:read") === true,
      },
      signal,
    );
    signal.throwIfAborted();
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
    if (result.kind === "id-conflict") {
      return conflict("A shared conversation with this ID already exists");
    }
    return { status: 201 as const, body: { id: result.id } };
  },
);

const createSharedThreadInner$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const parsed = await get(createBody$);
    signal.throwIfAborted();
    return parsed.ok
      ? await set(
          createSharedThreadResponse$,
          {
            ...parsed.data,
            ...get(pathParamsOf(sharedThreadsContract.create)),
          },
          signal,
        )
      : parsed.response;
  },
);

const createVisibleSharedThreadInner$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const parsed = await get(
      bodyResultOf(sharedThreadVisibilityContract.create),
    );
    signal.throwIfAborted();
    return parsed.ok
      ? await set(
          createSharedThreadResponse$,
          {
            ...parsed.data,
            ...get(pathParamsOf(sharedThreadVisibilityContract.create)),
          },
          signal,
        )
      : parsed.response;
  },
);

const getSharedThread$ = command(async ({ get, set }, signal: AbortSignal) => {
  const params = get(pathParamsOf(sharedThreadsContract.get));
  set(setResHeader$, "Cache-Control", "no-store");
  const auth =
    get(authorization$) || get(cookie$)
      ? await set(
          requiredAuthContext$,
          { requiredCapability: "chat-event:read" },
          signal,
        )
      : null;
  const row = await set(
    readSharedThread$,
    params.id,
    auth && !("status" in auth) ? auth.userId : undefined,
    signal,
  );
  if (!row) {
    return auth && "status" in auth
      ? auth
      : notFound("Shared conversation not found");
  }
  // Public snapshots do not depend on a valid viewer credential. Restricted
  // snapshots never receive an identity from a failed authentication attempt.
  return { status: 200 as const, body: row };
});

const getSharedThreadMeta$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const params = get(pathParamsOf(sharedThreadsContract.meta));
    const row = await set(readSharedThreadMeta$, params.id, signal);
    signal.throwIfAborted();
    set(setResHeader$, "Cache-Control", "no-store");
    if (!row) {
      return notFound("Shared conversation not found");
    }

    return {
      status: 200 as const,
      body: { title: row.title },
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

const visibilityAdmission$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    set(setResHeader$, "Cache-Control", "private, no-store");
    const auth = get(organizationAuthContext$);
    const features = await set(
      loadUserFeatureSwitchContext$,
      auth.orgId,
      auth.userId,
      signal,
    );
    return isFeatureEnabled(FeatureSwitchKey.SharedThreadVisibility, features)
      ? null
      : resourceUnavailable(
          "Conversation visibility management is not available",
        );
  },
);

const getVisibility$ = command(async ({ get, set }, signal: AbortSignal) => {
  const denied = await set(visibilityAdmission$, signal);
  if (denied) {
    return denied;
  }
  const body = await set(
    readSharedThreadVisibility$,
    {
      ...get(organizationAuthContext$),
      ...get(pathParamsOf(sharedThreadVisibilityContract.get)),
    },
    signal,
  );
  return body
    ? { status: 200 as const, body }
    : notFound("Shared conversation not found");
});

const updateVisibility$ = command(async ({ get, set }, signal: AbortSignal) => {
  const denied = await set(visibilityAdmission$, signal);
  if (denied) {
    return denied;
  }
  const parsed = await get(bodyResultOf(sharedThreadVisibilityContract.update));
  signal.throwIfAborted();
  if (!parsed.ok) {
    return parsed.response;
  }
  const result = await set(
    updateSharedThreadVisibility$,
    {
      ...get(organizationAuthContext$),
      ...get(pathParamsOf(sharedThreadVisibilityContract.update)),
      ...parsed.data,
    },
    signal,
  );
  if (result.kind === "not-found") {
    return notFound("Shared conversation not found");
  }
  if (result.kind === "conflict") {
    return conflict("Conversation visibility changed; reload before editing");
  }
  if (result.kind === "public-attachments") {
    return badRequestMessage(
      "This conversation includes legacy public attachments. Create a new share to change visibility.",
    );
  }
  return { status: 200 as const, body: result.body };
});

const visibilityOwnerAuth = {
  requireOrganization: true,
  missingOrganizationStatus: 401,
  requiredCapability: "chat-thread:write",
} as const;

export const sharedThreadRoutes: readonly RouteEntry[] = [
  {
    route: sharedThreadVisibilityContract.create,
    handler: authRoute(
      {
        requireOrganization: true,
        missingOrganizationStatus: 401,
        requiredCapability: "chat-event:read",
      },
      createVisibleSharedThreadInner$,
    ),
  },
  {
    route: sharedThreadVisibilityContract.get,
    handler: authRoute(visibilityOwnerAuth, getVisibility$),
  },
  {
    route: sharedThreadVisibilityContract.update,
    handler: authRoute(visibilityOwnerAuth, updateVisibility$),
  },
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
