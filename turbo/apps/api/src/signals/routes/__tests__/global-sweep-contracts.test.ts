import { beforeEach, describe, expect, it } from "vitest";

import { randomUUID } from "node:crypto";
import { cronCompactChatThreadSnapshotsContract } from "@okouai/api-contracts/contracts/cron";
import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { mockEnv } from "../../../lib/env";
import { cronComputerUseScreenshotCleanupRoutes } from "../cron-computer-use-screenshot-cleanup";
import { cronCleanupSandboxesRoutes } from "../cron-cleanup-sandboxes";
import { cronCleanupXResourceReadsRoutes } from "../cron-cleanup-x-resource-reads";
import { cronCompactChatThreadSnapshotsRoutes } from "../cron-compact-chat-thread-snapshots";
import { cronReconcileArtifactCatalogRoutes } from "../cron-reconcile-artifact-catalog";
import { cronConnectorOauthStateCleanupRoutes } from "../cron-connector-oauth-state-cleanup";
import { cronDrainEmailOutboxRoutes } from "../cron-drain-email-outbox";
import { cronExecuteWorkflowAutomationsRoutes } from "../cron-execute-workflow-automations";
import { cronRenewGmailWatchesRoutes } from "../cron-renew-gmail-watches";
import { cronReconcileBillingEntitlementsRoutes } from "../cron-reconcile-billing-entitlements";
import { cronReconcileSocialKitDownloadRoutes } from "../cron-reconcile-socialkit-downloads";
import { cronSyncSkillsRoutes } from "../cron-sync-skills";
import {
  expectGlobalSweepMissingAuth,
  expectGlobalSweepWrongAuth,
} from "./helpers/global-sweep-contract";

const context = testContext();
const CRON_SECRET = "test-cron-secret";

describe("production-global sweep route contracts", () => {
  beforeEach(() => {
    mockEnv("CRON_SECRET", CRON_SECRET);
  });

  it("rejects screenshot cleanup without a valid cron secret", async () => {
    expect.hasAssertions();
    await expectGlobalSweepMissingAuth(
      context,
      cronComputerUseScreenshotCleanupRoutes,
      "/api/cron/computer-use-screenshot-cleanup",
    );
    await expectGlobalSweepWrongAuth(
      context,
      cronComputerUseScreenshotCleanupRoutes,
      "/api/cron/computer-use-screenshot-cleanup",
    );
  });

  it("rejects X resource cleanup requests without authorization", async () => {
    expect.hasAssertions();
    await expectGlobalSweepMissingAuth(
      context,
      cronCleanupXResourceReadsRoutes,
      "/api/cron/cleanup-x-resource-reads",
    );
  });

  it("rejects X resource cleanup requests with an invalid cron secret", async () => {
    expect.hasAssertions();
    await expectGlobalSweepWrongAuth(
      context,
      cronCleanupXResourceReadsRoutes,
      "/api/cron/cleanup-x-resource-reads",
    );
  });

  it("reports no work when compacting an empty isolated snapshot scope", async () => {
    const app = await setupApp({
      context,
      routes: cronCompactChatThreadSnapshotsRoutes,
      isolatePg: true,
    });
    mockEnv("R2_USER_STORAGES_BUCKET_NAME", `snapshot-empty-${randomUUID()}`);
    context.mocks.s3.send.mockResolvedValue({
      Contents: [],
      IsTruncated: false,
    });
    const response = await accept(
      app(cronCompactChatThreadSnapshotsContract).compact({
        headers: { authorization: `Bearer ${CRON_SECRET}` },
      }),
      [200],
    );

    expect(response.status).toBe(200);
    expect(response.body).toStrictEqual({
      success: true,
      scopes: 0,
      eventsApplied: 0,
      eventsPruned: 0,
      gc: {
        pagesScanned: 16,
        objectsScanned: 0,
        deleteAttempts: 0,
        objectsDeleted: 0,
        deferred: false,
        failed: false,
      },
    });
  });

  it("rejects snapshot compaction requests without authorization", async () => {
    expect.hasAssertions();
    await expectGlobalSweepMissingAuth(
      context,
      cronCompactChatThreadSnapshotsRoutes,
      "/api/cron/compact-chat-thread-snapshots",
    );
  });

  it("rejects artifact reconciliation without authorization", async () => {
    expect.hasAssertions();
    await expectGlobalSweepMissingAuth(
      context,
      cronReconcileArtifactCatalogRoutes,
      "/api/cron/reconcile-artifact-catalog",
    );
  });

  it("rejects snapshot compaction requests with an invalid cron secret", async () => {
    expect.hasAssertions();
    await expectGlobalSweepWrongAuth(
      context,
      cronCompactChatThreadSnapshotsRoutes,
      "/api/cron/compact-chat-thread-snapshots",
    );
  });

  it("rejects cleanup-sandboxes requests with an invalid cron secret", async () => {
    expect.hasAssertions();
    await expectGlobalSweepWrongAuth(
      context,
      cronCleanupSandboxesRoutes,
      "/api/cron/cleanup-sandboxes",
    );
  });

  it("rejects cleanup-sandboxes requests without authorization", async () => {
    expect.hasAssertions();
    await expectGlobalSweepMissingAuth(
      context,
      cronCleanupSandboxesRoutes,
      "/api/cron/cleanup-sandboxes",
    );
  });

  it("rejects connector OAuth cleanup requests without authorization", async () => {
    expect.hasAssertions();
    await expectGlobalSweepMissingAuth(
      context,
      cronConnectorOauthStateCleanupRoutes,
      "/api/cron/connector-oauth-state-cleanup",
    );
  });

  it("rejects billing reconciliation requests without authorization", async () => {
    expect.hasAssertions();
    await expectGlobalSweepMissingAuth(
      context,
      cronReconcileBillingEntitlementsRoutes,
      "/api/cron/reconcile-billing-entitlements",
    );
  });

  it("rejects SocialKit download reconciliation without authorization", async () => {
    expect.hasAssertions();
    await expectGlobalSweepMissingAuth(
      context,
      cronReconcileSocialKitDownloadRoutes,
      "/api/cron/reconcile-socialkit-downloads",
    );
  });

  it("rejects email-outbox drain requests without authorization", async () => {
    expect.hasAssertions();
    await expectGlobalSweepMissingAuth(
      context,
      cronDrainEmailOutboxRoutes,
      "/api/cron/drain-email-outbox",
    );
  });

  it("rejects sync-skills requests with an invalid cron secret", async () => {
    expect.hasAssertions();
    await expectGlobalSweepWrongAuth(
      context,
      cronSyncSkillsRoutes,
      "/api/cron/sync-skills",
    );
  });

  it("rejects sync-skills requests without authorization", async () => {
    expect.hasAssertions();
    await expectGlobalSweepMissingAuth(
      context,
      cronSyncSkillsRoutes,
      "/api/cron/sync-skills",
    );
  });

  it("rejects workflow automation sweeps without authorization", async () => {
    expect.hasAssertions();
    await expectGlobalSweepMissingAuth(
      context,
      cronExecuteWorkflowAutomationsRoutes,
      "/api/cron/execute-workflow-automations",
    );
  });

  it("rejects Gmail watch renewal without authorization", async () => {
    expect.hasAssertions();
    await expectGlobalSweepMissingAuth(
      context,
      cronRenewGmailWatchesRoutes,
      "/api/cron/renew-gmail-watches",
    );
  });
});
