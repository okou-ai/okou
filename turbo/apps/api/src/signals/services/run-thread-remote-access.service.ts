import { isFeatureEnabled } from "@okouai/core/feature-switch";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { agentRuns } from "@okouai/db/runtime/agent-run";
import { agentSessions } from "@okouai/db/schema/agent-session";
import { chatThreadSshAccessOverrides } from "@okouai/db/schema/chat-thread-ssh-access-override";
import { chatThreadVncAccessOverrides } from "@okouai/db/schema/chat-thread-vnc-access-override";
import { chatThreads } from "@okouai/db/schema/chat-thread";
import { sshConnections } from "@okouai/db/schema/ssh-connection";
import { vncConnections } from "@okouai/db/schema/vnc-connection";
import { and, eq, exists, sql } from "drizzle-orm";

import type { ReadonlyDb } from "../external/db";
import { loadUserFeatureSwitchContext } from "./feature-switches.service";

/** The rollout mode is selected for the Run owner, never from Runner input. */
export async function runUsesThreadRemoteAccess(
  db: Pick<ReadonlyDb, "select">,
  runId: string,
  signal: AbortSignal,
): Promise<boolean> {
  const [run] = await db
    .select({ orgId: agentRuns.orgId, userId: agentRuns.userId })
    .from(agentRuns)
    .where(and(eq(agentRuns.id, runId), eq(agentRuns.status, "running")))
    .limit(1);
  signal.throwIfAborted();
  if (!run) {
    return false;
  }
  const context = await loadUserFeatureSwitchContext(db, run.orgId, run.userId);
  signal.throwIfAborted();
  return isFeatureEnabled(FeatureSwitchKey.ThreadRemoteAccess, context);
}

/** A Run must still refer to its own current, Agent-bound chat thread. */
export function runThreadExists(db: Pick<ReadonlyDb, "select">) {
  return exists(
    db
      .select({ id: chatThreads.id })
      .from(chatThreads)
      .where(
        and(
          eq(chatThreads.id, agentRuns.chatThreadId),
          eq(chatThreads.userId, agentRuns.userId),
          eq(chatThreads.agentId, agentSessions.agentId),
        ),
      ),
  );
}

/** Correlated to the outer Run, Session and exact SSH host. */
export function runThreadSshAccess(db: Pick<ReadonlyDb, "select">) {
  return exists(
    db
      .select({ id: chatThreads.id })
      .from(chatThreads)
      .leftJoin(
        chatThreadSshAccessOverrides,
        and(
          eq(chatThreadSshAccessOverrides.chatThreadId, chatThreads.id),
          eq(chatThreadSshAccessOverrides.connectionId, sshConnections.id),
        ),
      )
      .where(
        and(
          eq(chatThreads.id, agentRuns.chatThreadId),
          eq(chatThreads.userId, agentRuns.userId),
          eq(chatThreads.agentId, agentSessions.agentId),
          sql`coalesce(${chatThreadSshAccessOverrides.enabled}, ${sshConnections.defaultEnabledForChats}) = true`,
        ),
      ),
  );
}

/** Correlated to the outer Run, Session and exact VNC host. */
export function runThreadVncAccess(db: Pick<ReadonlyDb, "select">) {
  return exists(
    db
      .select({ id: chatThreads.id })
      .from(chatThreads)
      .leftJoin(
        chatThreadVncAccessOverrides,
        and(
          eq(chatThreadVncAccessOverrides.chatThreadId, chatThreads.id),
          eq(chatThreadVncAccessOverrides.connectionId, vncConnections.id),
        ),
      )
      .where(
        and(
          eq(chatThreads.id, agentRuns.chatThreadId),
          eq(chatThreads.userId, agentRuns.userId),
          eq(chatThreads.agentId, agentSessions.agentId),
          sql`coalesce(${chatThreadVncAccessOverrides.enabled}, ${vncConnections.defaultEnabledForChats}) = true`,
        ),
      ),
  );
}
