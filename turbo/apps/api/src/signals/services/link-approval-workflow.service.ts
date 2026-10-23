import { command } from "ccstate";
import {
  and,
  asc,
  eq,
  gt,
  inArray,
  isNotNull,
  isNull,
  notExists,
  or,
} from "drizzle-orm";
import { QueryBuilder } from "drizzle-orm/pg-core";
import { agentRuns } from "@okouai/db/runtime/agent-run";
import {
  linkWalletConnections,
  linkWalletSpends,
} from "@okouai/db/schema/link-wallet";
import { chatEvents } from "@okouai/db/schema/chat-event";
import { chatThreads } from "@okouai/db/schema/chat-thread";
import { now, nowDate } from "../../lib/time";
import { logger } from "../../lib/log";
import { env } from "../../lib/env";
import { setAuthContext$ } from "../auth/auth-context";
import { db$ } from "../external/db";
import { publishUserSignal } from "../external/realtime";
import { settle, tapError } from "../utils";
import { getMemberRoleAndUpdateCache$ } from "./auth.service";
import { sendNormalEvent$ } from "./chat-events.command";
import { getWalletSpend$ } from "./link-wallet.service";
import { LinkWalletError } from "./link-wallet-provider.service";
import {
  linkApprovalEnabled$,
  startLinkApprovalWorkflow,
} from "./link-approval-config.service";
import { walletApprovalPrompt } from "./link-wallet-continuation.service";

const L = logger("LinkApproval");
const FINAL_CHECK_GRACE_MS = 120_000;

const approvalToObserve$ = command(
  async ({ get, set }, spendId: string, signal: AbortSignal) => {
    const database = get(db$);
    const [row] = await database
      .select()
      .from(linkWalletSpends)
      .where(eq(linkWalletSpends.id, spendId))
      .limit(1);
    signal.throwIfAborted();
    if (
      !row?.approvalThreadId ||
      !row.approvalRunId ||
      now() > row.expiresAt.getTime() + FINAL_CHECK_GRACE_MS ||
      !(await set(linkApprovalEnabled$, row, signal))
    ) {
      return undefined;
    }

    // Provenance is server-written at purchase creation, not supplied by Worker.
    const [source] = await database
      .select({ id: agentRuns.id })
      .from(agentRuns)
      .innerJoin(chatThreads, eq(chatThreads.id, agentRuns.chatThreadId))
      .where(
        and(
          eq(agentRuns.id, row.approvalRunId),
          eq(agentRuns.triggerSource, "web"),
          eq(agentRuns.orgId, row.orgId),
          eq(agentRuns.userId, row.userId),
          eq(agentRuns.agentId, row.agentId),
          eq(chatThreads.id, row.approvalThreadId),
          eq(chatThreads.userId, row.userId),
          eq(chatThreads.agentId, row.agentId),
        ),
      )
      .limit(1);
    signal.throwIfAborted();
    if (!source) {
      return undefined;
    }
    const [delivered] = await database
      .select({ id: chatEvents.id })
      .from(chatEvents)
      .where(
        or(eq(chatEvents.id, row.id), eq(chatEvents.revokesEventId, row.id)),
      )
      .limit(1);
    signal.throwIfAborted();
    if (delivered) {
      return undefined;
    }
    return { ...row, approvalThreadId: row.approvalThreadId };
  },
);

const approvalFailureState$ = command(
  async (
    { get },
    row: typeof linkWalletSpends.$inferSelect,
    error: unknown,
    signal: AbortSignal,
  ): Promise<{ state: "waiting" | "done" }> => {
    if (
      error instanceof LinkWalletError &&
      [
        "WALLET_CONNECT_REQUIRED",
        "WALLET_RECONNECT_REQUIRED",
        "WALLET_AUTHORIZATION_CHANGED",
      ].includes(error.code)
    ) {
      // Retry recoverable authorization failures while the original grant is
      // still active; a revoked or replaced grant ends this approval watch.
      const [grant] = await get(db$)
        .select({ id: linkWalletConnections.id })
        .from(linkWalletConnections)
        .where(
          and(
            eq(linkWalletConnections.id, row.connectionId),
            eq(linkWalletConnections.orgId, row.orgId),
            eq(linkWalletConnections.userId, row.userId),
            eq(linkWalletConnections.authorizationId, row.authorizationId),
            isNull(linkWalletConnections.revokedAt),
          ),
        )
        .limit(1);
      signal.throwIfAborted();
      return { state: grant ? "waiting" : "done" };
    }
    if (
      error instanceof LinkWalletError &&
      [401, 403, 404, 409].includes(error.status)
    ) {
      return { state: "done" };
    }
    throw error;
  },
);

