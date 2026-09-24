import type {
  RemoteAccessProtocol,
  RemoteHostDefault,
  ThreadRemoteHostAccess,
  InitialRemoteAccessOverride,
} from "@okouai/api-contracts/contracts/chat-remote-access";
import { agents } from "@okouai/db/schema/agent";
import { chatThreadSshAccessOverrides } from "@okouai/db/schema/chat-thread-ssh-access-override";
import { chatThreadVncAccessOverrides } from "@okouai/db/schema/chat-thread-vnc-access-override";
import { chatThreads } from "@okouai/db/schema/chat-thread";
import { sshConnections } from "@okouai/db/schema/ssh-connection";
import { vncConnections } from "@okouai/db/schema/vnc-connection";
import { and, asc, eq, inArray } from "drizzle-orm";

import type { Tx } from "../../lib/db-types";
import { logger } from "../../lib/log";
import { nowDate } from "../../lib/time";
import type { Db, ReadonlyDb } from "../external/db";
import { settle } from "../utils";
import { admitPiStableContextSubjects } from "./pi-stable-context-erasure.service";
import { publishSshClientInvalidation } from "./ssh-client-invalidation.service";
import { publishSshRunnerInvalidation } from "./ssh-runtime-wakeup.service";
import { enterVncWrite } from "./vnc-owner-lifecycle.service";

const L = logger("ChatRemoteAccess");

interface Owner {
  readonly orgId: string;
  readonly userId: string;
}

interface ThreadOwner extends Owner {
  readonly chatThreadId: string;
}

interface HostOwner extends Owner {
  readonly connectionId: string;
}

interface ThreadHostOwner extends ThreadOwner {
  readonly connectionId: string;
}

/** Validate every initial selection before inserting the chat thread. */
export async function ownsInitialRemoteAccessHosts(
  tx: Tx,
  owner: Owner,
  overrides: readonly InitialRemoteAccessOverride[],
): Promise<boolean> {
  const sshIds = overrides
    .filter((item) => {
      return item.protocol === "ssh";
    })
    .map((item) => {
      return item.connectionId;
    });
  const vncIds = overrides
    .filter((item) => {
      return item.protocol === "vnc";
    })
    .map((item) => {
      return item.connectionId;
    });
  const [ssh, vnc] = await Promise.all([
    sshIds.length
      ? tx
          .select({ id: sshConnections.id })
          .from(sshConnections)
          .where(
            and(
              inArray(sshConnections.id, sshIds),
              eq(sshConnections.orgId, owner.orgId),
              eq(sshConnections.userId, owner.userId),
            ),
          )
      : Promise.resolve([]),
    vncIds.length
      ? tx
          .select({ id: vncConnections.id })
          .from(vncConnections)
          .where(
            and(
              inArray(vncConnections.id, vncIds),
              eq(vncConnections.orgId, owner.orgId),
              eq(vncConnections.userId, owner.userId),
            ),
          )
      : Promise.resolve([]),
  ]);
  return ssh.length === sshIds.length && vnc.length === vncIds.length;
}

export async function insertInitialRemoteAccessOverrides(
  tx: Tx,
  chatThreadId: string,
  overrides: readonly InitialRemoteAccessOverride[],
): Promise<void> {
  const ssh = overrides.filter((item) => {
    return item.protocol === "ssh";
  });
  const vnc = overrides.filter((item) => {
    return item.protocol === "vnc";
  });
  if (ssh.length) {
    await tx.insert(chatThreadSshAccessOverrides).values(
      ssh.map((item) => {
        return {
          chatThreadId,
          connectionId: item.connectionId,
          enabled: item.enabled,
        };
      }),
    );
  }
  if (vnc.length) {
    await tx.insert(chatThreadVncAccessOverrides).values(
      vnc.map((item) => {
        return {
          chatThreadId,
          connectionId: item.connectionId,
          enabled: item.enabled,
        };
      }),
    );
  }
}

async function notifyRemoteAccessChange(
  db: Db,
  owner: HostOwner,
  protocol: RemoteAccessProtocol,
  chatThreadId?: string,
): Promise<void> {
  const [client, runner] = await Promise.all([
    settle(publishSshClientInvalidation(owner)),
    settle(
      publishSshRunnerInvalidation(db, {
        orgId: owner.orgId,
        userId: owner.userId,
        ...(chatThreadId === undefined ? {} : { chatThreadId }),
        connectionId: protocol === "ssh" ? owner.connectionId : null,
      }),
    ),
  ]);
  if (!client.ok || !runner.ok) {
    L.warn("Failed to invalidate remote access clients", {
      protocol,
      connectionId: owner.connectionId,
      chatThreadId,
      clientError: client.ok ? undefined : client.error,
      runnerError: runner.ok ? undefined : runner.error,
    });
  }
}

async function admitRemoteAccessWrite(
  tx: Tx,
  owner: Owner,
  protocol: RemoteAccessProtocol,
): Promise<boolean> {
  if (protocol === "vnc" && !(await enterVncWrite(tx, owner))) {
    return false;
  }
  return await admitPiStableContextSubjects(tx, [
    { subjectKind: "organization", subjectId: owner.orgId },
    { subjectKind: "user", subjectId: owner.userId },
  ]);
}

