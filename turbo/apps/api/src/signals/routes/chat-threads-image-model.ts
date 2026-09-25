import { command } from "ccstate";
import { chatThreadImageModelContract } from "@okouai/api-contracts/contracts/chat-threads";

import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { bodyResultOf, pathParamsOf } from "../context/request";
import { writeDb$ } from "../external/db";
import { publishThreadListChanged } from "../external/realtime";
import { nowDate } from "../../lib/time";
import { notFound } from "../../lib/error";
import { updateOwnedChatThreadWithEvent } from "../services/chat-thread-owned-update.service";
import type { RouteEntry } from "../route-entry";

const imageModelBody$ = bodyResultOf(chatThreadImageModelContract.update);

const updateImageModelInner$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const auth = get(organizationAuthContext$);
    const params = get(pathParamsOf(chatThreadImageModelContract.update));
    const body = await get(imageModelBody$);
    signal.throwIfAborted();
    if (!body.ok) {
      return body.response;
    }

    const writeDb = set(writeDb$);
    const selectedImageModel = body.data.model;
    const updatedAt = nowDate();
    const written = await updateOwnedChatThreadWithEvent(writeDb, {
      userId: auth.userId,
      orgId: auth.orgId,
      threadId: params.id,
      set: { selectedImageModel, updatedAt },
      event: () => {
        return {
          kind: "image_model_updated",
          eventId: body.data.eventId,
          selectedImageModel,
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

export const chatThreadImageModelRoutes: readonly RouteEntry[] = [
  {
    route: chatThreadImageModelContract.update,
    handler: authRoute(
      {
        requireOrganization: true,
        missingOrganizationStatus: 401,
        requiredCapability: "chat-thread:write",
      },
      updateImageModelInner$,
    ),
  },
];
