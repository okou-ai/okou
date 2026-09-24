import { command } from "ccstate";
import { and, eq, isNotNull } from "drizzle-orm";
import { chatThreadArchiveContract } from "@okouai/api-contracts/contracts/chat-threads";
import { chatThreads } from "@okouai/db/schema/chat-thread";

import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { pathParamsOf, queryOf } from "../context/request";
import { writeDb$, type Db } from "../external/db";
import { publishThreadListChanged } from "../external/realtime";
import { notFound } from "../../lib/error";
import { withChatThreadContentWrite } from "../services/chat-thread-content-erasure-admission.service";
import { appendChatThreadEvent } from "../services/chat-thread-event.service";
import { chatThreadOrganizationCondition } from "../services/chat-thread-organization.service";
import type { RouteEntry } from "../route-entry";

/** Sets the flag and appends its sidebar event; false when the thread is not the caller's. */
async function writeChatThreadArchived(
  writeDb: Db,
  args: {
    readonly userId: string;
    readonly orgId: string;
    readonly threadId: string;
    readonly archived: boolean;
    readonly eventId: string | undefined;
  },
  signal: AbortSignal,
): Promise<boolean> {
  // Same admission as pin: the flag UPDATE and its sidebar event share one
  // transaction. Repeating the request still appends an event so optimistic
  // client events settle.
  const result = await withChatThreadContentWrite(
    writeDb,
    {
      chatThreadId: args.threadId,
      authorize: (identity) => {
        return (
          identity.userId === args.userId &&
          identity.agentId !== null &&
          identity.orgId === args.orgId
        );
      },
    },
    async (tx) => {
      const [thread] = await tx
        .update(chatThreads)
        .set({ archived: args.archived })
        .where(
          and(
            eq(chatThreads.id, args.threadId),
            eq(chatThreads.userId, args.userId),
            chatThreadOrganizationCondition(tx, args.orgId),
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
        kind: args.archived ? "archived" : "unarchived",
        userId: args.userId,
        orgId: args.orgId,
        chatThreadId: thread.id,
        agentId: thread.agentId,
        eventId: args.eventId,
      });
      return true;
    },
    signal,
  );
  return result.outcome === "written" && result.value;
}

const archiveInner$ = command(async ({ get, set }, signal: AbortSignal) => {
  const auth = get(organizationAuthContext$);
  const params = get(pathParamsOf(chatThreadArchiveContract.archive));
  const query = get(queryOf(chatThreadArchiveContract.archive));
  signal.throwIfAborted();

  const written = await writeChatThreadArchived(
    set(writeDb$),
    {
      userId: auth.userId,
      orgId: auth.orgId,
      threadId: params.id,
      archived: true,
      eventId: query?.eventId,
    },
    signal,
  );
  signal.throwIfAborted();
  if (!written) {
    return notFound("Chat thread not found");
  }

  await publishThreadListChanged({ userId: auth.userId, orgId: auth.orgId });
  signal.throwIfAborted();
  return { status: 204 as const, body: undefined };
});

const unarchiveInner$ = command(async ({ get, set }, signal: AbortSignal) => {
  const auth = get(organizationAuthContext$);
  const params = get(pathParamsOf(chatThreadArchiveContract.unarchive));
  const query = get(queryOf(chatThreadArchiveContract.unarchive));
  signal.throwIfAborted();

  const written = await writeChatThreadArchived(
    set(writeDb$),
    {
      userId: auth.userId,
      orgId: auth.orgId,
      threadId: params.id,
      archived: false,
      eventId: query?.eventId,
    },
    signal,
  );
  signal.throwIfAborted();
  if (!written) {
    return notFound("Chat thread not found");
  }

  await publishThreadListChanged({ userId: auth.userId, orgId: auth.orgId });
  signal.throwIfAborted();
  return { status: 204 as const, body: undefined };
});

export const chatThreadArchiveRoutes: readonly RouteEntry[] = [
  {
    route: chatThreadArchiveContract.archive,
    handler: authRoute(
      {
        requireOrganization: true,
        missingOrganizationStatus: 401,
        requiredCapability: "chat-thread:write",
      },
      archiveInner$,
    ),
  },
  {
    route: chatThreadArchiveContract.unarchive,
    handler: authRoute(
      {
        requireOrganization: true,
        missingOrganizationStatus: 401,
        requiredCapability: "chat-thread:write",
      },
      unarchiveInner$,
    ),
  },
];
