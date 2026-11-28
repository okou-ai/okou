import { randomUUID } from "node:crypto";
import type postgres from "postgres";
import { describe, expect, it } from "vitest";
import {
  createPgRepository,
  DEFAULT_CONCURRENCY,
  parseCliArgs,
  runR2ArtifactVisibilityBackfill,
  type ArtifactVisibilityMatch,
  type ArtifactVisibilityRepository,
  type BackfillVisibility,
  type R2PolicyObjectStore,
} from "./backfill";

function buildFilePolicy(params: {
  fileId: string;
  audience: BackfillVisibility;
  segment?: "okou" | "vm0";
}): string {
  const shareId = randomUUID();
  const status = params.audience === "private" ? "revoked" : "active";
  return JSON.stringify({
    version: 1,
    revision: randomUUID(),
    shareId,
    ownerId: "user_owner",
    orgId: "org_1",
    publicBrand: params.segment ?? "okou",
    audience: params.audience,
    status,
    publicToken: params.audience === "public" ? "abcdefghij" : null,
    target: {
      kind: "file",
      id: params.fileId,
      key: `private-artifacts/${params.fileId}/report.pdf`,
      filename: "report.pdf",
      contentType: "application/pdf",
    },
  });
}

function buildHtmlPolicy(params: {
  siteId: string;
  deploymentId: string;
}): string {
  const shareId = randomUUID();
  return JSON.stringify({
    version: 1,
    revision: randomUUID(),
    shareId,
    ownerId: "user_owner",
    orgId: "org_1",
    publicBrand: "okou",
    audience: "public",
    status: "active",
    publicToken: "abcdefghij",
    target: {
      kind: "html",
      id: params.deploymentId,
      siteId: params.siteId,
      snapshotId: randomUUID(),
      deploymentVersion: 1,
      manifest: {
        version: 1,
        access: "owner-private-v1",
        publicBrand: "okou",
        deploymentId: params.deploymentId,
        siteId: params.siteId,
        publicSlug: "legacy-site",
        createdAt: "2026-01-01T00:00:00.000Z",
        spaFallback: false,
        files: {},
      },
    },
  });
}

function createFakeStore(
  objects: Readonly<Record<string, string>>,
): R2PolicyObjectStore {
  return {
    async *listKeys(prefix: string) {
      for (const key of Object.keys(objects).sort()) {
        if (key.startsWith(prefix)) {
          yield key;
        }
      }
    },
    getJsonText(key: string) {
      return Promise.resolve(objects[key] ?? null);
    },
  };
}

function createFakeRepo(
  initial: ReadonlyArray<{
    fileId: string;
    artifactId: string;
    visibility: BackfillVisibility;
  }>,
): {
  repo: ArtifactVisibilityRepository;
  state: Map<string, BackfillVisibility>;
  batchCalls: string[][];
  updateCalls: Array<{
    artifactId: string;
    previousVisibility: BackfillVisibility;
    nextVisibility: Exclude<BackfillVisibility, "private">;
  }>;
} {
  const byFile = new Map<string, string[]>();
  const state = new Map<string, BackfillVisibility>();
  const batchCalls: string[][] = [];
  const updateCalls: Array<{
    artifactId: string;
    previousVisibility: BackfillVisibility;
    nextVisibility: Exclude<BackfillVisibility, "private">;
  }> = [];

  for (const row of initial) {
    state.set(row.artifactId, row.visibility);
    const list = byFile.get(row.fileId) ?? [];
    list.push(row.artifactId);
    byFile.set(row.fileId, list);
  }

  return {
    state,
    batchCalls,
    updateCalls,
    repo: {
      findActiveFileArtifactsBatch(
        fileIds: readonly string[],
      ): Promise<ReadonlyMap<string, readonly ArtifactVisibilityMatch[]>> {
        batchCalls.push([...fileIds]);
        const result = new Map<string, readonly ArtifactVisibilityMatch[]>();
        for (const fileId of fileIds) {
          const ids = byFile.get(fileId) ?? [];
          if (ids.length > 0) {
            result.set(
              fileId,
              ids.map((artifactId) => {
                return {
                  artifactId,
                  visibility: state.get(artifactId) ?? "private",
                };
              }),
            );
          }
        }
        return Promise.resolve(result);
      },
      updateVisibilityIfUnchanged(
        artifactId: string,
        previousVisibility: BackfillVisibility,
        nextVisibility: Exclude<BackfillVisibility, "private">,
      ): Promise<boolean> {
        updateCalls.push({ artifactId, previousVisibility, nextVisibility });
        if (state.get(artifactId) !== previousVisibility) {
          return Promise.resolve(false);
        }
        state.set(artifactId, nextVisibility);
        return Promise.resolve(true);
      },
    },
  };
}

