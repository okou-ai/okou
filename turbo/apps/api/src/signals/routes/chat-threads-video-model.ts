import { command } from "ccstate";
import { and, eq, isNotNull } from "drizzle-orm";
import type { z } from "zod";
import { chatThreadVideoModelContract } from "@okouai/api-contracts/contracts/chat-threads";
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

const videoModelBody$ = bodyResultOf(chatThreadVideoModelContract.update);

type VideoModelUpdateBody = z.infer<
  typeof chatThreadVideoModelContract.update.body
>;

/**
 * The admitted write itself: it runs only after the shared admission has
 * resolved the canonical identity, cleared B1 and retained the Agent and thread
 * identity locks, so the pin UPDATE, the durable sequence it reserves and the
 * sidebar event are all fenced by the same transaction. The route's original
 * predicates are unchanged, which keeps the ownership, organization and
 * non-null Agent contract that produces this route's existing not-found.
 */
async function writeVideoModel(
  tx: Tx,
  args: {
    readonly auth: { readonly orgId: string; readonly userId: string };
    readonly threadId: string;
    readonly body: VideoModelUpdateBody;
  },
): Promise<boolean> {
  const { auth } = args;
  const selectedVideoModel = args.body.model;
  const updatedAt = nowDate();
  const [thread] = await tx
    .update(chatThreads)
    .set({ selectedVideoModel, updatedAt })
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
    kind: "video_model_updated",
    userId: auth.userId,
    orgId: auth.orgId,
    chatThreadId: thread.id,
    agentId: thread.agentId,
    eventId: args.body.eventId,
    selectedVideoModel,
    createdAt: updatedAt,
  });
  return true;
}

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

    // A thread's video model pin is account content, and so are the sidebar
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
        return await writeVideoModel(tx, {
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
