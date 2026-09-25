import { command } from "ccstate";
import { and, eq, isNotNull } from "drizzle-orm";
import { chatThreadImageModelContract } from "@okouai/api-contracts/contracts/chat-threads";
import { chatThreads } from "@okouai/db/runtime/chat-thread";

import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { bodyResultOf, pathParamsOf } from "../context/request";
import { writeDb$ } from "../external/db";
import { publishThreadListChanged } from "../external/realtime";
import { nowDate } from "../../lib/time";
import { notFound } from "../../lib/error";
import { appendChatThreadEvent } from "../services/chat-thread-event.service";
import { chatThreadOrganizationCondition } from "../services/chat-thread-organization.service";
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
    const updated = await writeDb.transaction(async (tx) => {
      const updatedAt = nowDate();
      const [thread] = await tx
        .update(chatThreads)
        .set({ selectedImageModel, updatedAt })
        .where(
          and(
            eq(chatThreads.id, params.id),
            eq(chatThreads.userId, auth.userId),
            chatThreadOrganizationCondition(tx, auth.orgId),
            isNotNull(chatThreads.agentId),
          ),
        )
        .returning({
          id: chatThreads.id,
          agentId: chatThreads.agentId,
        });
      if (!thread?.agentId) {
        return false;
      }
      await appendChatThreadEvent(tx, {
        kind: "image_model_updated",
        userId: auth.userId,
        orgId: auth.orgId,
        chatThreadId: thread.id,
        agentId: thread.agentId,
        eventId: body.data.eventId,
        selectedImageModel,
        createdAt: updatedAt,
      });
      return true;
    });
    signal.throwIfAborted();

    if (!updated) {
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
