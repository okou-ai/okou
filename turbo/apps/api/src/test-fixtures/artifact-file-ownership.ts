import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { artifacts } from "@okouai/db/schema/artifact";
import { runUploadedFiles } from "@okouai/db/schema/run-uploaded-file";
import { db } from "../lib/db";
import { nowDate } from "../lib/time";

/** Historical fixture: current APIs never write provider-only orphan ownership. */
export async function seedProjectionOwnedHistoricalFile(owner: {
  readonly userId: string;
  readonly orgId: string;
}) {
  const fileId = randomUUID();
  const artifactId = randomUUID();
  await db().transaction(async (tx) => {
    await tx.insert(runUploadedFiles).values({
      id: fileId,
      runId: randomUUID(),
      userId: `legacy-provider-${randomUUID()}`,
      orgId: null,
      source: "web",
      externalId: randomUUID(),
      filename: "retained-historical-report.txt",
      url: `https://files.okou.test/${fileId}/retained-historical-report.txt`,
    });
    await tx.insert(artifacts).values({
      id: artifactId,
      orgId: owner.orgId,
      authorUserId: owner.userId,
      kind: "file",
      entityId: fileId,
      projectionFileId: fileId,
      projectionCreatedAt: nowDate(),
      logicalKey: `file:historical-${fileId}`,
      title: "retained-historical-report.txt",
    });
  });
  return { fileId, artifactId };
}

/** Infrastructure erasure receipt: no endpoint exposes an orphan with no owner. */
export async function retainedHistoricalFileExists(fileId: string) {
  const [file] = await db()
    .select({ id: runUploadedFiles.id })
    .from(runUploadedFiles)
    .where(eq(runUploadedFiles.id, fileId))
    .limit(1);
  return file !== undefined;
}

/** Release only these fixture-created UUIDs, never a global cleanup sweep. */
export async function deleteProjectionOwnedHistoricalFiles(
  fixtures: readonly { readonly fileId: string; readonly artifactId: string }[],
) {
  await db().transaction(async (tx) => {
    await tx.delete(artifacts).where(
      inArray(
        artifacts.id,
        fixtures.map((fixture) => {
          return fixture.artifactId;
        }),
      ),
    );
    await tx.delete(runUploadedFiles).where(
      inArray(
        runUploadedFiles.id,
        fixtures.map((fixture) => {
          return fixture.fileId;
        }),
      ),
    );
  });
}
