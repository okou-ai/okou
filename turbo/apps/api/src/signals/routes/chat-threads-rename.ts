import { command } from "ccstate";
import { chatThreadRenameContract } from "@okouai/api-contracts/contracts/chat-threads";

import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { bodyResultOf, pathParamsOf } from "../context/request";
import { writeDb$ } from "../external/db";
import { publishThreadListChanged } from "../external/realtime";
import { notFound } from "../../lib/error";
import { updateChatThreadMetadata } from "../services/chat-thread-metadata-update.service";
import type { RouteEntry } from "../route-entry";

const renameBody$ = bodyResultOf(chatThreadRenameContract.rename);

const renameInner$ = command(async ({ get, set }, signal: AbortSignal) => {
  const auth = get(organizationAuthContext$);
  const params = get(pathParamsOf(chatThreadRenameContract.rename));
  const body = await get(renameBody$);
  signal.throwIfAborted();
  if (!body.ok) {
    return body.response;
  }

  const result = await updateChatThreadMetadata(
    set(writeDb$),
    {
      principal: auth,
      threadId: params.id,
      patch: { title: body.data.title },
      codexServiceTier: { kind: "preserve" },
      emitServiceTierEvent: false,
      eventIds:
        body.data.eventId === undefined ? {} : { title: body.data.eventId },
    },
    signal,
  );
  signal.throwIfAborted();
  if (result.kind !== "ok") {
    return notFound("Chat thread not found");
  }

  await publishThreadListChanged({ userId: auth.userId, orgId: auth.orgId });
  signal.throwIfAborted();
  return { status: 204 as const, body: undefined };
});

export const chatThreadRenameRoutes: readonly RouteEntry[] = [
  {
    route: chatThreadRenameContract.rename,
    handler: authRoute(
      {
        requireOrganization: true,
        missingOrganizationStatus: 401,
        requiredCapability: "chat-thread:write",
      },
      renameInner$,
    ),
  },
];
