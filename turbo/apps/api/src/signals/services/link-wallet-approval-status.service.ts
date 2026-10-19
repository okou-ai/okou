import { command } from "ccstate";
import { and, eq, isNull, or } from "drizzle-orm";
import { chatEvents } from "@okouai/db/schema/chat-event";
import {
  linkWalletConnections,
  linkWalletSpends,
} from "@okouai/db/schema/link-wallet";
import { now } from "../../lib/time";
import { db$ } from "../external/db";
import { linkApprovalEnabled$ } from "./link-approval-config.service";

/** UI reads only our recorded state; opening a card never polls Link. */
export const walletApprovalStatus$ = command(
  async (
    { get, set },
    owner: { readonly userId: string; readonly orgId: string },
    input: {
      readonly agentId: string;
      readonly threadId: string;
      readonly approvalUrl: string;
    },
    signal: AbortSignal,
  ): Promise<{
    status: "pending" | "approved" | "continued" | "stopped" | "unavailable";
  }> => {
    if (!(await set(linkApprovalEnabled$, owner, signal))) {
      return { status: "unavailable" };
    }
    const database = get(db$);
    const [row] = await database
      .select({
        id: linkWalletSpends.id,
        status: linkWalletSpends.status,
        expiresAt: linkWalletSpends.expiresAt,
        actionResolution: linkWalletSpends.actionResolution,
      })
      .from(linkWalletSpends)
      .innerJoin(
        linkWalletConnections,
        and(
          eq(linkWalletConnections.id, linkWalletSpends.connectionId),
          eq(
            linkWalletConnections.authorizationId,
            linkWalletSpends.authorizationId,
          ),
          isNull(linkWalletConnections.revokedAt),
        ),
      )
      .where(
        and(
          eq(linkWalletSpends.orgId, owner.orgId),
          eq(linkWalletSpends.userId, owner.userId),
          eq(linkWalletSpends.agentId, input.agentId),
          eq(linkWalletSpends.approvalThreadId, input.threadId),
          eq(linkWalletSpends.approvalUrl, input.approvalUrl),
        ),
      )
      .limit(1);
    signal.throwIfAborted();
    if (!row) {
      return { status: "unavailable" };
    }
    const [event] = await database
      .select({ id: chatEvents.id })
      .from(chatEvents)
      .where(
        or(eq(chatEvents.id, row.id), eq(chatEvents.revokesEventId, row.id)),
      )
      .limit(1);
    signal.throwIfAborted();
    if (
      ![
        "creating",
        "created",
        "pending_approval",
        "requires_action",
        "approved",
      ].includes(row.status) ||
      (row.status === "requires_action" &&
        row.actionResolution !== "auto_resume")
    ) {
      return { status: "stopped" };
    }
    if (event) {
      return { status: "continued" };
    }
    if (now() >= row.expiresAt.getTime()) {
      return { status: "stopped" };
    }
    if (row.status === "approved") {
      return { status: "approved" };
    }
    return {
      status: [
        "creating",
        "created",
        "pending_approval",
        "requires_action",
      ].includes(row.status)
        ? "pending"
        : "stopped",
    };
  },
);
