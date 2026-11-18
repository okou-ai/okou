import {
  publishChatThreadMessageCreated$,
  type ChatEventPublicationScope,
} from "./chat-event-publication.service";
import { command } from "ccstate";

import { writeDb$ } from "../external/db";

import { randomUUID } from "node:crypto";
import { parseRawRows } from "../../lib/db-raw-rows";
import { nowDate } from "../../lib/time";
import {
  appendCanonicalChatEventsSql,
  chatEventAppendResultSchema,
} from "./chat-event-append.service";
import { readSettledRunUsage$ } from "./chat-run-usage.service";
/** Usage events are refresh hints; the settled ledger owns displayed amounts. */
export const maybeEmitRunUsageEvent$ = command(
  async (
    { set },
    runId: string,
    signal: AbortSignal,
  ): Promise<ChatEventPublicationScope | null> => {
    const [settled] = await set(
      readSettledRunUsage$,
      { runIds: [runId] },
      signal,
    );
    if (!settled) {
      return null;
    }
    const db = set(writeDb$);
    // Preserve the established payload for supported older Apps. Duplicate or
    // delayed hints are allowed; no archive/revoke protocol owns monetary truth.
    const [inserted] = parseRawRows(
      chatEventAppendResultSchema,
      await db.execute(
        appendCanonicalChatEventsSql(
          [
            {
              id: randomUUID(),
              chatThreadId: settled.chatThreadId,
              runId,
              eventType: "usage.recorded",
              payload: { usage: settled.usage },
              createdAt: nowDate(),
            },
          ],
          "id",
        ),
      ),
    );
    signal.throwIfAborted();
    if (!inserted) {
      return null;
    }
    await set(
      publishChatThreadMessageCreated$,
      {
        userId: settled.userId,
        orgId: settled.orgId,
        threadId: settled.chatThreadId,
      },
      signal,
    );
    signal.throwIfAborted();
    return {
      userId: settled.userId,
      orgId: settled.orgId,
      threadId: settled.chatThreadId,
    };
  },
);
