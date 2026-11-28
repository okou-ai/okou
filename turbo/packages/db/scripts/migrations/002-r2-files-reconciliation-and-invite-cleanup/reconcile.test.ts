import { describe, expect, it } from "vitest";
import {
  runR2FilesReconciliationAndInviteCleanup,
  type FilesParityAudit,
  type ReconciliationRepository,
} from "./reconcile";

function createFakeRepo(params: {
  hostedSiteUnclaimed: number;
  artifactFileUnclaimed: number;
  parity: FilesParityAudit;
}): {
  repo: ReconciliationRepository;
  remaining: { hosted: number; file: number };
} {
  const remaining = {
    hosted: params.hostedSiteUnclaimed,
    file: params.artifactFileUnclaimed,
  };
  return {
    remaining,
    repo: {
      countUnclaimedInvites() {
        return Promise.resolve({
          hostedSiteSharesUnclaimed: remaining.hosted,
          artifactFileSharesUnclaimed: remaining.file,
        });
      },
      deleteUnclaimedHostedSiteSharesBatch(limit: number) {
        const removed = Math.min(limit, remaining.hosted);
        remaining.hosted -= removed;
        return Promise.resolve(removed);
      },
      deleteUnclaimedArtifactFileSharesBatch(limit: number) {
        const removed = Math.min(limit, remaining.file);
        remaining.file -= removed;
        return Promise.resolve(removed);
      },
      auditFilesParity() {
        return Promise.resolve(params.parity);
      },
    },
  };
}

const CLEAN_PARITY: FilesParityAudit = {
  missingRealFilesInFilesCount: 0,
  emptyOrgFilesCount: 0,
  sitePseudoRowsInFilesCount: 0,
  orphanImageArtifactsShadowCount: 0,
  orphanImageArtifactsOtherCount: 0,
  legacyVideoArtifactsCount: 0,
  claimedSharesMissingInArtifactUserSharesCount: 0,
};

describe("002-r2-files-reconciliation-and-invite-cleanup", () => {
  it("audits without deleting unclaimed invitations in dry-run mode", async () => {
    const { repo, remaining } = createFakeRepo({
      hostedSiteUnclaimed: 4,
      artifactFileUnclaimed: 7,
      parity: CLEAN_PARITY,
    });

    const summary = await runR2FilesReconciliationAndInviteCleanup(repo, {
      migrate: false,
    });
    expect(summary).toEqual({
      mode: "dry-run",
      beforeUnclaimedInvites: {
        hostedSiteSharesUnclaimed: 4,
        artifactFileSharesUnclaimed: 7,
      },
      deletedHostedSiteShares: 0,
      deletedArtifactFileShares: 0,
      afterUnclaimedInvites: {
        hostedSiteSharesUnclaimed: 4,
        artifactFileSharesUnclaimed: 7,
      },
      parityAudit: CLEAN_PARITY,
      hasStrictFailures: false,
    });
    expect(remaining).toEqual({ hosted: 4, file: 7 });
  });

  it("deletes unclaimed invitations in bounded batches under --migrate", async () => {
    const { repo, remaining } = createFakeRepo({
      hostedSiteUnclaimed: 5,
      artifactFileUnclaimed: 3,
      parity: CLEAN_PARITY,
    });

    const summary = await runR2FilesReconciliationAndInviteCleanup(repo, {
      migrate: true,
      batchSize: 2,
    });
    expect(summary.mode).toBe("migrate");
    expect(summary.deletedHostedSiteShares).toBe(5);
    expect(summary.deletedArtifactFileShares).toBe(3);
    expect(summary.afterUnclaimedInvites).toEqual({
      hostedSiteSharesUnclaimed: 0,
      artifactFileSharesUnclaimed: 0,
    });
    expect(summary.hasStrictFailures).toBe(false);
    expect(remaining).toEqual({ hosted: 0, file: 0 });
  });

  it("flags strict failures when files parity or claimed share coverage has gaps", async () => {
    const { repo } = createFakeRepo({
      hostedSiteUnclaimed: 0,
      artifactFileUnclaimed: 0,
      parity: {
        ...CLEAN_PARITY,
        missingRealFilesInFilesCount: 2,
      },
    });

    const summary = await runR2FilesReconciliationAndInviteCleanup(repo, {
      migrate: false,
    });
    expect(summary.hasStrictFailures).toBe(true);
  });
});