function toHostDefault(row: {
  id: string;
  displayName: string;
  defaultEnabledForChats: boolean;
}): RemoteHostDefault {
  return {
    connectionId: row.id,
    displayName: row.displayName,
    defaultEnabled: row.defaultEnabledForChats,
  };
}

function toThreadAccess(
  row: {
    id: string;
    displayName: string;
    defaultEnabledForChats: boolean;
  },
  overrideEnabled: boolean | null,
): ThreadRemoteHostAccess {
  return {
    ...toHostDefault(row),
    overrideEnabled,
    enabled: overrideEnabled ?? row.defaultEnabledForChats,
    source: overrideEnabled === null ? "default" : "override",
  };
}

async function ownedThreadExists(
  db: ReadonlyDb | Tx,
  owner: ThreadOwner,
): Promise<boolean> {
  const [thread] = await db
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
    )
    .limit(1);
  return thread !== undefined;
}

export async function listRemoteHostDefaults(
  db: ReadonlyDb,
  owner: Owner,
  includeVnc: boolean,
): Promise<{ ssh: RemoteHostDefault[]; vnc: RemoteHostDefault[] }> {
  const [ssh, vnc] = await Promise.all([
    db
      .select({
        id: sshConnections.id,
        displayName: sshConnections.displayName,
        defaultEnabledForChats: sshConnections.defaultEnabledForChats,
      })
      .from(sshConnections)
      .where(
        and(
          eq(sshConnections.orgId, owner.orgId),
          eq(sshConnections.userId, owner.userId),
        ),
      )
      .orderBy(asc(sshConnections.createdAt), asc(sshConnections.id)),
    includeVnc
      ? db
          .select({
            id: vncConnections.id,
            displayName: vncConnections.displayName,
            defaultEnabledForChats: vncConnections.defaultEnabledForChats,
          })
          .from(vncConnections)
          .where(
            and(
              eq(vncConnections.orgId, owner.orgId),
              eq(vncConnections.userId, owner.userId),
            ),
          )
          .orderBy(asc(vncConnections.createdAt), asc(vncConnections.id))
      : Promise.resolve([]),
  ]);
  return { ssh: ssh.map(toHostDefault), vnc: vnc.map(toHostDefault) };
}

export async function updateRemoteHostDefault(
  db: Db,
  owner: HostOwner,
  protocol: RemoteAccessProtocol,
  enabled: boolean,
): Promise<RemoteHostDefault | null> {
  const result = await db.transaction(async (tx) => {
    if (!(await admitRemoteAccessWrite(tx, owner, protocol))) {
      return null;
    }
    if (protocol === "ssh") {
      const [row] = await tx
        .update(sshConnections)
        .set({ defaultEnabledForChats: enabled, updatedAt: nowDate() })
        .where(
          and(
            eq(sshConnections.id, owner.connectionId),
            eq(sshConnections.orgId, owner.orgId),
            eq(sshConnections.userId, owner.userId),
          ),
        )
        .returning({
          id: sshConnections.id,
          displayName: sshConnections.displayName,
          defaultEnabledForChats: sshConnections.defaultEnabledForChats,
        });
      return row ? toHostDefault(row) : null;
    }
    const [row] = await tx
      .update(vncConnections)
      .set({ defaultEnabledForChats: enabled, updatedAt: nowDate() })
      .where(
        and(
          eq(vncConnections.id, owner.connectionId),
          eq(vncConnections.orgId, owner.orgId),
          eq(vncConnections.userId, owner.userId),
        ),
      )
      .returning({
        id: vncConnections.id,
        displayName: vncConnections.displayName,
        defaultEnabledForChats: vncConnections.defaultEnabledForChats,
      });
    return row ? toHostDefault(row) : null;
  });
  if (result) {
    await notifyRemoteAccessChange(db, owner, protocol);
  }
  return result;
}

export async function listThreadRemoteAccess(
  db: ReadonlyDb,
  owner: ThreadOwner,
  includeVnc: boolean,
): Promise<{
  ssh: ThreadRemoteHostAccess[];
  vnc: ThreadRemoteHostAccess[];
} | null> {
  if (!(await ownedThreadExists(db, owner))) {
    return null;
  }
  const [ssh, vnc] = await Promise.all([
    db
      .select({
        id: sshConnections.id,
        displayName: sshConnections.displayName,
        defaultEnabledForChats: sshConnections.defaultEnabledForChats,
        overrideEnabled: chatThreadSshAccessOverrides.enabled,
      })
      .from(sshConnections)
      .leftJoin(
        chatThreadSshAccessOverrides,
        and(
          eq(chatThreadSshAccessOverrides.connectionId, sshConnections.id),
          eq(chatThreadSshAccessOverrides.chatThreadId, owner.chatThreadId),
        ),
      )
      .where(
        and(
          eq(sshConnections.orgId, owner.orgId),
          eq(sshConnections.userId, owner.userId),
        ),
      )
      .orderBy(asc(sshConnections.createdAt), asc(sshConnections.id)),
    includeVnc
      ? db
          .select({
            id: vncConnections.id,
            displayName: vncConnections.displayName,
            defaultEnabledForChats: vncConnections.defaultEnabledForChats,
            overrideEnabled: chatThreadVncAccessOverrides.enabled,
          })
          .from(vncConnections)
          .leftJoin(
            chatThreadVncAccessOverrides,
            and(
              eq(chatThreadVncAccessOverrides.connectionId, vncConnections.id),
              eq(chatThreadVncAccessOverrides.chatThreadId, owner.chatThreadId),
            ),
          )
          .where(
            and(
              eq(vncConnections.orgId, owner.orgId),
              eq(vncConnections.userId, owner.userId),
            ),
          )
          .orderBy(asc(vncConnections.createdAt), asc(vncConnections.id))
      : Promise.resolve([]),
  ]);
  return {
    ssh: ssh.map((row) => {
      return toThreadAccess(row, row.overrideEnabled);
    }),
    vnc: vnc.map((row) => {
      return toThreadAccess(row, row.overrideEnabled);
    }),
  };
}

