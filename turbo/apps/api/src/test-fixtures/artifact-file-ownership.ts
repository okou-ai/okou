import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { artifacts } from "@okouai/db/schema/artifact";
import { runUploadedFiles } from "@okouai/db/schema/run-uploaded-file";
import { db } from "../lib/db";
import { nowDate } from "../lib/time";

/** Historical fixture: current APIs never write provider-only orphan ownership. */
export async function seedProjectionOwnedHistoricalFiles(
  owner: { readonly userId: string; readonly orgId: string },
  count: number,
) {
  const fixtures = Array.from({ length: count }, () => {
    return { fileId: randomUUID(), artifactId: randomUUID() };
  });
  await db().transaction(async (tx) => {
    await tx.insert(runUploadedFiles).values(
      fixtures.map(({ fileId }) => {
        return {
          id: fileId,
          runId: randomUUID(),
          userId: `legacy-provider-${randomUUID()}`,
          orgId: null,
          source: "web",
          externalId: randomUUID(),
          filename: "retained-historical-report.txt",
          url: `https://files.okou.test/${fileId}/retained-historical-report.txt`,
        };
      }),
    );
    await tx.insert(artifacts).values(
      fixtures.map(({ fileId, artifactId }) => {
        return {
          id: artifactId,
          orgId: owner.orgId,
          authorUserId: owner.userId,
          kind: "file" as const,
          entityId: fileId,
          projectionFileId: fileId,
          projectionCreatedAt: nowDate(),
          logicalKey: `file:historical-${fileId}`,
          title: "retained-historical-report.txt",
        };
      }),
    );
  });
  return fixtures;
}

export async function seedProjectionOwnedHistoricalFile(owner: {
  readonly userId: string;
  readonly orgId: string;
}) {
  const [fixture] = await seedProjectionOwnedHistoricalFiles(owner, 1);
  if (!fixture) {
    throw new Error("Expected one historical file fixture");
  }
  return fixture;
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

/** Scoped infrastructure receipt for a historical multi-batch erasure. */
export async function retainedHistoricalFileIds(fileIds: readonly string[]) {
  const rows = await db()
    .select({ id: runUploadedFiles.id })
    .from(runUploadedFiles)
    .where(inArray(runUploadedFiles.id, fileIds));
  return rows.map((row) => {
    return row.id;
  });
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
