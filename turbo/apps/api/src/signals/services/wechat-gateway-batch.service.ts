import { command } from "ccstate";
import { z } from "zod";
import { and, eq } from "drizzle-orm";
import { wechatConnections, wechatMessages } from "@okouai/db/schema/wechat";
import {
  wechatUpdatesSchema,
  type WechatMessage,
} from "@okouai/api-contracts/contracts/wechat-protocol";
import { logger } from "../../lib/log";
import { nowDate } from "../../lib/time";
import { writeDb$ } from "../external/db";
import { settle } from "../utils";
import {
  decryptStoredSecretValue,
  encryptStoredSecretValue,
} from "./crypto.utils";
import {
  receiveWechatMessage$,
  WechatIngressError,
} from "./wechat-ingress.service";
import { isWechatOwnerMessage, wechatEventId } from "./wechat-message-identity";
import {
  sendWechatReconnectNotice$,
  sendWechatInputFailureNotice$,
} from "./wechat-notice.service";

const log = logger("api:wechat:gateway");
const MAX_INPUT_ATTEMPTS = 3;
// Stored only inside the encrypted pending batch, scoped to its binding generation.
const pendingBatchSchema = wechatUpdatesSchema.extend({
  retries: z.record(
    z.string(),
    z.object({
      failures: z.number().int().nonnegative(),
      nextAttemptAt: z.number(),
    }),
  ),
});

type InputRetry = z.infer<typeof pendingBatchSchema>["retries"][string];
type Connection = typeof wechatConnections.$inferSelect;
const receiveBatchInput$ = command(
  async (
    { set },
    args: {
      connection: Connection;
      message: WechatMessage;
      retry: InputRetry | undefined;
    },
    signal: AbortSignal,
  ): Promise<InputRetry | undefined> => {
    const { connection, message, retry } = args;
    if (!isWechatOwnerMessage(connection, message)) {
      return;
    }
    // A terminal notice is also the durable disposition of this input. Provider
    // redelivery must not reset its retry budget after the batch advances.
    const [terminal] = await set(writeDb$)
      .select({ id: wechatMessages.id })
      .from(wechatMessages)
      .where(
        eq(
          wechatMessages.id,
          wechatEventId(
            connection.id,
            connection.generation,
            `ingress-failed:${message.message_id}`,
          ),
        ),
      )
      .limit(1);
    signal.throwIfAborted();
    if (terminal) {
      return;
    }
    const notice = await settle(
      set(sendWechatReconnectNotice$, { connection, message }, signal),
      signal,
    );
    if (!notice.ok) {
      log.warn("WeChat notice failed", { error: notice.error });
    }
    if (connection.status !== "active") {
      return;
    }
    const received = await settle(
      set(receiveWechatMessage$, { connection, message }, signal),
      signal,
    );
    if (received.ok) {
      return;
    }
    const failures = (retry?.failures ?? 0) + 1;
    const retryable =
      !(received.error instanceof WechatIngressError) ||
      received.error.retryable;
    const retryPending = retryable && failures < MAX_INPUT_ATTEMPTS;
    log.warn("WeChat input failed", {
      connectionId: connection.id,
      messageId: message.message_id,
      failures,
      retryable: retryPending,
      error: received.error,
    });
    if (retryPending) {
      return {
        failures,
        nextAttemptAt: nowDate().getTime() + 1000 * 2 ** (failures - 1),
      };
    }
    const failure =
      received.error instanceof WechatIngressError &&
      received.error.reason === "default_agent_unavailable"
        ? "default_agent_unavailable"
        : "processing_failed";
    const notified = await settle(
      set(
        sendWechatInputFailureNotice$,
        { connection, message, failure },
        signal,
      ),
      signal,
    );
    if (!notified.ok) {
      log.warn("WeChat input failure notice failed", { error: notified.error });
    }
  },
);
export const processPendingBatch$ = command(
  async (
    { set },
    args: { connection: Connection; batchCiphertext: string },
    signal: AbortSignal,
  ): Promise<void> => {
    const { connection } = args;
    let { batchCiphertext } = args;
    const db = set(writeDb$);
    const live = and(
      eq(wechatConnections.id, connection.id),
      eq(wechatConnections.generation, connection.generation),
      eq(wechatConnections.status, connection.status),
    );
    const batch = pendingBatchSchema.parse(
      JSON.parse(await decryptStoredSecretValue(batchCiphertext)) as unknown,
    );
    signal.throwIfAborted();

    let remaining = batch.msgs ?? [];
    for (const message of batch.msgs ?? []) {
      const retry = batch.retries[message.message_id];
      if (retry && retry.nextAttemptAt > nowDate().getTime()) {
        continue;
      }

      const nextRetry = await set(
        receiveBatchInput$,
        { connection, message, retry },
        signal,
      );
      const keep = nextRetry !== undefined;
      if (nextRetry) {
        batch.retries[message.message_id] = nextRetry;
      }
      if (!keep) {
        remaining = remaining.filter((pending) => {
          return pending.message_id !== message.message_id;
        });
        delete batch.retries[message.message_id];
      }
      // Checkpoint each outcome. A crash replays only unfinished inputs, while a
      // failed input never prevents later inputs in this batch from being admitted.
      const nextCiphertext = remaining.length
        ? await encryptStoredSecretValue(
            JSON.stringify({ ...batch, msgs: remaining }),
          )
        : null;
      signal.throwIfAborted();
      const [saved] = await db
        .update(wechatConnections)
        .set({ pendingBatchCiphertext: nextCiphertext, updatedAt: nowDate() })
        .where(
          and(
            live,
            eq(wechatConnections.pendingBatchCiphertext, batchCiphertext),
          ),
        )
        .returning({ id: wechatConnections.id });
      signal.throwIfAborted();
      if (!saved || nextCiphertext === null) {
        return;
      }
      batchCiphertext = nextCiphertext;
    }
    if (!remaining.length) {
      await db
        .update(wechatConnections)
        .set({ pendingBatchCiphertext: null, updatedAt: nowDate() })
        .where(
          and(
            live,
            eq(wechatConnections.pendingBatchCiphertext, batchCiphertext),
          ),
        );
      signal.throwIfAborted();
    }
  },
);
