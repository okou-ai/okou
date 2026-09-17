import { beforeEach, describe, expect, it } from "vitest";

import { testContext } from "../../../__tests__/test-context";
import { mockEnv } from "../../../lib/env";
import { cronCleanupSandboxesRoutes } from "../cron-cleanup-sandboxes";
import { cronCleanupXResourceReadsRoutes } from "../cron-cleanup-x-resource-reads";
import { cronCompactChatThreadSnapshotsRoutes } from "../cron-compact-chat-thread-snapshots";
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

  it("rejects snapshot compaction requests without authorization", async () => {
    expect.hasAssertions();
    await expectGlobalSweepMissingAuth(
      context,
      cronCompactChatThreadSnapshotsRoutes,
      "/api/cron/compact-chat-thread-snapshots",
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
