import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Client } from "pg";
import { schema } from "../src/index";
import { chatThreads } from "../src/runtime/chat-thread";
import { projects } from "../src/schema/project";
import {
  projectEvents,
  projectEventSequences,
} from "../src/schema/project-event";
import { projectSnapshots } from "../src/schema/project-snapshot";

/** Storage ownership/deletion guarantees on replayed and freshly generated schemas. */
export async function validatePermanentProjectStorage(databaseUrl: string) {
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  const db = drizzle(client, { schema });
  const projectId = randomUUID();
  const otherProjectId = randomUUID();
  const threadId = randomUUID();
  const owner = `project-owner-${projectId}`;
  const orgId = `project-org-${projectId}`;
  const otherOrgId = `${orgId}-other`;
  try {
    await db.insert(projects).values([
      { id: projectId, userId: owner, orgId, name: "Launch" },
      { id: otherProjectId, userId: `${owner}-other`, orgId, name: "Launch" },
    ]);
    const [thread] = await db
      .insert(chatThreads)
      .values({ id: threadId, userId: owner, projectId, title: "Planning" })
      .returning();
    assert.equal(thread?.projectId, projectId);
    await assert.rejects(
      client.query("UPDATE chat_threads SET project_id = $1 WHERE id = $2", [
        otherProjectId,
        threadId,
      ]),
      { code: "23503" },
    );
    await assert.rejects(
      client.query("DELETE FROM projects WHERE id = $1", [projectId]),
      { code: "23503" },
    );
    await db
      .update(chatThreads)
      .set({ projectId: null })
      .where(eq(chatThreads.id, threadId));
    await db.delete(projects).where(eq(projects.id, projectId));
    const preserved = await db.query.chatThreads.findFirst({
      where: eq(chatThreads.id, threadId),
    });
    assert.equal(preserved?.projectId, null);
    assert.equal(preserved?.title, "Planning");
    assert.equal(preserved?.createdAt.getTime(), thread?.createdAt.getTime());

    // The tombstone is durable after its Project identity is gone.
    const [tombstone] = await db
      .insert(projectEvents)
      .values({
        userId: owner,
        orgId,
        seqId: 1,
        projectId,
        kind: "deleted",
        name: "Launch",
      })
      .returning();
    assert.equal(tombstone?.projectId, projectId);
    await db.insert(projectEventSequences).values([
      { userId: owner, orgId, lastSeqId: 1 },
      { userId: owner, orgId: otherOrgId, lastSeqId: 2 },
    ]);
    const sequences = await db
      .select()
      .from(projectEventSequences)
      .where(eq(projectEventSequences.userId, owner));
    assert.deepEqual(
      sequences
        .map((row) => {
          return row.lastSeqId;
        })
        .sort(),
      [1, 2],
    );
    const [snapshot] = await db
      .insert(projectSnapshots)
      .values({
        userId: owner,
        orgId,
        latestEventId: tombstone?.id,
        latestEventSeqId: 1,
        objectKey: `project-snapshots/v1/${projectId}.json.gz`,
        contentDigest: "test-digest",
      })
      .returning();
    assert.equal(snapshot?.latestEventSeqId, 1);
  } finally {
    try {
      await db.delete(chatThreads).where(eq(chatThreads.id, threadId));
      await db.delete(projectEvents).where(eq(projectEvents.userId, owner));
      await db
        .delete(projectSnapshots)
        .where(eq(projectSnapshots.userId, owner));
      await db
        .delete(projectEventSequences)
        .where(eq(projectEventSequences.userId, owner));
      await db
        .delete(projects)
        .where(inArray(projects.id, [projectId, otherProjectId]));
    } finally {
      await client.end();
    }
  }
}
