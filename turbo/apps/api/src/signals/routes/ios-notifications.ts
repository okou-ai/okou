import { command, computed } from "ccstate";
import { and, eq, inArray, isNull, ne, or } from "drizzle-orm";
import { iosNotificationsContract } from "@okouai/api-contracts/contracts/ios-notifications";
import { chatThreads } from "@okouai/db/runtime/chat-thread";
import { iosPushRegistrations } from "@okouai/db/schema/ios-push-registration";
import {
  chatEvents,
  chatEventTerminalPredicate,
} from "@okouai/db/schema/chat-event";
import { authContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { bodyResultOf } from "../context/request";
import { db$, writeDb$ } from "../external/db";
import { unreadIosNotificationThreadCondition } from "../services/ios-notification-query";
import type { RouteEntry } from "../route-entry";

const reconciliationBody$ = bodyResultOf(iosNotificationsContract.reconcile);
const reconciliation$ = computed(async (get) => {
  const body = await get(reconciliationBody$);
  if (!body.ok) {
    return body;
  }
  const { userId } = get(authContext$);
  const receipts = body.data.notifications;
  const threadIds = [...new Set(receipts.map((receipt) => receipt.threadId))];
  const runIds = [...new Set(receipts.map((receipt) => receipt.runId))];
  const db = get(db$);
  const [unreadCount, threads, terminals] = await Promise.all([
    db.$count(chatThreads, unreadIosNotificationThreadCondition(userId)),
    threadIds.length === 0
      ? Promise.resolve([])
      : db
          .select({
            id: chatThreads.id,
            agentId: chatThreads.agentId,
            lastReadAt: chatThreads.lastReadAt,
            hidden: chatThreads.hidden,
            muted: chatThreads.muted,
          })
          .from(chatThreads)
          .where(
            and(
              eq(chatThreads.userId, userId),
              inArray(chatThreads.id, threadIds),
            ),
          ),
    runIds.length === 0
      ? Promise.resolve([])
      : db
          .select({
            threadId: chatEvents.chatThreadId,
            runId: chatEvents.runId,
            createdAt: chatEvents.createdAt,
          })
          .from(chatEvents)
          .innerJoin(chatThreads, eq(chatThreads.id, chatEvents.chatThreadId))
          .where(
            and(
              eq(chatThreads.userId, userId),
              inArray(chatEvents.chatThreadId, threadIds),
              inArray(chatEvents.runId, runIds),
              chatEventTerminalPredicate(chatEvents.eventType),
            ),
          ),
  ]);
  const owned = new Map(threads.map((thread) => [thread.id, thread]));
  const finished = new Map(
    terminals.map((terminal) => [
      `${terminal.threadId}:${terminal.runId}`,
      terminal.createdAt,
    ]),
  );
  const removeIdentifiers = receipts.flatMap((receipt) => {
    const thread = owned.get(receipt.threadId);
    if (!thread || !thread.agentId || thread.hidden || thread.muted) {
      return [receipt.identifier];
    }
    const terminalAt = finished.get(`${receipt.threadId}:${receipt.runId}`);
    // A missing terminal marker is not proof that a still-owned conversation was read.
    return terminalAt && thread.lastReadAt && terminalAt <= thread.lastReadAt
      ? [receipt.identifier]
      : [];
  });
  return { ok: true as const, data: { unreadCount, removeIdentifiers } };
});

const reconcile$ = command(async ({ get, set }, signal: AbortSignal) => {
  const auth = get(authContext$);
  if (auth.tokenType !== "session" || !auth.sessionId) {
    return {
      status: 403 as const,
      body: {
        error: {
          code: "FORBIDDEN",
          message: "An active app session is required",
        },
      },
    };
  }
  const body = await get(reconciliationBody$);
  signal.throwIfAborted();
  if (!body.ok) {
    return body.response;
  }
  const { installationId, registrationRevision } = body.data;
  if (registrationRevision !== undefined) {
    // A new client's handshake only activates its exact current binding.
    // An old API writer advancing revision retires this capability as well.
    await set(writeDb$)
      .update(iosPushRegistrations)
      .set({
        notificationStateRevision: registrationRevision,
      })
      .where(
        and(
          eq(iosPushRegistrations.installationId, installationId),
          eq(iosPushRegistrations.userId, auth.userId),
          eq(iosPushRegistrations.sessionId, auth.sessionId),
          eq(iosPushRegistrations.revision, registrationRevision),
          eq(iosPushRegistrations.enabled, true),
          or(
            isNull(iosPushRegistrations.notificationStateRevision),
            ne(
              iosPushRegistrations.notificationStateRevision,
              registrationRevision,
            ),
          ),
        ),
      );
    signal.throwIfAborted();
  }
  const result = await get(reconciliation$);
  signal.throwIfAborted();
  return result.ok
    ? { status: 200 as const, body: result.data }
    : result.response;
});

export const iosNotificationsRoutes: readonly RouteEntry[] = [
  {
    route: iosNotificationsContract.reconcile,
    handler: authRoute({ accept: ["session"] }, reconcile$),
    requestBodyPolicy: {
      maxBytes: 512 * 1024,
      tooLargeMessage: "Too many delivered notifications",
    },
  },
];