export const pollLinkApproval$ = command(
  async (
    { get, set },
    spendId: string,
    signal: AbortSignal,
  ): Promise<{ state: "waiting" | "done" }> => {
    const row = await set(approvalToObserve$, spendId, signal);
    signal.throwIfAborted();
    if (!row) {
      return { state: "done" };
    }
    const database = get(db$);
    const membership = await set(
      getMemberRoleAndUpdateCache$,
      row.orgId,
      row.userId,
      signal,
    );
    signal.throwIfAborted();
    if (membership.kind !== "member") {
      return { state: "done" };
    }
    const auth = {
      tokenType: "session" as const,
      orgId: row.orgId,
      userId: row.userId,
      orgRole: membership.role,
    };
    set(setAuthContext$, auth);
    const observed = await settle(
      set(
        getWalletSpend$,
        {
          orgId: row.orgId,
          userId: row.userId,
          agentId: row.agentId,
        },
        row.id,
        false,
        signal,
      ),
      signal,
    );
    signal.throwIfAborted();
    // The card must leave its waiting state at the deadline even when the
    // provider fails or an approved purchase is waiting for an active chat.
    if (now() >= row.expiresAt.getTime()) {
      await publishUserSignal([row.userId], "wallet:changed", {
        orgId: row.orgId,
      });
      signal.throwIfAborted();
    }
    if (!observed.ok) {
      return await set(approvalFailureState$, row, observed.error, signal);
    }
    const spend = observed.value;
    if (spend.status !== "approved") {
      return {
        state:
          now() < row.expiresAt.getTime() &&
          ["check_status", "wait_for_user"].includes(spend.nextAction)
            ? "waiting"
            : "done",
      };
    }
    // Never interrupt the approving run or a user's manual continuation.
    const [active] = await database
      .select({ id: agentRuns.id })
      .from(agentRuns)
      .where(
        and(
          eq(agentRuns.chatThreadId, row.approvalThreadId),
          inArray(agentRuns.status, ["pending", "running"]),
        ),
      )
      .limit(1);
    signal.throwIfAborted();
    if (active) {
      return { state: "waiting" };
    }
    const prompt = walletApprovalPrompt(row);
    const response = await set(
      sendNormalEvent$,
      {
        auth,
        orgId: row.orgId,
        userId: row.userId,
        body: {
          agentId: row.agentId,
          threadId: row.approvalThreadId,
          clientEventId: row.id,
          chatThreadSortEventId: row.id,
          prompt,
          hasTextContent: true,
          userMessage: { version: 1, parts: [{ type: "text", text: prompt }] },
        },
      },
      signal,
    );
    signal.throwIfAborted();
    if (response.status >= 400) {
      throw new Error(
        `Link approval continuation enqueue failed: ${response.status}`,
      );
    }
    await publishUserSignal([row.userId], "wallet:changed", {
      orgId: row.orgId,
    });
    signal.throwIfAborted();
    return { state: "done" };
  },
);

/** The spend row is the durable start intent; Cron does no provider polling. */
export const recoverLinkApprovalWorkflows$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    if (!env("LINK_APPROVAL_WORKER_URL")) {
      return 0;
    }
    let after: string | undefined;
    let started = 0;
    // Keyset pages prevent long-lived pending requests starving newly created ones.
    for (;;) {
      const rows = await get(db$)
        .select()
        .from(linkWalletSpends)
        .where(
          and(
            isNotNull(linkWalletSpends.approvalThreadId),
            gt(
              linkWalletSpends.expiresAt,
              new Date(nowDate().getTime() - FINAL_CHECK_GRACE_MS),
            ),
            or(
              inArray(linkWalletSpends.status, [
                "pending_approval",
                "approved",
              ]),
              and(
                eq(linkWalletSpends.status, "requires_action"),
                eq(linkWalletSpends.actionResolution, "auto_resume"),
              ),
            ),
            after ? gt(linkWalletSpends.id, after) : undefined,
            notExists(
              new QueryBuilder()
                .select({ id: chatEvents.id })
                .from(chatEvents)
                .where(
                  or(
                    eq(chatEvents.id, linkWalletSpends.id),
                    eq(chatEvents.revokesEventId, linkWalletSpends.id),
                  ),
                ),
            ),
          ),
        )
        .orderBy(asc(linkWalletSpends.id))
        .limit(100);
      signal.throwIfAborted();
      for (const row of rows) {
        if (!(await set(linkApprovalEnabled$, row, signal))) {
          continue;
        }
        await tapError(
          startLinkApprovalWorkflow(
            { spendId: row.id, deadline: row.expiresAt.toISOString() },
            signal,
          ),
          (error) => {
            return L.warn("Link approval Workflow recovery failed", {
              spendId: row.id,
              error,
            });
          },
        );
        signal.throwIfAborted();
        started++;
      }
      if (rows.length < 100) {
        return started;
      }
      after = rows.at(-1)?.id;
    }
  },
);
