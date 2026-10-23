import { randomUUID } from "node:crypto";
import { command } from "ccstate";
import {
  and,
  eq,
  exists,
  gt,
  inArray,
  isNull,
  lte,
  not,
  or,
  sql,
} from "drizzle-orm";
import { QueryBuilder } from "drizzle-orm/pg-core";
import * as z from "zod";
import type { DesktopShellAuthorization } from "@okouai/api-contracts/contracts/desktop-shell-authorization";
import { agentRuns } from "@okouai/db/runtime/agent-run";
import { chatThreads } from "@okouai/db/runtime/chat-thread";
import { computerUseHosts } from "@okouai/db/runtime/computer-use-host";
import { desktopShellAuthorizations } from "@okouai/db/schema/desktop-shell-authorization";
import { computerUseCommands } from "@okouai/db/schema/computer-use-host";
import { agents } from "@okouai/db/schema/agent";
import { activeAgentRuns } from "@okouai/db/schema/active-agent-run";
import { queuedChatThreads } from "@okouai/db/schema/queued-chat-thread";
import { env } from "../../lib/env";
import { parseRawRows } from "../../lib/db-raw-rows";
import { pgBooleanDecoder } from "../../lib/db-structured-result";
import { nowDate } from "../../lib/time";
import { db$, writeDb$ } from "../external/db";
import { resolveChatInputModelSelection$ } from "./chat-input-model.service";
import { canonicalChatEventAppendCtes } from "./chat-event-append.service";
import { queuedChatThreadEnqueuePlan } from "./queued-chat-thread.service";
import { webChatContextId } from "./web-chat-queue-context.service";
import {
  queuedShellCommandCondition,
  queuedShellGrantDeniedValues,
} from "./desktop-shell-grant";

const HOUR_MS = 60 * 60 * 1000;
type Owner = { readonly orgId: string; readonly userId: string };
type Row = typeof desktopShellAuthorizations.$inferSelect;

function scope(owner: Owner, chatThreadId: string, computerUseHostId: string) {
  return and(
    eq(desktopShellAuthorizations.orgId, owner.orgId),
    eq(desktopShellAuthorizations.userId, owner.userId),
    eq(desktopShellAuthorizations.chatThreadId, chatThreadId),
    eq(desktopShellAuthorizations.computerUseHostId, computerUseHostId),
  );
}

function effectiveStatus(row: Row, now: Date): Row["status"] {
  if (row.status === "pending" && row.requestExpiresAt <= now) {
    return "expired";
  }
  if (
    row.status === "approved" &&
    row.grantExpiresAt !== null &&
    row.grantExpiresAt <= now
  ) {
    return "expired";
  }
  return row.status;
}

