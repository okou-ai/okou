import { command } from "ccstate";
import { and, eq } from "drizzle-orm";
import { wechatConnections, wechatMessages } from "@okouai/db/schema/wechat";
import type { WechatReceipt } from "@okouai/api-contracts/contracts/integrations-wechat-messages";
import { writeDb$ } from "../external/db";
import {
  sendWechatText,
  WechatSessionExpiredError,
} from "@okouai/core/wechat-client";
import { settle } from "../utils";
import { conflict } from "../../lib/error";
import { monotonicNow, nowDate } from "../../lib/time";
import {
  requireLiveWechatSendConnection$,
  requireWechatSendAccess$,
  type WechatOwner,
  type WechatSendAccess,
} from "./wechat-access.service";
import { wechatEventId } from "./wechat-message-identity";
import { recordWechatDeliveryPhase } from "./wechat-delivery-timing.service";

interface ExistingReceiptArgs {
  readonly id: string;
  readonly channelId: string;
  readonly text: string;
  readonly requestHash: string;
}
const existingReceipt$ = command(
  async ({ set }, args: ExistingReceiptArgs, signal: AbortSignal) => {
    const db = set(writeDb$);
    const { id } = args;
    const [existing] = await db
      .select({
        content: wechatMessages.content,
        requestHash: wechatMessages.requestHash,
        status: wechatMessages.status,
        providerMessageId: wechatMessages.providerMessageId,
      })
      .from(wechatMessages)
      .where(
        and(
          eq(wechatMessages.id, id),
          eq(wechatMessages.connectionId, args.channelId),
        ),
      )
      .limit(1);
    signal.throwIfAborted();
    if (
      !existing ||
      existing.content !== args.text ||
      existing.requestHash !== args.requestHash
    ) {
      return {
        kind: "denied",
        response: conflict("This operation ID was used for another message."),
      } as const;
    }
    if (existing.status !== "sent") {
      return {
        kind: "denied",
        response: {
          ...conflict(
            "WeChat has not confirmed this message. It was not sent again. Check history before starting another operation.",
          ),
          body: {
            error: {
              code: "WECHAT_DELIVERY_UNKNOWN",
              message:
                "WeChat has not confirmed this message. It was not sent again.",
              uncertainMessageId: id,
            },
          },
        },
      } as const;
    }
    return {
      kind: "sent",
      message: {
        id,
        channelId: args.channelId,
        providerMessageId: existing.providerMessageId,
        url: null,
      } satisfies WechatReceipt,
    } as const;
  },
);

const releaseUnsentWechatClaim$ = command(
  async ({ set }, id: string, signal: AbortSignal): Promise<void> => {
    await set(writeDb$)
      .delete(wechatMessages)
      .where(
        and(eq(wechatMessages.id, id), eq(wechatMessages.status, "unknown")),
      );
    signal.throwIfAborted();
  },
);

interface WechatTextChunk {
  readonly operationId: string;
  readonly index: number;
  readonly text: string;
  readonly requestHash: string;
  readonly runId?: string | null;
}

/** Prepared access belongs to one chunk; callers reauthorize subsequent sends. */
export const sendPreparedWechatText$ = command(
  async (
    { set },
    access: WechatSendAccess,
    args: WechatTextChunk,
    signal: AbortSignal,
  ) => {
    const { connection } = access;
    const db = set(writeDb$);
    // Identity survives reconnects: repeating an operation cannot resend earlier chunks.
    const id = wechatEventId(
      connection.id,
      args.operationId,
      `outbound:${args.index}`,
    );
    const [claimed] = await db
      .insert(wechatMessages)
      .values({
        id,
        connectionId: connection.id,
        generation: connection.generation,
        direction: "outbound",
        status: "unknown",
        content: args.text,
        requestHash: args.requestHash,
        createdAt: nowDate(),
      })
      .onConflictDoNothing()
      .returning({ id: wechatMessages.id });
    signal.throwIfAborted();
    if (!claimed) {
      return await set(
        existingReceipt$,
        { ...args, id, channelId: connection.id },
        signal,
      );
    }
    // Recheck the live binding after claiming, immediately before provider I/O.
    // A known pre-send failure can release the claim; an interrupted provider
    // attempt must remain unknown and must never be resent.
    const checked = await settle(
      set(requireLiveWechatSendConnection$, connection, signal),
      signal,
    );
    if (!checked.ok) {
      await set(releaseUnsentWechatClaim$, id, signal);
      throw checked.error;
    }
    const live = checked.value;
    if (live.kind === "denied") {
      await set(releaseUnsentWechatClaim$, id, signal);
      return live;
    }
    const timing = {
      inputEventId: access.contextId,
      operationId: args.operationId,
      chunkIndex: args.index,
      runId: args.runId ?? undefined,
    };
    const sendStartedAt = monotonicNow();
    recordWechatDeliveryPhase({
      ...timing,
      phase: "send_start",
      durationMs: 0,
      success: true,
    });
    const result = await settle(
      sendWechatText(
        {
          baseUrl: connection.baseUrl,
          token: access.token,
          contextToken: access.contextToken,
          senderId: connection.senderId,
          clientId: `okou-${id}`,
          text: args.text,
        },
        signal,
      ),
      signal,
    );
    // A successful provider response is the send acknowledgement, before archiving.
    recordWechatDeliveryPhase({
      ...timing,
      phase: "provider_send",
      durationMs: monotonicNow() - sendStartedAt,
      success: result.ok,
    });
    signal.throwIfAborted();
    if (!result.ok) {
      if (result.error instanceof WechatSessionExpiredError) {
        await db
          .update(wechatConnections)
          .set({ status: "reconnect_required", updatedAt: nowDate() })
          .where(
            and(
              eq(wechatConnections.id, connection.id),
              eq(wechatConnections.generation, connection.generation),
            ),
          );
        signal.throwIfAborted();
      }
      return {
        kind: "denied",
        response: {
          status: 502,
          body: {
            error: {
              code: "WECHAT_DELIVERY_UNKNOWN",
              message:
                "WeChat did not confirm delivery. Do not blindly resend this operation.",
              uncertainMessageId: id,
            },
          },
        },
      } as const;
    }
    const providerMessageId = result.value.message_id ?? null;
    await db
      .update(wechatMessages)
      .set({ status: "sent", providerMessageId })
      .where(eq(wechatMessages.id, id));
    signal.throwIfAborted();
    return {
      kind: "sent",
      message: {
        id,
        channelId: connection.id,
        providerMessageId,
        url: null,
      } satisfies WechatReceipt,
    } as const;
  },
);

export const sendArchivedWechatText$ = command(
  async (
    { set },
    args: WechatOwner &
      WechatTextChunk & {
        readonly generation?: string;
        readonly contextId?: string;
      },
    signal: AbortSignal,
  ) => {
    const access = await set(requireWechatSendAccess$, args, signal);
    if (access.kind === "denied") {
      return access;
    }
    return await set(sendPreparedWechatText$, access, args, signal);
  },
);
