import {
  artifacts,
  imageArtifacts,
  videoArtifacts,
} from "@okouai/db/schema/artifact";
import { runUploadedFiles } from "@okouai/db/schema/run-uploaded-file";
import { and, asc, eq, inArray, or, sql } from "drizzle-orm";

import type { Tx } from "../../lib/db-types";

/**
 * Remove catalog projections before deleting locked Runs. File and generated
 * media rows cascade from the Run, but the catalog has no foreign key to those
 * polymorphic entities. The caller keeps this write and the Run delete in one
 * transaction. Repeating it is safe while the legacy delete triggers remain.
 */
export async function deleteArtifactCatalogForRunIds(
  tx: Tx,
  runIds: readonly string[],
): Promise<void> {
  if (runIds.length === 0) {
    return;
  }

  // The catalog projector takes a file row lock before its final upsert.
  // Holding the same locks through the Run cascade prevents a late projector
  // from recreating a catalog row after this delete.
  await tx
    .select({ id: runUploadedFiles.id })
    .from(runUploadedFiles)
    .where(sql`${runUploadedFiles.runId} = ANY(${sql.param(runIds)}::uuid[])`)
    .orderBy(asc(runUploadedFiles.id))
    .for("update");

  const fileIds = tx
    .select({ id: runUploadedFiles.id })
    .from(runUploadedFiles)
    .where(sql`${runUploadedFiles.runId} = ANY(${sql.param(runIds)}::uuid[])`);
  const imageIds = tx
    .select({ id: imageArtifacts.id })
    .from(imageArtifacts)
    .where(inArray(imageArtifacts.fileId, fileIds));
  const videoIds = tx
    .select({ id: videoArtifacts.id })
    .from(videoArtifacts)
    .where(inArray(videoArtifacts.fileId, fileIds));

  await tx
    .delete(artifacts)
    .where(
      or(
        and(eq(artifacts.kind, "file"), inArray(artifacts.entityId, fileIds)),
        and(eq(artifacts.kind, "image"), inArray(artifacts.entityId, imageIds)),
        and(eq(artifacts.kind, "video"), inArray(artifacts.entityId, videoIds)),
      ),
    );
}