export const readDesktopShellAuthorization$ = command(
  async ({ get }, owner: Owner, id: string, signal: AbortSignal) => {
    const [context] = await get(db$)
      .select({
        row: desktopShellAuthorizations,
        computerName: computerUseHosts.displayName,
        thread: {
          id: chatThreads.id,
          agentId: agents.id,
          selectedModel: chatThreads.selectedModel,
          modelSettings: chatThreads.modelSettings,
          codexServiceTier: chatThreads.codexServiceTier,
          computerUseHostId: chatThreads.computerUseHostId,
        },
        sourceRunStatus: agentRuns.status,
        chatBusy: exists(
          new QueryBuilder()
            .select({ runId: activeAgentRuns.runId })
            .from(activeAgentRuns)
            .where(eq(activeAgentRuns.chatThreadId, chatThreads.id)),
        ).mapWith(pgBooleanDecoder),
      })
      .from(desktopShellAuthorizations)
      .innerJoin(
        chatThreads,
        and(
          eq(chatThreads.id, desktopShellAuthorizations.chatThreadId),
          eq(chatThreads.userId, owner.userId),
        ),
      )
      .innerJoin(
        agents,
        and(eq(agents.id, chatThreads.agentId), eq(agents.orgId, owner.orgId)),
      )
      .innerJoin(
        computerUseHosts,
        and(
          eq(computerUseHosts.id, desktopShellAuthorizations.computerUseHostId),
          eq(computerUseHosts.orgId, owner.orgId),
          eq(computerUseHosts.userId, owner.userId),
          isNull(computerUseHosts.revokedAt),
        ),
      )
      .leftJoin(
        agentRuns,
        and(
          eq(agentRuns.id, desktopShellAuthorizations.requestedByRunId),
          eq(agentRuns.orgId, owner.orgId),
          eq(agentRuns.userId, owner.userId),
          eq(agentRuns.chatThreadId, chatThreads.id),
        ),
      )
      .where(
        and(
          eq(desktopShellAuthorizations.id, id),
          eq(desktopShellAuthorizations.orgId, owner.orgId),
          eq(desktopShellAuthorizations.userId, owner.userId),
        ),
      )
      .limit(1);
    signal.throwIfAborted();
    if (!context) {
      return null;
    }
    const { row, thread, sourceRunStatus, chatBusy } = context;
    const status = effectiveStatus(row, nowDate());
    const approvalBlockedReason: DesktopShellAuthorization["approvalBlockedReason"] =
      status !== "pending"
        ? null
        : sourceRunStatus === null
          ? "run_unavailable"
          : !["completed", "failed", "cancelled", "timeout"].includes(
                sourceRunStatus,
              )
            ? "run_active"
            : thread.computerUseHostId !== row.computerUseHostId
              ? "computer_changed"
              : chatBusy
                ? "chat_busy"
                : null;
    const authorization: DesktopShellAuthorization = {
      id: row.id,
      chatThreadId: row.chatThreadId,
      computerUseHostId: row.computerUseHostId,
      computerName: context.computerName,
      requestedByRunId: row.requestedByRunId,
      reason: row.reason,
      status,
      requestExpiresAt: row.requestExpiresAt.toISOString(),
      approvedAt: row.approvedAt?.toISOString() ?? null,
      grantExpiresAt: row.grantExpiresAt?.toISOString() ?? null,
      approvalBlockedReason,
      authorizationUrl: `${env("APP_URL")}/computer-use/shell/authorize/${row.id}`,
    };
    return { authorization, thread };
  },
);

export const createDesktopShellAuthorization$ = command(
  async (
    { get, set },
    args: Owner & {
      readonly runId: string;
      readonly computerUseHostId: string;
      readonly reason: string;
    },
    signal: AbortSignal,
  ) => {
    const [run] = await get(db$)
      .select({ chatThreadId: chatThreads.id })
      .from(agentRuns)
      .innerJoin(
        chatThreads,
        and(
          eq(chatThreads.id, agentRuns.chatThreadId),
          eq(chatThreads.userId, args.userId),
          eq(chatThreads.computerUseHostId, args.computerUseHostId),
        ),
      )
      .innerJoin(
        agents,
        and(eq(agents.id, chatThreads.agentId), eq(agents.orgId, args.orgId)),
      )
      .innerJoin(
        computerUseHosts,
        and(
          eq(computerUseHosts.id, args.computerUseHostId),
          eq(computerUseHosts.orgId, args.orgId),
          eq(computerUseHosts.userId, args.userId),
          isNull(computerUseHosts.revokedAt),
        ),
      )
      .where(
        and(
          eq(agentRuns.id, args.runId),
          eq(agentRuns.orgId, args.orgId),
          eq(agentRuns.userId, args.userId),
          eq(agentRuns.triggerSource, "web"),
        ),
      )
      .limit(1);
    signal.throwIfAborted();
    if (!run) {
      return null;
    }
    const now = nowDate();
    const id = randomUUID();
    const predicate = scope(args, run.chatThreadId, args.computerUseHostId);
    const retired = set(writeDb$)
      .update(desktopShellAuthorizations)
      .set({ status: "expired", updatedAt: now })
      .where(
        and(
          predicate,
          or(
            and(
              eq(desktopShellAuthorizations.status, "pending"),
              lte(desktopShellAuthorizations.requestExpiresAt, now),
            ),
            and(
              eq(desktopShellAuthorizations.status, "approved"),
              lte(desktopShellAuthorizations.grantExpiresAt, now),
            ),
          ),
        ),
      )
      .returning({ id: desktopShellAuthorizations.id });
    const [created] = parseRawRows(
      z.object({ id: z.uuid() }),
      await set(writeDb$).execute(sql`
      WITH retired AS (${retired.getSQL()}), created AS (
        INSERT INTO ${desktopShellAuthorizations} (id, org_id, user_id, chat_thread_id, computer_use_host_id, requested_by_run_id, reason, status, request_expires_at, created_at, updated_at)
        SELECT ${id}::uuid, ${args.orgId}, ${args.userId}, ${run.chatThreadId}::uuid, ${args.computerUseHostId}::uuid, ${args.runId}::uuid, ${args.reason}, 'pending', ${new Date(now.getTime() + HOUR_MS).toISOString()}::timestamp, ${now.toISOString()}::timestamp, ${now.toISOString()}::timestamp
        FROM (SELECT count(*) FROM retired) AS retirement
        ON CONFLICT DO NOTHING RETURNING id
      ) SELECT id FROM created UNION ALL
      SELECT ${desktopShellAuthorizations.id} FROM ${desktopShellAuthorizations}
      WHERE ${predicate} AND (
        ${desktopShellAuthorizations.requestedByRunId} = ${args.runId}::uuid
        OR (${desktopShellAuthorizations.status} = 'pending' AND ${desktopShellAuthorizations.requestExpiresAt} > ${now.toISOString()}::timestamp)
        OR (${desktopShellAuthorizations.status} = 'approved' AND ${desktopShellAuthorizations.grantExpiresAt} > ${now.toISOString()}::timestamp)
      ) LIMIT 1
    `),
    );
    signal.throwIfAborted();
    return created?.id ?? null;
  },
);

