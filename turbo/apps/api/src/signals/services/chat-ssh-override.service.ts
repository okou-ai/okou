import { agents } from "@okouai/db/schema/agent";
import { chatThreads } from "@okouai/db/runtime/chat-thread";
import { chatThreadSshAccessOverrides } from "@okouai/db/schema/chat-thread-ssh-access-override";
import { sshConnections } from "@okouai/db/runtime/ssh-connection";
import { and, eq, exists, sql } from "drizzle-orm";
import { command } from "ccstate";
import { writeDb$ } from "../external/db";

interface ThreadSshOwner {
  readonly orgId: string;
  readonly userId: string;
  readonly chatThreadId: string;
  readonly connectionId: string;
}
export const commitThreadSshOverride$ = command(
  async (
    { set },
    owner: ThreadSshOwner,
    enabled: boolean | null,
    signal: AbortSignal,
  ) => {
    const db = set(writeDb$);
    const thread = db
      .select({ id: chatThreads.id })
      .from(chatThreads)
      .innerJoin(
        agents,
        and(eq(agents.id, chatThreads.agentId), eq(agents.orgId, owner.orgId)),
      )
      .where(
        and(
          eq(chatThreads.id, owner.chatThreadId),
          eq(chatThreads.userId, owner.userId),
        ),
      );
    const host = db.$with("authorized_thread_ssh_host").as(
      db
        .select({
          id: sshConnections.id,
          displayName: sshConnections.displayName,
          defaultEnabledForChats: sshConnections.defaultEnabledForChats,
        })
        .from(sshConnections)
        .where(
          and(
            eq(sshConnections.id, owner.connectionId),
            eq(sshConnections.orgId, owner.orgId),
            eq(sshConnections.userId, owner.userId),
            exists(thread),
          ),
        ),
    );
    const changed = db.$with("changed_thread_ssh_override").as(
      enabled === null
        ? db
            .delete(chatThreadSshAccessOverrides)
            .where(
              and(
                eq(
                  chatThreadSshAccessOverrides.chatThreadId,
                  owner.chatThreadId,
                ),
                eq(
                  chatThreadSshAccessOverrides.connectionId,
                  owner.connectionId,
                ),
                exists(db.select({ id: host.id }).from(host)),
              ),
            )
            .returning({ id: chatThreadSshAccessOverrides.connectionId })
        : db
            .insert(chatThreadSshAccessOverrides)
            .select(
              db
                .select({
                  chatThreadId: sql`${owner.chatThreadId}::uuid`
                    .mapWith(chatThreadSshAccessOverrides.chatThreadId)
                    .as("chat_thread_id"),
                  connectionId: host.id,
                  enabled: sql`${enabled}::boolean`
                    .mapWith(chatThreadSshAccessOverrides.enabled)
                    .as("enabled"),
                })
                .from(host),
            )
            .onConflictDoUpdate({
              target: [
                chatThreadSshAccessOverrides.chatThreadId,
                chatThreadSshAccessOverrides.connectionId,
              ],
              set: { enabled },
            })
            .returning({ id: chatThreadSshAccessOverrides.connectionId }),
    );
    const [authorized] = await db
      .with(host, changed)
      .select({
        id: host.id,
        displayName: host.displayName,
        defaultEnabledForChats: host.defaultEnabledForChats,
      })
      .from(host)
      .leftJoin(changed, eq(changed.id, host.id));
    signal.throwIfAborted();
    return authorized ?? null;
  },
);
