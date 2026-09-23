import { randomUUID } from "node:crypto";

import { agentRuns } from "@okouai/db/runtime/agent-run";
import { agentSessions } from "@okouai/db/schema/agent-session";
import {
  artifactCatalogPendingFiles,
  artifacts,
  imageArtifacts,
  videoArtifacts,
} from "@okouai/db/schema/artifact";
import { runUploadedFiles } from "@okouai/db/schema/run-uploaded-file";
import { eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { expect, onTestFinished, test } from "vitest";

import { testContext } from "../../../__tests__/test-context";
import { env } from "../../../lib/env";
import { nowDate } from "../../../lib/time";
import { deleteArtifactCatalogForRunIds } from "../artifact-catalog-deletion.service";
import { deleteLockedRuns } from "../conversation-history-deletion.service";

testContext();

// An isolated schema carries the real FK cascades but none of the legacy
// catalog triggers. The public schema and concurrent suites are untouched.
async function harness() {
  const schema = `catalog_run_delete_${randomUUID().replaceAll("-", "")}`;
  const adminPool = new Pool({ connectionString: env("DATABASE_URL"), max: 1 });
  const admin = drizzle(adminPool);
  const pool = new Pool({
    connectionString: env("DATABASE_URL"),
    max: 2,
    options: `-c search_path=${schema},public -c statement_timeout=10000`,
  });
  const db = drizzle(pool);
  onTestFinished(async () => {
    await pool.end();
    await admin.execute(sql`DROP SCHEMA ${sql.identifier(schema)} CASCADE`);
    await adminPool.end();
  });

  await admin.execute(sql`CREATE SCHEMA ${sql.identifier(schema)}`);
  for (const table of [
    "agent_sessions",
    "agent_runs",
    "run_uploaded_files",
    "image_artifacts",
    "video_artifacts",
    "artifacts",
    "artifact_catalog_pending_files",
  ]) {
    await db.execute(
      sql`CREATE TABLE ${sql.identifier(table)} (LIKE public.${sql.identifier(table)} INCLUDING ALL)`,
    );
  }
  await db.execute(sql`ALTER TABLE agent_runs
    ADD FOREIGN KEY (session_id) REFERENCES agent_sessions(id) ON DELETE CASCADE`);
  await db.execute(sql`ALTER TABLE run_uploaded_files
    ADD FOREIGN KEY (run_id) REFERENCES agent_runs(id) ON DELETE CASCADE`);
  await db.execute(sql`ALTER TABLE image_artifacts
    ADD FOREIGN KEY (file_id) REFERENCES run_uploaded_files(id) ON DELETE CASCADE`);
  await db.execute(sql`ALTER TABLE video_artifacts
    ADD FOREIGN KEY (file_id) REFERENCES run_uploaded_files(id) ON DELETE CASCADE`);
  await db.execute(sql`ALTER TABLE artifact_catalog_pending_files
    ADD FOREIGN KEY (file_id) REFERENCES run_uploaded_files(id) ON DELETE CASCADE`);

  async function seed(suffix: string) {
    const userId = `user_catalog_${suffix}`;
    const orgId = `org_catalog_${suffix}`;
    const [session] = await db
      .insert(agentSessions)
      .values({ userId, orgId })
      .returning({ id: agentSessions.id });
    if (!session) {
      throw new Error("Expected a session");
    }
    const [run] = await db
      .insert(agentRuns)
      .values({
        userId,
        orgId,
        sessionId: session.id,
        status: "completed",
        prompt: "catalog deletion test",
      })
      .returning({ id: agentRuns.id });
    if (!run) {
      throw new Error("Expected a run");
    }
    const [file] = await db
      .insert(runUploadedFiles)
      .values({
        runId: run.id,
        source: "agent",
        externalId: suffix,
        userId,
        orgId,
        filename: `${suffix}.png`,
        url: `https://example.test/${suffix}.png`,
      })
      .returning({ id: runUploadedFiles.id });
    if (!file) {
      throw new Error("Expected a file");
    }
    const [image] = await db
      .insert(imageArtifacts)
      .values({ fileId: file.id })
      .returning({ id: imageArtifacts.id });
    const [video] = await db
      .insert(videoArtifacts)
      .values({ fileId: file.id })
      .returning({ id: videoArtifacts.id });
    if (!image || !video) {
      throw new Error("Expected generated media entities");
    }
    await db.insert(artifacts).values(
      [
        { kind: "file" as const, entityId: file.id },
        { kind: "image" as const, entityId: image.id },
        { kind: "video" as const, entityId: video.id },
      ].map((entry) => {
        return {
          ...entry,
          orgId,
          authorUserId: userId,
          logicalKey: `${entry.kind}:${suffix}`,
          projectionFileId: file.id,
          projectionCreatedAt: nowDate(),
          title: suffix,
        };
      }),
    );
    await db.insert(artifactCatalogPendingFiles).values({
      fileId: file.id,
      orgId,
      authorUserId: userId,
    });
    return { runId: run.id, fileId: file.id };
  }

  return { db, seed };
}

test("removes file and generated media catalog rows before a Run cascade without triggers", async () => {
  const { db, seed } = await harness();
  const target = await seed("target");
  const survivor = await seed("survivor");

  await db.transaction(async (tx) => {
    await deleteLockedRuns(tx, [target.runId]);
    await expect(
      tx
        .select({ id: artifacts.id })
        .from(artifacts)
        .where(eq(artifacts.projectionFileId, target.fileId)),
    ).resolves.toHaveLength(0);
  });

  await expect(
    db
      .select()
      .from(runUploadedFiles)
      .where(eq(runUploadedFiles.id, target.fileId)),
  ).resolves.toHaveLength(0);
  await expect(
    db
      .select()
      .from(artifactCatalogPendingFiles)
      .where(eq(artifactCatalogPendingFiles.fileId, target.fileId)),
  ).resolves.toHaveLength(0);
  await expect(
    db
      .select()
      .from(artifacts)
      .where(eq(artifacts.projectionFileId, survivor.fileId)),
  ).resolves.toHaveLength(3);
});

test("rolls catalog removal back when the Run deletion transaction fails", async () => {
  const { db, seed } = await harness();
  const target = await seed("rollback");

  await expect(
    db.transaction(async (tx) => {
      await deleteLockedRuns(tx, [target.runId]);
      await expect(
        tx
          .select({ id: artifacts.id })
          .from(artifacts)
          .where(eq(artifacts.projectionFileId, target.fileId)),
      ).resolves.toHaveLength(0);
      throw new Error("rollback");
    }),
  ).rejects.toThrow("rollback");

  await expect(
    db.select().from(agentRuns).where(eq(agentRuns.id, target.runId)),
  ).resolves.toHaveLength(1);
  await expect(
    db
      .select()
      .from(runUploadedFiles)
      .where(eq(runUploadedFiles.id, target.fileId)),
  ).resolves.toHaveLength(1);
  await expect(
    db
      .select()
      .from(artifacts)
      .where(eq(artifacts.projectionFileId, target.fileId)),
  ).resolves.toHaveLength(3);
});

test("can repeat catalog cleanup while the locked Run and file still exist", async () => {
  const { db, seed } = await harness();
  const target = await seed("repeat");

  await db.transaction(async (tx) => {
    await deleteArtifactCatalogForRunIds(tx, [target.runId]);
    await deleteArtifactCatalogForRunIds(tx, [target.runId]);
    await expect(
      tx
        .select({ id: runUploadedFiles.id })
        .from(runUploadedFiles)
        .where(eq(runUploadedFiles.id, target.fileId)),
    ).resolves.toHaveLength(1);
    await expect(
      tx
        .select({ id: artifacts.id })
        .from(artifacts)
        .where(eq(artifacts.projectionFileId, target.fileId)),
    ).resolves.toHaveLength(0);
  });
});
