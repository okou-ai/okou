import { command, computed, type Computed } from "ccstate";
import { and, asc, desc, eq, exists, inArray, sql } from "drizzle-orm";
import { QueryBuilder } from "drizzle-orm/pg-core";
import { agents } from "@okouai/db/schema/agent";
import { chatThreads } from "@okouai/db/runtime/chat-thread";
import {
  chatThreadFolders as folders,
  chatThreadFolderMemberships as memberships,
} from "@okouai/db/schema/chat-thread-folder";
import {
  chatFolderKeyBetween,
  compareChatFolders,
  moveChatFolderRanks,
} from "@okouai/core/chat-folder-order";
import type { ChatFolderCatalog } from "@okouai/api-contracts/contracts/chat-folders";
import { db$, writeDb$ } from "../external/db";
import {
  visibleAgentIdentityCondition,
  visibleJoinedAgentCondition,
} from "./agent-data.service";
import { nowDate } from "../../lib/time";

interface Owner {
  readonly userId: string;
  readonly orgId: string;
}
interface Scope extends Owner {
  readonly agentId: string;
}

function folderScope(scope: Scope) {
  return and(
    eq(folders.userId, scope.userId),
    eq(folders.orgId, scope.orgId),
    eq(folders.agentId, scope.agentId),
  );
}
function visibleFolderOwner(owner: Owner) {
  return and(
    eq(folders.userId, owner.userId),
    eq(folders.orgId, owner.orgId),
    exists(
      new QueryBuilder()
        .select({ id: agents.id })
        .from(agents)
        .where(
          and(
            eq(agents.id, folders.agentId),
            eq(agents.orgId, owner.orgId),
            visibleJoinedAgentCondition(owner.userId),
          ),
        ),
    ),
  );
}

export function chatFolderCatalog(scope$: Computed<Scope>) {
  return computed(async (get): Promise<ChatFolderCatalog | null> => {
    const scope = get(scope$);
    const [agent] = await get(db$)
      .select({ id: agents.id })
      .from(agents)
      .where(visibleAgentIdentityCondition(scope))
      .limit(1);
    if (!agent) {
      return null;
    }
    // One statement supplies a consistent catalog/membership snapshot. Canonical
    // thread scope wins over a membership left by an older Agent writer.
    const rows = await get(db$)
      .select({
        id: folders.id,
        name: folders.name,
        sortKey: folders.sortKey,
        threadId: chatThreads.id,
      })
      .from(folders)
      .innerJoin(
        agents,
        and(
          eq(agents.id, folders.agentId),
          eq(agents.orgId, scope.orgId),
          visibleJoinedAgentCondition(scope.userId),
        ),
      )
      .leftJoin(memberships, eq(memberships.folderId, folders.id))
      .leftJoin(
        chatThreads,
        and(
          eq(chatThreads.id, memberships.chatThreadId),
          eq(chatThreads.userId, scope.userId),
          eq(chatThreads.agentId, folders.agentId),
        ),
      )
      .where(folderScope(scope));
    const catalog: ChatFolderCatalog = { folders: [], memberships: [] };
    const seen = new Set<string>();
    for (const row of rows) {
      if (!seen.has(row.id)) {
        catalog.folders.push({
          id: row.id,
          name: row.name,
          sortKey: row.sortKey,
        });
        seen.add(row.id);
      }
      if (row.threadId) {
        catalog.memberships.push({
          chatThreadId: row.threadId,
          folderId: row.id,
        });
      }
    }
    catalog.folders.sort(compareChatFolders);
    return catalog;
  });
}

export const createChatFolder$ = command(
  async (
    { get, set },
    args: Scope & { readonly id: string; readonly name: string },
    signal: AbortSignal,
  ) => {
    const [last] = await get(db$)
      .select({ sortKey: folders.sortKey })
      .from(folders)
      .where(folderScope(args))
      .orderBy(desc(sql`${folders.sortKey} COLLATE "C"`), desc(folders.id))
      .limit(1);
    signal.throwIfAborted();
    const [created] = await set(writeDb$)
      .insert(folders)
      .select(
        new QueryBuilder()
          .select({
            id: sql`${args.id}::uuid`.mapWith(folders.id).as("id"),
            userId: sql`${args.userId}`.mapWith(folders.userId).as("user_id"),
            orgId: agents.orgId,
            agentId: agents.id,
            name: sql`${args.name}`.mapWith(folders.name).as("name"),
            sortKey: sql`${chatFolderKeyBetween(last?.sortKey ?? null, null)}`
              .mapWith(folders.sortKey)
              .as("sort_key"),
            createdAt: sql`now()`.mapWith(folders.createdAt).as("created_at"),
            updatedAt: sql`now()`.mapWith(folders.updatedAt).as("updated_at"),
          })
          .from(agents)
          .where(visibleAgentIdentityCondition(args)),
      )
      .onConflictDoNothing()
      .returning({
        id: folders.id,
        name: folders.name,
        sortKey: folders.sortKey,
      });
    signal.throwIfAborted();
    if (created) {
      return created;
    }
    // A lost response can be recovered using the original creation UUID.
    const [existing] = await get(db$)
      .select()
      .from(folders)
      .where(and(eq(folders.id, args.id), visibleFolderOwner(args)))
      .limit(1);
    signal.throwIfAborted();
    if (existing?.agentId === args.agentId && existing.name === args.name) {
      return {
        id: existing.id,
        name: existing.name,
        sortKey: existing.sortKey,
      };
    }
    const [agent] = await get(db$)
      .select({ id: agents.id })
      .from(agents)
      .where(visibleAgentIdentityCondition(args))
      .limit(1);
    signal.throwIfAborted();
    return agent ? null : ("missing" as const);
  },
);