/** Explicit choices are retained even when they equal today's host default. */
export async function setThreadRemoteAccessOverride(
  db: Db,
  owner: ThreadHostOwner,
  protocol: RemoteAccessProtocol,
  enabled: boolean,
): Promise<ThreadRemoteHostAccess | null> {
  const result = await db.transaction(async (tx) => {
    if (!(await admitRemoteAccessWrite(tx, owner, protocol))) {
      return null;
    }
    if (!(await ownedThreadExists(tx, owner))) {
      return null;
    }
    if (protocol === "ssh") {
      const [host] = await tx
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
          ),
        )
        .limit(1);
      if (!host) {
        return null;
      }
      await tx
        .insert(chatThreadSshAccessOverrides)
        .values({
          chatThreadId: owner.chatThreadId,
          connectionId: owner.connectionId,
          enabled,
        })
        .onConflictDoUpdate({
          target: [
            chatThreadSshAccessOverrides.chatThreadId,
            chatThreadSshAccessOverrides.connectionId,
          ],
          set: { enabled },
        });
      return toThreadAccess(host, enabled);
    }
    const [host] = await tx
      .select({
        id: vncConnections.id,
        displayName: vncConnections.displayName,
        defaultEnabledForChats: vncConnections.defaultEnabledForChats,
      })
      .from(vncConnections)
      .where(
        and(
          eq(vncConnections.id, owner.connectionId),
          eq(vncConnections.orgId, owner.orgId),
          eq(vncConnections.userId, owner.userId),
        ),
      )
      .limit(1);
    if (!host) {
      return null;
    }
    await tx
      .insert(chatThreadVncAccessOverrides)
      .values({
        chatThreadId: owner.chatThreadId,
        connectionId: owner.connectionId,
        enabled,
      })
      .onConflictDoUpdate({
        target: [
          chatThreadVncAccessOverrides.chatThreadId,
          chatThreadVncAccessOverrides.connectionId,
        ],
        set: { enabled },
      });
    return toThreadAccess(host, enabled);
  });
  if (result) {
    await notifyRemoteAccessChange(db, owner, protocol, owner.chatThreadId);
  }
  return result;
}

export async function clearThreadRemoteAccessOverride(
  db: Db,
  owner: ThreadHostOwner,
  protocol: RemoteAccessProtocol,
): Promise<ThreadRemoteHostAccess | null> {
  const result = await db.transaction(async (tx) => {
    if (!(await admitRemoteAccessWrite(tx, owner, protocol))) {
      return null;
    }
    if (!(await ownedThreadExists(tx, owner))) {
      return null;
    }
    if (protocol === "ssh") {
      const [host] = await tx
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
          ),
        )
        .limit(1);
      if (!host) {
        return null;
      }
      await tx
        .delete(chatThreadSshAccessOverrides)
        .where(
          and(
            eq(chatThreadSshAccessOverrides.chatThreadId, owner.chatThreadId),
            eq(chatThreadSshAccessOverrides.connectionId, owner.connectionId),
          ),
        );
      return toThreadAccess(host, null);
    }
    const [host] = await tx
      .select({
        id: vncConnections.id,
        displayName: vncConnections.displayName,
        defaultEnabledForChats: vncConnections.defaultEnabledForChats,
      })
      .from(vncConnections)
      .where(
        and(
          eq(vncConnections.id, owner.connectionId),
          eq(vncConnections.orgId, owner.orgId),
          eq(vncConnections.userId, owner.userId),
        ),
      )
      .limit(1);
    if (!host) {
      return null;
    }
    await tx
      .delete(chatThreadVncAccessOverrides)
      .where(
        and(
          eq(chatThreadVncAccessOverrides.chatThreadId, owner.chatThreadId),
          eq(chatThreadVncAccessOverrides.connectionId, owner.connectionId),
        ),
      );
    return toThreadAccess(host, null);
  });
  if (result) {
    await notifyRemoteAccessChange(db, owner, protocol, owner.chatThreadId);
  }
  return result;
}