type Context = NonNullable<
  Awaited<ReturnType<(typeof readDesktopShellAuthorization$)["write"]>>
>;

function pendingApprovalCondition(
  owner: Owner,
  authorization: DesktopShellAuthorization,
  now: Date,
) {
  return and(
    eq(desktopShellAuthorizations.id, authorization.id),
    scope(owner, authorization.chatThreadId, authorization.computerUseHostId),
    eq(desktopShellAuthorizations.status, "pending"),
    gt(desktopShellAuthorizations.requestExpiresAt, now),
    exists(
      new QueryBuilder()
        .select({ id: agentRuns.id })
        .from(agentRuns)
        .where(
          and(
            eq(agentRuns.id, desktopShellAuthorizations.requestedByRunId),
            eq(agentRuns.orgId, owner.orgId),
            eq(agentRuns.userId, owner.userId),
            eq(agentRuns.chatThreadId, authorization.chatThreadId),
            inArray(agentRuns.status, [
              "completed",
              "failed",
              "cancelled",
              "timeout",
            ]),
          ),
        ),
    ),
    exists(
      new QueryBuilder()
        .select({ id: chatThreads.id })
        .from(chatThreads)
        .innerJoin(agents, eq(agents.id, chatThreads.agentId))
        .innerJoin(
          computerUseHosts,
          eq(computerUseHosts.id, chatThreads.computerUseHostId),
        )
        .where(
          and(
            eq(chatThreads.id, authorization.chatThreadId),
            eq(chatThreads.userId, owner.userId),
            eq(agents.orgId, owner.orgId),
            eq(chatThreads.computerUseHostId, authorization.computerUseHostId),
            eq(computerUseHosts.orgId, owner.orgId),
            eq(computerUseHosts.userId, owner.userId),
            isNull(computerUseHosts.revokedAt),
          ),
        ),
    ),
    not(
      exists(
        new QueryBuilder()
          .select({ runId: activeAgentRuns.runId })
          .from(activeAgentRuns)
          .where(eq(activeAgentRuns.chatThreadId, authorization.chatThreadId)),
      ),
    ),
  );
}

