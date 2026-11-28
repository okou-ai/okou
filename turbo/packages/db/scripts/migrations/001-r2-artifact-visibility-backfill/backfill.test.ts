import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
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
} {
  const byFile = new Map<string, string[]>();
  const state = new Map<string, BackfillVisibility>();
  for (const row of initial) {
    state.set(row.artifactId, row.visibility);
    const list = byFile.get(row.fileId) ?? [];
    list.push(row.artifactId);
    byFile.set(row.fileId, list);
  }

  return {
    state,
    repo: {
      findActiveFileArtifacts(
        fileId: string,
      ): Promise<readonly ArtifactVisibilityMatch[]> {
        const ids = byFile.get(fileId) ?? [];
        return Promise.resolve(
          ids.map((artifactId) => {
            return {
              artifactId,
              visibility: state.get(artifactId) ?? "private",
            };
          }),
        );
      },
      updateVisibilityIfUnchanged(
        artifactId: string,
        previousVisibility: BackfillVisibility,
        nextVisibility: Exclude<BackfillVisibility, "private">,
      ): Promise<boolean> {
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
});
