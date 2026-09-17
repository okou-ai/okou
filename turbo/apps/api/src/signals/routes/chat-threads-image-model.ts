import { command } from "ccstate";
import { and, eq, isNotNull } from "drizzle-orm";
import type { z } from "zod";
import { chatThreadImageModelContract } from "@okouai/api-contracts/contracts/chat-threads";
import { chatThreads } from "@okouai/db/schema/chat-thread";

import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { bodyResultOf, pathParamsOf } from "../context/request";
import { writeDb$ } from "../external/db";
import { publishThreadListChanged } from "../external/realtime";
import { nowDate } from "../../lib/time";
import { notFound } from "../../lib/error";
import type { Tx } from "../../lib/db-types";
import { appendChatThreadEvent } from "../services/chat-thread-event.service";
import { withChatThreadContentWrite } from "../services/chat-thread-content-erasure-admission.service";
import { chatThreadOrganizationCondition } from "../services/chat-thread-organization.service";
import type { RouteEntry } from "../route-entry";

const imageModelBody$ = bodyResultOf(chatThreadImageModelContract.update);

type ImageModelUpdateBody = z.infer<
  typeof chatThreadImageModelContract.update.body
>;

/**
 * The admitted write itself: it runs only after the shared admission has
 * resolved the canonical identity, cleared B1 and retained the Agent and thread
 * identity locks, so the pin UPDATE, the durable sequence it reserves and the
 * sidebar event are all fenced by the same transaction. The route's original
 * predicates are unchanged, which keeps the ownership, organization and
 * non-null Agent contract that produces this route's existing not-found.
 */
async function writeImageModel(
  tx: Tx,
  args: {
    readonly auth: { readonly orgId: string; readonly userId: string };
    readonly threadId: string;
    readonly body: ImageModelUpdateBody;
  },
): Promise<boolean> {
  const { auth } = args;
  const selectedImageModel = args.body.model;
  const updatedAt = nowDate();
  const [thread] = await tx
    .update(chatThreads)
    .set({ selectedImageModel, updatedAt })
    .where(
      and(
        eq(chatThreads.id, args.threadId),
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
    eventId: args.body.eventId,
    selectedImageModel,
    createdAt: updatedAt,
  });
  return true;
}

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

    // A thread's image model pin is account content, and so are the sidebar
    // event and the durable sequence id it consumes. The existing single
    // transaction now runs inside the shared B1 admission and the canonical
    // Agent/thread locks, so a closed thread user, a closed distinct Agent
    // owner or a closed organization can no longer pin a model or extend the
    // sidebar stream. B1 closure reuses this route's existing 404, alongside
    // its unchanged organization, `chat-thread:write` and non-null Agent
    // requirements; a real database failure or cancellation keeps propagating
    // as itself.
    const result = await withChatThreadContentWrite(
      writeDb,
      {
        chatThreadId: params.id,
        authorize: (identity) => {
          return (
            identity.userId === auth.userId &&
            identity.agentId !== null &&
            identity.orgId === auth.orgId
          );
        },
      },
      async (tx) => {
        return await writeImageModel(tx, {
          auth,
          threadId: params.id,
          body: body.data,
        });
      },
      signal,
    );
    signal.throwIfAborted();

    if (result.outcome !== "written" || !result.value) {
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