export const renameChatFolder$ = command(
  async (
    { set },
    args: Owner & { readonly id: string; readonly name: string },
    signal: AbortSignal,
  ) => {
    const [row] = await set(writeDb$)
      .update(folders)
      .set({ name: args.name, updatedAt: nowDate() })
      .where(and(eq(folders.id, args.id), visibleFolderOwner(args)))
      .returning({ agentId: folders.agentId });
    signal.throwIfAborted();
    return row ?? null;
  },
);

export const deleteChatFolder$ = command(
  async (
    { set },
    args: Owner & { readonly id: string },
    signal: AbortSignal,
  ) => {
    const [row] = await set(writeDb$)
      .delete(folders)
      .where(and(eq(folders.id, args.id), visibleFolderOwner(args)))
      .returning({ agentId: folders.agentId });
    signal.throwIfAborted();
    return row ?? null;
  },
);

export const reorderChatFolder$ = command(
  async (
    { get, set },
    args: Owner & {
      readonly id: string;
      readonly beforeId: string | null;
      readonly afterId: string | null;
    },
    signal: AbortSignal,
  ) => {
    const [folder] = await get(db$)
      .select()
      .from(folders)
      .where(and(eq(folders.id, args.id), visibleFolderOwner(args)))
      .limit(1);
    signal.throwIfAborted();
    if (!folder) {
      return "missing" as const;
    }
    const scope = { ...args, agentId: folder.agentId };
    const neighbors = await get(db$)
      .select({ id: folders.id, sortKey: folders.sortKey })
      .from(folders)
      .where(folderScope(scope))
      .orderBy(asc(folders.id));
    signal.throwIfAborted();
    const before = neighbors.find((row) => {
      return row.id === args.beforeId;
    });
    const after = neighbors.find((row) => {
      return row.id === args.afterId;
    });
    if (
      (args.beforeId !== null && !before) ||
      (args.afterId !== null && !after) ||
      args.beforeId === args.id ||
      args.afterId === args.id ||
      (before && after && compareChatFolders(before, after) >= 0)
    ) {
      return "invalid" as const;
    }
    const ranks = moveChatFolderRanks(
      neighbors,
      args.id,
      args.beforeId,
      args.afterId,
    );
    const cases = ranks.map((rank) => {
      return sql`WHEN ${rank.id}::uuid THEN ${rank.sortKey}`;
    });
    const updated = await set(writeDb$)
      .update(folders)
      .set({
        sortKey: sql`CASE ${folders.id} ${sql.join(cases, sql` `)} ELSE ${folders.sortKey} END`,
        updatedAt: nowDate(),
      })
      .where(
        and(
          inArray(
            folders.id,
            ranks.map((rank) => {
              return rank.id;
            }),
          ),
          folderScope(scope),
        ),
      )
      .returning({ id: folders.id });
    signal.throwIfAborted();
    return updated.some((row) => {
      return row.id === args.id;
    })
      ? folder.agentId
      : ("missing" as const);
  },
);

export const moveThreadToChatFolder$ = command(
  async (
    { get, set },
    args: Owner & {
      readonly threadId: string;
      readonly folderId: string | null;
    },
    signal: AbortSignal,
  ) => {
    const [owned] = await get(db$)
      .select({ agentId: chatThreads.agentId })
      .from(chatThreads)
      .innerJoin(
        agents,
        and(
          eq(agents.id, chatThreads.agentId),
          eq(agents.orgId, args.orgId),
          visibleJoinedAgentCondition(args.userId),
        ),
      )
      .where(
        and(
          eq(chatThreads.id, args.threadId),
          eq(chatThreads.userId, args.userId),
        ),
      )
      .limit(1);
    signal.throwIfAborted();
    if (!owned?.agentId) {
      return null;
    }
    const scope = { ...args, agentId: owned.agentId };
    const database = set(writeDb$);
    const thread = new QueryBuilder()
      .select({ id: chatThreads.id })
      .from(chatThreads)
      .innerJoin(
        agents,
        and(
          eq(agents.id, chatThreads.agentId),
          eq(agents.orgId, args.orgId),
          visibleJoinedAgentCondition(args.userId),
        ),
      )
      .where(
        and(
          eq(chatThreads.id, args.threadId),
          eq(chatThreads.userId, args.userId),
          eq(chatThreads.agentId, scope.agentId),
        ),
      );
    if (args.folderId === null) {
      await database
        .delete(memberships)
        .where(
          and(eq(memberships.chatThreadId, args.threadId), exists(thread)),
        );
      signal.throwIfAborted();
      return scope.agentId;
    }
    const [written] = await database
      .insert(memberships)
      .select(
        new QueryBuilder()
          .select({ chatThreadId: chatThreads.id, folderId: folders.id })
          .from(chatThreads)
          .innerJoin(
            folders,
            and(
              eq(folders.id, args.folderId),
              eq(folders.agentId, chatThreads.agentId),
              folderScope(scope),
            ),
          )
          .where(
            and(
              eq(chatThreads.id, args.threadId),
              eq(chatThreads.userId, args.userId),
              exists(thread),
            ),
          ),
      )
      .onConflictDoUpdate({
        target: memberships.chatThreadId,
        set: { folderId: args.folderId },
      })
      .returning({ id: memberships.chatThreadId });
    signal.throwIfAborted();
    return written ? scope.agentId : null;
  },
);
