import { command, computed } from "ccstate";
import { chatThreadConnectorSelectionContract } from "@okouai/api-contracts/contracts/chat-threads";

import { badRequestMessage, notFound } from "../../lib/error";
import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { bodyResultOf, pathParamsOf } from "../context/request";
import { db$, writeDb$ } from "../external/db";
import { publishChatThreadDetailChangedSafely } from "../external/realtime";
import { bestEffort } from "../utils";
import {
  clearChatThreadConnectorSelection,
  listChatThreadConnectorSelections,
  updateChatThreadConnectorSelection,
} from "../services/chat-thread-connector-selection.service";
import { reconcileGmailWatchesForUser } from "../services/gmail-automation-event.service";
import { reconcileGoogleCalendarWatchesForUser } from "../services/google-calendar-automation-event.service";
import { reconcileGoogleFormsWatchesForUser } from "../services/google-forms-automation-event.service";
import { reconcileGoogleMeetSubscriptionsForUser } from "../services/google-meet-automation-event.service";
import type { RouteEntry } from "../route-entry";

const getSelectionsInner$ = computed(async (get): Promise<unknown> => {
  const auth = get(organizationAuthContext$);
  const params = get(pathParamsOf(chatThreadConnectorSelectionContract.get));
  const result = await listChatThreadConnectorSelections(get(db$), {
    orgId: auth.orgId,
    userId: auth.userId,
    chatThreadId: params.id,
  });
  if (!result) {
    return notFound("Chat thread not found");
  }
  return {
    status: 200 as const,
    body: {
      selections: [...result.selections],
      selectedConnections: [...result.selectedConnections],
    },
  };
});

const updateSelectionInner$ = command(
  async ({ get, set }, signal: AbortSignal): Promise<unknown> => {
    const auth = get(organizationAuthContext$);
    const params = get(
      pathParamsOf(chatThreadConnectorSelectionContract.update),
    );
    const body = await get(
      bodyResultOf(chatThreadConnectorSelectionContract.update),
    );
    signal.throwIfAborted();
    if (!body.ok) {
      return body.response;
    }
    const writeDb = set(writeDb$);
    const result = await updateChatThreadConnectorSelection(
      writeDb,
      {
        orgId: auth.orgId,
        userId: auth.userId,
        chatThreadId: params.id,
        selection: body.data,
      },
      signal,
    );
    signal.throwIfAborted();
    if (result.kind === "not_found") {
      return notFound("Chat thread not found");
    }
    if (result.kind === "invalid") {
      return badRequestMessage(result.message);
    }
    if (
      body.data.target.kind === "builtin" &&
      (body.data.target.connectorSlug === "gmail" ||
        body.data.target.connectorSlug === "google-calendar" ||
        body.data.target.connectorSlug === "google-forms" ||
        body.data.target.connectorSlug === "google-meet")
    ) {
      await bestEffort(
        body.data.target.connectorSlug === "gmail"
          ? reconcileGmailWatchesForUser(
              { db: writeDb, orgId: auth.orgId, userId: auth.userId },
              signal,
            )
          : body.data.target.connectorSlug === "google-calendar"
            ? reconcileGoogleCalendarWatchesForUser(
                { db: writeDb, orgId: auth.orgId, userId: auth.userId },
                signal,
              )
            : body.data.target.connectorSlug === "google-forms"
              ? reconcileGoogleFormsWatchesForUser(
                  { db: writeDb, orgId: auth.orgId, userId: auth.userId },
                  signal,
                )
              : reconcileGoogleMeetSubscriptionsForUser(
                  { db: writeDb, orgId: auth.orgId, userId: auth.userId },
                  signal,
                ),
        signal,
      );
    }
    await publishChatThreadDetailChangedSafely(auth.userId, params.id);
    signal.throwIfAborted();
    return { status: 200 as const, body: result.selection };
  },
);

const clearSelectionInner$ = command(
  async ({ get, set }, signal: AbortSignal): Promise<unknown> => {
    const auth = get(organizationAuthContext$);
    const params = get(
      pathParamsOf(chatThreadConnectorSelectionContract.clear),
    );
    const body = await get(
      bodyResultOf(chatThreadConnectorSelectionContract.clear),
    );
    signal.throwIfAborted();
    if (!body.ok) {
      return body.response;
    }
    const writeDb = set(writeDb$);
    const result = await clearChatThreadConnectorSelection(
      writeDb,
      {
        orgId: auth.orgId,
        userId: auth.userId,
        chatThreadId: params.id,
        target: body.data,
      },
      signal,
    );
    signal.throwIfAborted();
    if (result.kind === "not_found") {
      return notFound("Chat thread not found");
    }
    if (
      body.data.kind === "builtin" &&
      (body.data.connectorSlug === "gmail" ||
        body.data.connectorSlug === "google-calendar" ||
        body.data.connectorSlug === "google-forms" ||
        body.data.connectorSlug === "google-meet")
    ) {
      await bestEffort(
        body.data.connectorSlug === "gmail"
          ? reconcileGmailWatchesForUser(
              { db: writeDb, orgId: auth.orgId, userId: auth.userId },
              signal,
            )
          : body.data.connectorSlug === "google-calendar"
            ? reconcileGoogleCalendarWatchesForUser(
                { db: writeDb, orgId: auth.orgId, userId: auth.userId },
                signal,
              )
            : body.data.connectorSlug === "google-forms"
              ? reconcileGoogleFormsWatchesForUser(
                  { db: writeDb, orgId: auth.orgId, userId: auth.userId },
                  signal,
                )
              : reconcileGoogleMeetSubscriptionsForUser(
                  { db: writeDb, orgId: auth.orgId, userId: auth.userId },
                  signal,
                ),
        signal,
      );
    }
    await publishChatThreadDetailChangedSafely(auth.userId, params.id);
    signal.throwIfAborted();
    return { status: 204 as const, body: undefined };
  },
);

const readAuth = {
  requireOrganization: true,
  missingOrganizationStatus: 401,
  requiredCapability: "chat-thread:read",
} as const;

const writeAuth = {
  requireOrganization: true,
  missingOrganizationStatus: 401,
  requiredCapability: "chat-thread:write",
} as const;

export const chatThreadConnectorSelectionRoutes: readonly RouteEntry[] = [
  {
    route: chatThreadConnectorSelectionContract.get,
    handler: authRoute(readAuth, getSelectionsInner$),
  },
  {
    route: chatThreadConnectorSelectionContract.update,
    handler: authRoute(writeAuth, updateSelectionInner$),
  },
  {
    route: chatThreadConnectorSelectionContract.clear,
    handler: authRoute(writeAuth, clearSelectionInner$),
  },
];
