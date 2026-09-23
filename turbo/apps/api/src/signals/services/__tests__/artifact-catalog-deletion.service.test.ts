import { randomUUID } from "node:crypto";

import { agentRuns } from "@okouai/db/runtime/agent-run";
import { agentSessions } from "@okouai/db/schema/agent-session";
import {
  artifactCatalogPendingFiles,
  artifacts,
  imageArtifacts,
  presentationArtifacts,
  videoArtifacts,
} from "@okouai/db/schema/artifact";
import { hostedSites } from "@okouai/db/schema/hosted-site";
import { runUploadedFiles } from "@okouai/db/schema/run-uploaded-file";
import { eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { expect, onTestFinished, test } from "vitest";

import { testContext } from "../../../__tests__/test-context";
import { env } from "../../../lib/env";
import { nowDate } from "../../../lib/time";
import {
  deleteArtifactCatalogForHostedSiteId,
  deleteArtifactCatalogForRunIds,
} from "../artifact-catalog-deletion.service";
import { queueArtifactCatalogFile } from "../artifact-catalog.service";
import { deleteLockedRuns } from "../conversation-history-deletion.service";

const context = testContext();

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
    "hosted_sites",
    "presentation_artifacts",
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
  await db.execute(sql`ALTER TABLE presentation_artifacts
    ADD FOREIGN KEY (hosted_site_id) REFERENCES hosted_sites(id) ON DELETE CASCADE`);
  await db.execute(sql`ALTER TABLE image_artifacts
    ADD FOREIGN KEY (file_id) REFERENCES run_uploaded_files(id) ON DELETE CASCADE`);
  await db.execute(sql`ALTER TABLE video_artifacts
    ADD FOREIGN KEY (file_id) REFERENCES run_uploaded_files(id) ON DELETE CASCADE`);
  await db.execute(sql`ALTER TABLE artifact_catalog_pending_files
    ADD FOREIGN KEY (file_id) REFERENCES run_uploaded_files(id) ON DELETE CASCADE`);

  async function seed(
    suffix: string,
    options: { readonly catalog?: boolean; readonly url?: string | null } = {},
  ) {
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
        ...(options.catalog === false
          ? { triggerSource: "chat" as const, autonomyBudget: 0 }
          : {}),
        prompt: "catalog test",
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
        url:
          options.url === undefined
            ? `https://example.test/${suffix}.png`
            : options.url,
      })
      .returning({ id: runUploadedFiles.id });
    if (!file) {
      throw new Error("Expected a file");
    }
    if (options.catalog === false) {
      return { runId: run.id, fileId: file.id };
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

  async function seedHostedSite(suffix: string) {
    const [site] = await db
      .insert(hostedSites)
      .values({
        orgId: `org_catalog_${suffix}`,
        userId: `user_catalog_${suffix}`,
        slug: `catalog-${suffix}`,
        publicSlug: `catalog-${suffix}`,
        publicBrand: "vm0",
      })
      .returning({ id: hostedSites.id });
    if (!site) {
      throw new Error("Expected a hosted site");
    }
    const [presentation] = await db
      .insert(presentationArtifacts)
      .values({ hostedSiteId: site.id })
      .returning({ id: presentationArtifacts.id });
    if (!presentation) {
      throw new Error("Expected a presentation");
    }
    await db.insert(artifacts).values(
      [
        { kind: "hosted-site" as const, entityId: site.id },
        { kind: "presentation" as const, entityId: presentation.id },
      ].map((entry) => ({
        ...entry,
        orgId: `org_catalog_${suffix}`,
        authorUserId: `user_catalog_${suffix}`,
        logicalKey: `${entry.kind}:${suffix}`,
        projectionCreatedAt: nowDate(),
        title: suffix,
      })),
    );
    return { siteId: site.id, presentationId: presentation.id };
  }

  return { db, seed, seedHostedSite };
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

test("removes hosted-site and presentation catalog rows before source deletion without triggers", async () => {
  const { db, seedHostedSite } = await harness();
  const target = await seedHostedSite("site_target");
  const survivor = await seedHostedSite("site_survivor");

  await db.transaction(async (tx) => {
    await deleteArtifactCatalogForHostedSiteId(tx, target.siteId);
    await tx.delete(hostedSites).where(eq(hostedSites.id, target.siteId));
  });

  await expect(
    db.select().from(artifacts).where(eq(artifacts.entityId, target.siteId)),
  ).resolves.toHaveLength(0);
  await expect(
    db
      .select()
      .from(artifacts)
      .where(eq(artifacts.entityId, target.presentationId)),
  ).resolves.toHaveLength(0);
  await expect(
    db
      .select()
      .from(presentationArtifacts)
      .where(eq(presentationArtifacts.id, target.presentationId)),
  ).resolves.toHaveLength(0);
  await expect(
    db.select().from(artifacts).where(eq(artifacts.entityId, survivor.siteId)),
  ).resolves.toHaveLength(1);
  await expect(
    db
      .select()
      .from(artifacts)
      .where(eq(artifacts.entityId, survivor.presentationId)),
  ).resolves.toHaveLength(1);
});

test("rolls hosted-site catalog cleanup back with source deletion", async () => {
  const { db, seedHostedSite } = await harness();
  const target = await seedHostedSite("site_rollback");

  await expect(
    db.transaction(async (tx) => {
      await deleteArtifactCatalogForHostedSiteId(tx, target.siteId);
      await tx.delete(hostedSites).where(eq(hostedSites.id, target.siteId));
      throw new Error("rollback");
    }),
  ).rejects.toThrow("rollback");

  await expect(
    db.select().from(hostedSites).where(eq(hostedSites.id, target.siteId)),
  ).resolves.toHaveLength(1);
  await expect(
    db.select().from(artifacts).where(eq(artifacts.entityId, target.siteId)),
  ).resolves.toHaveLength(1);
  await expect(
    db
      .select()
      .from(artifacts)
      .where(eq(artifacts.entityId, target.presentationId)),
  ).resolves.toHaveLength(1);
});

test("keeps the catalog handoff in step with file changes without triggers", async () => {
  const { db, seed } = await harness();
  const target = await seed("handoff", { catalog: false, url: null });

  await db.transaction(async (tx) => {
    await tx
      .update(runUploadedFiles)
      .set({ url: "https://example.test/handoff.png" })
      .where(eq(runUploadedFiles.id, target.fileId));
    await queueArtifactCatalogFile(tx, target.fileId, context.signal);
    await queueArtifactCatalogFile(tx, target.fileId, context.signal);
  });
  await expect(
    db
      .select({
        orgId: artifactCatalogPendingFiles.orgId,
        authorUserId: artifactCatalogPendingFiles.authorUserId,
      })
      .from(artifactCatalogPendingFiles)
      .where(eq(artifactCatalogPendingFiles.fileId, target.fileId)),
  ).resolves.toStrictEqual([
    { orgId: "org_catalog_handoff", authorUserId: "user_catalog_handoff" },
  ]);

  const changedOrgId = "org_catalog_handoff_changed";
  const changedUserId = "user_catalog_handoff_changed";
  await db.transaction(async (tx) => {
    await tx
      .update(runUploadedFiles)
      .set({ orgId: changedOrgId, userId: changedUserId })
      .where(eq(runUploadedFiles.id, target.fileId));
    await queueArtifactCatalogFile(tx, target.fileId, context.signal);
  });
  await expect(
    db
      .select({
        orgId: artifactCatalogPendingFiles.orgId,
        authorUserId: artifactCatalogPendingFiles.authorUserId,
      })
      .from(artifactCatalogPendingFiles)
      .where(eq(artifactCatalogPendingFiles.fileId, target.fileId)),
  ).resolves.toStrictEqual([
    { orgId: changedOrgId, authorUserId: changedUserId },
  ]);

  await db.insert(artifacts).values({
    kind: "file",
    entityId: target.fileId,
    orgId: changedOrgId,
    authorUserId: changedUserId,
    logicalKey: `file:${target.fileId}`,
    projectionFileId: target.fileId,
    projectionCreatedAt: nowDate(),
    title: "handoff.png",
  });
  await db.transaction(async (tx) => {
    await tx
      .update(runUploadedFiles)
      .set({ url: null })
      .where(eq(runUploadedFiles.id, target.fileId));
    await queueArtifactCatalogFile(tx, target.fileId, context.signal);
  });

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
      .where(eq(artifacts.projectionFileId, target.fileId)),
  ).resolves.toHaveLength(0);
  await expect(
    db
      .select({ id: runUploadedFiles.id })
      .from(runUploadedFiles)
      .where(eq(runUploadedFiles.id, target.fileId)),
  ).resolves.toHaveLength(1);
});

test("rolls back file publication and catalog handoff together without triggers", async () => {
  const { db, seed } = await harness();
  const target = await seed("handoff_rollback", { catalog: false, url: null });

  await expect(
    db.transaction(async (tx) => {
      await tx
        .update(runUploadedFiles)
        .set({ url: "https://example.test/handoff_rollback.png" })
        .where(eq(runUploadedFiles.id, target.fileId));
      await queueArtifactCatalogFile(tx, target.fileId, context.signal);
      await expect(
        tx
          .select()
          .from(artifactCatalogPendingFiles)
          .where(eq(artifactCatalogPendingFiles.fileId, target.fileId)),
      ).resolves.toHaveLength(1);
      throw new Error("rollback");
    }),
  ).rejects.toThrow("rollback");

  await expect(
    db
      .select({ url: runUploadedFiles.url })
      .from(runUploadedFiles)
      .where(eq(runUploadedFiles.id, target.fileId)),
  ).resolves.toStrictEqual([{ url: null }]);
  await expect(
    db
      .select()
      .from(artifactCatalogPendingFiles)
      .where(eq(artifactCatalogPendingFiles.fileId, target.fileId)),
  ).resolves.toHaveLength(0);
});