export const approveDesktopShellAuthorization$ = command(
  async ({ set }, owner: Owner, context: Context, signal: AbortSignal) => {
    const { authorization, thread } = context;
    if (
      authorization.status !== "pending" ||
      authorization.approvalBlockedReason !== null
    ) {
      return { status: "conflict" as const };
    }
    const model = await set(
      resolveChatInputModelSelection$,
      {
        ...owner,
        selectedModel: thread.selectedModel,
        codexServiceTier: thread.codexServiceTier,
        modelSettings: thread.modelSettings,
      },
      signal,
    );
    if ("status" in model) {
      return {
        status: "model_unavailable" as const,
        message: model.body.error.message,
      };
    }
    const now = nowDate();
    const expires = new Date(now.getTime() + HOUR_MS);
    const prompt = `Shell access was approved for this chat's selected computer until ${expires.toISOString()}. Recheck access and continue the previous task. Do not replay uncertain command input.`;
    const db = set(writeDb$);
    const approved = db
      .update(desktopShellAuthorizations)
      .set({
        status: "approved",
        approvedAt: now,
        grantExpiresAt: expires,
        updatedAt: now,
      })
      .where(pendingApprovalCondition(owner, authorization, now))
      .returning({ id: desktopShellAuthorizations.id });
    const input = canonicalChatEventAppendCtes(
      [
        {
          id: authorization.id,
          chatThreadId: authorization.chatThreadId,
          eventType: "input.prompt",
          runId: null,
          contextType: "web",
          contextId: webChatContextId(),
          payload: {
            userMessage: {
              version: 1,
              parts: [{ type: "text", text: prompt }],
            },
          },
          modelSelection: model,
          createdAt: now,
        },
      ],
      "none",
      sql`EXISTS (SELECT 1 FROM approved)`,
    );
    const enqueue = queuedChatThreadEnqueuePlan({
      chatThreadId: authorization.chatThreadId,
      orgId: owner.orgId,
    });
    const [result] = parseRawRows(
      z.object({ applied: z.boolean() }),
      await db.execute(sql`
      WITH approved AS (${approved.getSQL()}), ${input}, enqueued AS (
        INSERT INTO ${queuedChatThreads} (chat_thread_id, org_id, queued_at)
        SELECT ${authorization.chatThreadId}::uuid, ${owner.orgId}, ${enqueue.values.queuedAt.toISOString()}::timestamp FROM inserted
        ON CONFLICT (chat_thread_id) DO UPDATE SET queued_at = greatest(EXCLUDED.queued_at, ${queuedChatThreads.queuedAt} + interval '1 millisecond')
      ) SELECT EXISTS (SELECT 1 FROM approved) AS applied
    `),
    );
    signal.throwIfAborted();
    if (!result) {
      throw new Error("Shell approval returned no outcome");
    }
    return {
      status: result.applied ? ("approved" as const) : ("conflict" as const),
    };
  },
);

export const retireDesktopShellAuthorization$ = command(
  async (
    { set },
    owner: Owner,
    id: string,
    action: "deny" | "revoke",
    signal: AbortSignal,
  ) => {
    const now = nowDate();
    const db = set(writeDb$);
    const retired = db
      .update(desktopShellAuthorizations)
      .set({ status: action === "deny" ? "denied" : "revoked", updatedAt: now })
      .where(
        and(
          eq(desktopShellAuthorizations.id, id),
          eq(desktopShellAuthorizations.orgId, owner.orgId),
          eq(desktopShellAuthorizations.userId, owner.userId),
          eq(
            desktopShellAuthorizations.status,
            action === "deny" ? "pending" : "approved",
          ),
        ),
      )
      .returning({ id: desktopShellAuthorizations.id });
    const failed = db
      .update(computerUseCommands)
      .set(queuedShellGrantDeniedValues(now))
      .where(
        and(
          eq(computerUseCommands.shellAuthorizationId, id),
          eq(computerUseCommands.orgId, owner.orgId),
          eq(computerUseCommands.userId, owner.userId),
          queuedShellCommandCondition(),
          sql`EXISTS (SELECT 1 FROM retired)`,
        ),
      );
    const retiredRows = parseRawRows(
      z.object({ id: z.uuid() }),
      await db.execute(
        sql`WITH retired AS (${retired.getSQL()}), failed AS (${failed.getSQL()}) SELECT id FROM retired`,
      ),
    );
    signal.throwIfAborted();
    return retiredRows.length > 0;
  },
);
