import { command, computed } from "ccstate";

import { setChatConnectorCurrent$ } from "../services/chat-connector-access.service";
import { chatThreadConnectorSelectionContract } from "@okouai/api-contracts/contracts/chat-threads";

import { badRequestMessage, notFound } from "../../lib/error";
import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { bodyResultOf, pathParamsOf } from "../context/request";
import { publishChatThreadDetailChangedSafely } from "../external/realtime";

import { connectorSelectionsForChatThread } from "../services/chat-thread-connector-selection.service";

import type { RouteEntry } from "../route-entry";

const selectionScope$ = computed((get) => {
  const auth = get(organizationAuthContext$);
  const params = get(pathParamsOf(chatThreadConnectorSelectionContract.get));
  return {
    orgId: auth.orgId,
    userId: auth.userId,
    chatThreadId: params.id,
  };
});
const selections$ = connectorSelectionsForChatThread(selectionScope$);

const getSelectionsInner$ = computed(async (get): Promise<unknown> => {
  const result = await get(selections$);
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
    const saved = await set(
      setChatConnectorCurrent$,
      {
        orgId: auth.orgId,
        userId: auth.userId,
        chatThreadId: params.id,
        target: body.data.target,
      },
      body.data.connectionId,
      signal,
    );
    if (saved) {
      await publishChatThreadDetailChangedSafely(auth.userId, params.id);
      signal.throwIfAborted();
    }
    return saved
      ? { status: 200 as const, body: body.data }
      : badRequestMessage("Account is unavailable or not allowed in this Chat");
  },
);
const clearSelectionInner$ = command(
  async ({ get }, signal: AbortSignal): Promise<unknown> => {
    const body = await get(
      bodyResultOf(chatThreadConnectorSelectionContract.clear),
    );
    signal.throwIfAborted();
    if (!body.ok) {
      return body.response;
    }
    return badRequestMessage(
      "Manage this Chat's account access instead of clearing its current account",
    );
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