describe("001-r2-artifact-visibility-backfill", () => {
  it("reports planned upgrades in dry-run mode without mutating artifacts", async () => {
    const publicFileId = randomUUID();
    const orgFileId = randomUUID();
    const alreadyPublicFileId = randomUUID();
    const unmatchedFileId = randomUUID();
    const revokedFileId = randomUUID();
    const siteId = randomUUID();
    const deploymentId = randomUUID();

    const store = createFakeStore({
      [`artifact-shares/okou/${randomUUID()}.json`]: buildFilePolicy({
        fileId: publicFileId,
        audience: "public",
      }),
      [`artifact-shares/vm0/${randomUUID()}.json`]: buildFilePolicy({
        fileId: orgFileId,
        audience: "organization",
        segment: "vm0",
      }),
      [`artifact-shares/okou/${randomUUID()}.json`]: buildFilePolicy({
        fileId: alreadyPublicFileId,
        audience: "organization",
      }),
      [`artifact-shares/okou/${randomUUID()}.json`]: buildFilePolicy({
        fileId: unmatchedFileId,
        audience: "public",
      }),
      [`artifact-shares/okou/${randomUUID()}.json`]: buildFilePolicy({
        fileId: revokedFileId,
        audience: "private",
      }),
      [`artifact-shares/okou/${randomUUID()}.json`]: buildHtmlPolicy({
        siteId,
        deploymentId,
      }),
      "artifact-shares/okou/corrupt.json": "{not-json",
      "artifact-shares/okou/ignored.txt": "ignored",
    });

    const publicArtId = randomUUID();
    const orgArtId = randomUUID();
    const alreadyPublicArtId = randomUUID();
    const { repo, state } = createFakeRepo([
      { fileId: publicFileId, artifactId: publicArtId, visibility: "private" },
      { fileId: orgFileId, artifactId: orgArtId, visibility: "private" },
      {
        fileId: alreadyPublicFileId,
        artifactId: alreadyPublicArtId,
        visibility: "public",
      },
    ]);

    const dryRun = await runR2ArtifactVisibilityBackfill(store, repo, {
      migrate: false,
    });
    expect(dryRun).toMatchObject({
      mode: "dry-run",
      scannedObjects: 7,
      activeFilePolicies: 4,
      htmlSnapshotPoliciesSkipped: 1,
      revokedOrPrivatePolicies: 1,
      invalidPolicies: 1,
      uniqueActiveFiles: 4,
      alreadySynced: 1,
      plannedUpdates: 2,
      appliedUpdates: 0,
      unmatchedFilePolicies: 1,
      sampleUnmatchedFileIds: [unmatchedFileId],
    });
    expect(state.get(publicArtId)).toBe("private");
    expect(state.get(orgArtId)).toBe("private");
    expect(state.get(alreadyPublicArtId)).toBe("public");
  });

  it("applies monotonic upgrades with --migrate, merges multi-segment policies, and is idempotent on replay", async () => {
    const fileId = randomUUID();
    const artifactId = randomUUID();
    const store = createFakeStore({
      [`artifact-shares/okou/${randomUUID()}.json`]: buildFilePolicy({
        fileId,
        audience: "organization",
        segment: "okou",
      }),
      [`artifact-shares/vm0/${randomUUID()}.json`]: buildFilePolicy({
        fileId,
        audience: "public",
        segment: "vm0",
      }),
    });
    const { repo, state } = createFakeRepo([
      { fileId, artifactId, visibility: "private" },
    ]);

    const first = await runR2ArtifactVisibilityBackfill(store, repo, {
      migrate: true,
    });
    expect(first.plannedUpdates).toBe(1);
    expect(first.appliedUpdates).toBe(1);
    expect(state.get(artifactId)).toBe("public");

    const replay = await runR2ArtifactVisibilityBackfill(store, repo, {
      migrate: true,
    });
    expect(replay.plannedUpdates).toBe(0);
    expect(replay.appliedUpdates).toBe(0);
    expect(replay.alreadySynced).toBe(1);
  });

  it("deduplicates canonical and shadow fileIds mapping to the same artifactId using highest visibility", async () => {
    const canonicalFileId = randomUUID();
    const shadowStorageKeyFileId = randomUUID();
    const externalIdPrimaryFileId = randomUUID();
    const externalIdShadowFileId = randomUUID();
    const sharedUpgradeArtId = randomUUID();
    const sharedSyncedArtId = randomUUID();

    const store = createFakeStore({
      [`artifact-shares/okou/${randomUUID()}.json`]: buildFilePolicy({
        fileId: canonicalFileId,
        audience: "organization",
      }),
      [`artifact-shares/okou/${randomUUID()}.json`]: buildFilePolicy({
        fileId: shadowStorageKeyFileId,
        audience: "public",
      }),
      [`artifact-shares/okou/${randomUUID()}.json`]: buildFilePolicy({
        fileId: externalIdPrimaryFileId,
        audience: "organization",
      }),
      [`artifact-shares/okou/${randomUUID()}.json`]: buildFilePolicy({
        fileId: externalIdShadowFileId,
        audience: "public",
      }),
    });

    const { repo, state, updateCalls } = createFakeRepo([
      // Canonical + storage_key shadow both resolve to the same private artifact
      {
        fileId: canonicalFileId,
        artifactId: sharedUpgradeArtId,
        visibility: "private",
      },
      {
        fileId: shadowStorageKeyFileId,
        artifactId: sharedUpgradeArtId,
        visibility: "private",
      },
      // Primary + external_id shadow both resolve to an already-public artifact
      {
        fileId: externalIdPrimaryFileId,
        artifactId: sharedSyncedArtId,
        visibility: "public",
      },
      {
        fileId: externalIdShadowFileId,
        artifactId: sharedSyncedArtId,
        visibility: "public",
      },
    ]);

    const dryRun = await runR2ArtifactVisibilityBackfill(store, repo, {
      migrate: false,
    });
    expect(dryRun.uniqueActiveFiles).toBe(4);
    expect(dryRun.plannedUpdates).toBe(1);
    expect(dryRun.alreadySynced).toBe(1);
    expect(dryRun.appliedUpdates).toBe(0);
    expect(updateCalls).toHaveLength(0);

    const migrated = await runR2ArtifactVisibilityBackfill(store, repo, {
      migrate: true,
    });
    expect(migrated.plannedUpdates).toBe(1);
    expect(migrated.appliedUpdates).toBe(1);
    expect(migrated.alreadySynced).toBe(1);
    expect(migrated.concurrentSkips).toBe(0);
    expect(state.get(sharedUpgradeArtId)).toBe("public");
    expect(updateCalls).toEqual([
      {
        artifactId: sharedUpgradeArtId,
        previousVisibility: "private",
        nextVisibility: "public",
      },
    ]);
  });

  it("matches shadow equivalence rows and kind='video' via video_artifacts in PG repository query", async () => {
    const videoFileId = randomUUID();
    const videoArtifactId = randomUUID();
    const capturedQueries: string[] = [];
    const capturedParams: unknown[][] = [];

    const fakeSql = ((strings: TemplateStringsArray, ...values: unknown[]) => {
      const queryText = strings.join("?");
      capturedQueries.push(queryText);
      capturedParams.push(values);
      if (queryText.includes("WITH input_ids")) {
        return Promise.resolve([
          {
            input_file_id: videoFileId,
            artifact_id: videoArtifactId,
            visibility: "private" as BackfillVisibility,
          },
        ]);
      }
      return Promise.resolve([{ id: videoArtifactId }]);
    }) as unknown as postgres.Sql;

    const pgRepo = createPgRepository(fakeSql);
    const store = createFakeStore({
      [`artifact-shares/okou/${randomUUID()}.json`]: buildFilePolicy({
        fileId: videoFileId,
        audience: "public",
      }),
    });

    const summary = await runR2ArtifactVisibilityBackfill(store, pgRepo, {
      migrate: true,
    });
    expect(summary.plannedUpdates).toBe(1);
    expect(summary.appliedUpdates).toBe(1);
    expect(summary.unmatchedFilePolicies).toBe(0);

    const lookupSql = capturedQueries[0] ?? "";
    expect(lookupSql).toContain("run_uploaded_files");
    expect(lookupSql).toContain("metadata->>'s3Key'");
    expect(lookupSql).toContain("lower(ruf.external_id)");
    expect(lookupSql).toContain("image_artifacts");
    expect(lookupSql).toContain("video_artifacts");
    expect(lookupSql).toContain("a.kind = 'video'");
    expect(capturedParams[0]?.[0]).toEqual([videoFileId]);
  });

  it("bounds R2 fetch concurrency, batches DB lookups, and respects --limit", async () => {
    const objects: Record<string, string> = {};
    const rows: Array<{
      fileId: string;
      artifactId: string;
      visibility: BackfillVisibility;
    }> = [];
    for (let i = 0; i < 14; i += 1) {
      const fileId = randomUUID();
      const artifactId = randomUUID();
      objects[`artifact-shares/okou/key-${String(i).padStart(2, "0")}.json`] =
        buildFilePolicy({ fileId, audience: "organization" });
      rows.push({ fileId, artifactId, visibility: "private" });
    }

    let inFlight = 0;
    let maxInFlight = 0;
    const delayedStore: R2PolicyObjectStore = {
      async *listKeys(prefix: string) {
        for (const key of Object.keys(objects).sort()) {
          if (key.startsWith(prefix)) {
            yield key;
          }
        }
      },
      async getJsonText(key: string) {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((resolve) => {
          setTimeout(resolve, 10);
        });
        inFlight -= 1;
        return objects[key] ?? null;
      },
    };

    const { repo, batchCalls } = createFakeRepo(rows);
    const summary = await runR2ArtifactVisibilityBackfill(delayedStore, repo, {
      migrate: false,
      concurrency: 4,
      dbBatchSize: 5,
    });
    expect(summary.scannedObjects).toBe(14);
    expect(summary.plannedUpdates).toBe(14);
    expect(maxInFlight).toBeGreaterThan(1);
    expect(maxInFlight).toBeLessThanOrEqual(4);
    expect(
      batchCalls
        .map((batch) => {
          return batch.length;
        })
        .sort((a, b) => {
          return a - b;
        }),
    ).toEqual([4, 5, 5]);

    const limitedRepo = createFakeRepo(rows);
    const limited = await runR2ArtifactVisibilityBackfill(
      delayedStore,
      limitedRepo.repo,
      {
        migrate: false,
        limit: 5,
        concurrency: 4,
      },
    );
    expect(limited.scannedObjects).toBe(5);
    expect(limited.plannedUpdates).toBe(5);
  });

  it("parses and validates --concurrency CLI option and runtime options", async () => {
    expect(parseCliArgs(["--bucket", "my-bucket"], {})).toEqual({
      migrate: false,
      bucket: "my-bucket",
      limit: undefined,
      concurrency: DEFAULT_CONCURRENCY,
    });
    expect(
      parseCliArgs(["--migrate", "--concurrency", "16", "--limit", "50"], {
        R2_HOSTED_SITES_BUCKET_NAME: "env-bucket",
      }),
    ).toEqual({
      migrate: true,
      bucket: "env-bucket",
      limit: 50,
      concurrency: 16,
    });

    for (const invalid of ["0", "-4", "1.5", "abc"]) {
      expect(() => {
        parseCliArgs(["--bucket", "b", "--concurrency", invalid], {});
      }).toThrow("--concurrency must be a positive integer");
    }
    expect(() => {
      parseCliArgs(["--bucket", "b", "--concurrency"], {});
    }).toThrow("--concurrency must be a positive integer");

    const store = createFakeStore({});
    const { repo } = createFakeRepo([]);
    await expect(
      runR2ArtifactVisibilityBackfill(store, repo, {
        migrate: false,
        concurrency: 0,
      }),
    ).rejects.toThrow("concurrency must be a positive integer");
  });
});
