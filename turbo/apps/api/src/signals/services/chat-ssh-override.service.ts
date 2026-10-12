import { agents } from "@okouai/db/schema/agent";
import { chatThreads } from "@okouai/db/runtime/chat-thread";
import { chatThreadSshAccessOverrides } from "@okouai/db/schema/chat-thread-ssh-access-override";
import { sshConnections } from "@okouai/db/schema/ssh-connection";
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
    // Publishing an MVCC version fences insertion, replacement and removal alike,
    // including the otherwise-unlockable absence of an override. Metadata is intact.
    const stamped = db.$with("stamped_thread_ssh_host").as(
      db
        .update(sshConnections)
        .set({ displayName: sql`${sshConnections.displayName}` })
        .where(
          and(
            eq(sshConnections.id, owner.connectionId),
            eq(sshConnections.orgId, owner.orgId),
            eq(sshConnections.userId, owner.userId),
            exists(thread),
          ),
        )
        .returning({
          id: sshConnections.id,
          displayName: sshConnections.displayName,
          defaultEnabledForChats: sshConnections.defaultEnabledForChats,
        }),
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
                exists(db.select({ id: stamped.id }).from(stamped)),
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
                  connectionId: stamped.id,
                  enabled: sql`${enabled}::boolean`
                    .mapWith(chatThreadSshAccessOverrides.enabled)
                    .as("enabled"),
                })
                .from(stamped),
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
    const [host] = await db
      .with(stamped, changed)
      .select({
        id: stamped.id,
        displayName: stamped.displayName,
        defaultEnabledForChats: stamped.defaultEnabledForChats,
      })
      .from(stamped)
      .leftJoin(changed, eq(changed.id, stamped.id));
    signal.throwIfAborted();
    return host ?? null;
  },
);
