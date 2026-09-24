import {
  getCustomSkillStorageName,
  VOLUME_ORG_USER_ID,
} from "@okouai/core/storage-names";
import { agents } from "@okouai/db/schema/agent";
import { chatThreads } from "@okouai/db/runtime/chat-thread";
import { storages, storageVersions } from "@okouai/db/schema/storage";
import {
  workflows,
  workflowUserAutomationThreads,
} from "@okouai/db/schema/workflow";
import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";

import { db } from "../lib/db";
import { executeRawRows } from "../lib/db-raw-rows";
import { createDeferredPromise } from "../signals/utils";

// Product APIs cannot expose unpublished identities, transaction IDs or pause a
// database statement. These fixtures inspect only the test-owned attempt; all
// creation, access changes and observable outcomes still use production APIs.
export async function readWorkflowPreparationFixture(
  orgId: string,
  objectKey: string,
) {
  const s3Prefix = objectKey.split("/").slice(0, -2).join("/");
  const [storage] = await db()
    .select({ id: storages.id, name: storages.name })
    .from(storages)
    .where(
      and(
        eq(storages.orgId, orgId),
        eq(storages.userId, VOLUME_ORG_USER_ID),
        eq(storages.s3Prefix, s3Prefix),
      ),
    );
  if (!storage?.name.startsWith(getCustomSkillStorageName(""))) {
    throw new Error("Expected a prepared Workflow storage identity");
  }
  return {
    storageId: storage.id,
    workflowId: storage.name.slice(getCustomSkillStorageName("").length),
  };
}

export async function readWorkflowPublicationFixture(
  orgId: string,
  workflowId: string,
) {
  const database = db();
  const workflow = await database
    .select({
      id: workflows.id,
      transaction: sql`${workflows}.xmin::text`.mapWith(workflows.name),
    })
    .from(workflows)
    .where(and(eq(workflows.orgId, orgId), eq(workflows.id, workflowId)));
  const mappings = await database
    .select({
      chatThreadId: workflowUserAutomationThreads.chatThreadId,
      transaction: sql`${workflowUserAutomationThreads}.xmin::text`.mapWith(
        workflowUserAutomationThreads.userId,
      ),
    })
    .from(workflowUserAutomationThreads)
    .where(
      and(
        eq(workflowUserAutomationThreads.orgId, orgId),
        eq(workflowUserAutomationThreads.workflowId, workflowId),
      ),
    );
  const storage = await database
    .select({
      id: storages.id,
      headVersionId: storages.headVersionId,
      transaction: sql`${storages}.xmin::text`.mapWith(storages.name),
    })
    .from(storages)
    .where(
      and(
        eq(storages.orgId, orgId),
        eq(storages.userId, VOLUME_ORG_USER_ID),
        eq(storages.name, getCustomSkillStorageName(workflowId)),
      ),
    );
  const versions = await database
    .select({
      id: storageVersions.id,
      transaction: sql`${storageVersions}.xmin::text`.mapWith(
        storageVersions.id,
      ),
    })
    .from(storageVersions)
    .innerJoin(storages, eq(storages.id, storageVersions.storageId))
    .where(
      and(
        eq(storages.orgId, orgId),
        eq(storages.userId, VOLUME_ORG_USER_ID),
        eq(storages.name, getCustomSkillStorageName(workflowId)),
      ),
    );
  return { workflow, mappings, storage, versions };
}

export async function assertWorkflowPreparationUnlockedFixture(
  agentId: string,
  storageId: string,
): Promise<void> {
  await db().transaction(async (tx) => {
    await tx
      .select({ id: agents.id })
      .from(agents)
      .where(eq(agents.id, agentId))
      .for("update", { noWait: true });
    await tx
      .select({ id: storages.id })
      .from(storages)
      .where(eq(storages.id, storageId))
      .for("update", { noWait: true });
  });
}

const pidSchema = z.object({ pid: z.int() });

export async function holdWorkflowCreationThreadFixture(
  threadId: string,
  signal: AbortSignal,
) {
  const started = createDeferredPromise<number>(signal);
  const released = createDeferredPromise<void>(signal);
  const done = db().transaction(async (tx) => {
    await tx
      .select({ id: chatThreads.id })
      .from(chatThreads)
      .where(eq(chatThreads.id, threadId))
      .for("update");
    const [row] = await executeRawRows(
      tx,
      sql`SELECT pg_backend_pid() AS pid`,
      pidSchema,
    );
    if (!row) {
      throw new Error("Expected the creation-thread lock backend");
    }
    started.resolve(row.pid);
    await released.promise;
  });
  const holderPid = await started.promise;
  return {
    done,
    release: () => {
      if (!released.settled()) {
        released.resolve();
      }
    },
    blockedPids: async () => {
      const rows = await executeRawRows(
        db(),
        sql`SELECT pid FROM pg_stat_activity WHERE ${holderPid} = ANY(pg_blocking_pids(pid))`,
        pidSchema,
      );
      return rows.map((row) => {
        return row.pid;
      });
    },
    cancelBlockedPublication: async (pid: number) => {
      // Limit cancellation to a backend still blocked by this exact fixture.
      await db().execute(
        sql`SELECT pg_cancel_backend(pid) FROM pg_stat_activity WHERE pid = ${pid} AND ${holderPid} = ANY(pg_blocking_pids(pid))`,
      );
    },
  };
}
