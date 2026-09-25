import { command } from "ccstate";
import { chatThreadVideoModelContract } from "@okouai/api-contracts/contracts/chat-threads";

import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { bodyResultOf, pathParamsOf } from "../context/request";
import { writeDb$ } from "../external/db";
import { publishThreadListChanged } from "../external/realtime";
import { nowDate } from "../../lib/time";
import { notFound } from "../../lib/error";
import { updateOwnedChatThreadWithEvent } from "../services/chat-thread-owned-update.service";
import type { RouteEntry } from "../route-entry";

const videoModelBody$ = bodyResultOf(chatThreadVideoModelContract.update);

const updateVideoModelInner$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const auth = get(organizationAuthContext$);
    const params = get(pathParamsOf(chatThreadVideoModelContract.update));
    const body = await get(videoModelBody$);
    signal.throwIfAborted();
    if (!body.ok) {
      return body.response;
    }

    const writeDb = set(writeDb$);
    const selectedVideoModel = body.data.model;
    const updatedAt = nowDate();
    const written = await updateOwnedChatThreadWithEvent(writeDb, {
      userId: auth.userId,
      orgId: auth.orgId,
      threadId: params.id,
      set: { selectedVideoModel, updatedAt },
      event: () => {
        return {
          kind: "video_model_updated",
          eventId: body.data.eventId,
          selectedVideoModel,
          createdAt: updatedAt,
        };
      },
    });
    signal.throwIfAborted();
    if (!written) {
      return notFound("Chat thread not found");
    }

    await publishThreadListChanged({ userId: auth.userId, orgId: auth.orgId });
    signal.throwIfAborted();

    return { status: 204 as const, body: undefined };
  },
);

export const chatThreadVideoModelRoutes: readonly RouteEntry[] = [
  {
    route: chatThreadVideoModelContract.update,
    handler: authRoute(
      {
        requireOrganization: true,
        missingOrganizationStatus: 401,
        requiredCapability: "chat-thread:write",
      },
      updateVideoModelInner$,
    ),
  },
];
