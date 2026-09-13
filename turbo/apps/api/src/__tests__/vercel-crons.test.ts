import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  cronBrowserReconcileContract,
  cronCompactChatThreadSnapshotsContract,
  cronCompactUsageEventsContract,
  cronCleanupSandboxesContract,
  cronConnectorCatalogContract,
  cronConnectorOauthStateCleanupContract,
  cronComputerUseScreenshotCleanupContract,
  cronDrainEmailOutboxContract,
  cronExecuteWorkflowAutomationsContract,
  cronMonitorChatEventQueueContract,
  cronMaterializeMemorySummariesContract,
  cronMaterializePiResourceIndexesContract,
  cronExtractPiMemoryStage1Contract,
  cronConsolidatePiMemoryPhase2Contract,
  cronOfficialWorkflowCatalogContract,
  cronProcessUsageEventsContract,
  cronProjectChatEventSearchContract,
  cronRenewGmailWatchesContract,
  cronSnapshotChatEventsContract,
  cronRetainChatEventsContract,
  cronRenewGoogleFormsWatchesContract,
  cronRenewGoogleCalendarWatchesContract,
  cronRenewGoogleWorkspaceEventSubscriptionsContract,
  cronReconcileBillingEntitlementsContract,
  cronReconcileSocialKitDownloadsContract,
  cronRefreshStoragePresignedUrlsContract,
  cronSteerRunTimeBudgetContract,
  cronSyncSkillsContract,
  cronTelegramCleanupContract,
} from "@okouai/api-contracts/contracts/cron";
import { describe, expect, it } from "vitest";

import { ROUTES } from "../signals/route";
import { cronConsolidatePiMemoryPhase2Routes } from "../signals/routes/cron-consolidate-pi-memory-phase2";

interface VercelCron {
  readonly path: string;
  readonly schedule: string;
}

interface VercelConfig {
  readonly crons?: readonly VercelCron[];
}

function readVercelConfig(): VercelConfig {
  const configPath = fileURLToPath(
    new URL("../../vercel.json", import.meta.url),
  );
  return JSON.parse(readFileSync(configPath, "utf8")) as VercelConfig;
}

const expectedVercelCrons = [
  {
    path: cronCleanupSandboxesContract.cleanup.path,
    schedule: "* * * * *",
  },
  {
    path: cronMonitorChatEventQueueContract.monitor.path,
    schedule: "* * * * *",
  },
  {
    path: cronProjectChatEventSearchContract.project.path,
    schedule: "* * * * *",
  },
  {
    path: cronSnapshotChatEventsContract.snapshot.path,
    schedule: "*/10 * * * *",
  },
  {
    path: cronRetainChatEventsContract.retain.path,
    schedule: "* * * * *",
  },
  {
    path: cronExecuteWorkflowAutomationsContract.execute.path,
    schedule: "* * * * *",
  },
  {
    path: cronRenewGmailWatchesContract.renew.path,
    schedule: "0 */12 * * *",
  },
  {
    path: cronRenewGoogleFormsWatchesContract.renew.path,
    schedule: "0 */12 * * *",
  },
  {
    path: cronRenewGoogleCalendarWatchesContract.renew.path,
    schedule: "0 */12 * * *",
  },
  {
    path: cronRenewGoogleWorkspaceEventSubscriptionsContract.renew.path,
    schedule: "0 */12 * * *",
  },
  {
    path: cronCompactChatThreadSnapshotsContract.compact.path,
    schedule: "0 * * * *",
  },
  {
    path: cronCompactUsageEventsContract.compact.path,
    schedule: "* * * * *",
  },
  {
    path: cronTelegramCleanupContract.cleanup.path,
    schedule: "0 1 * * *",
  },
  {
    path: cronConnectorOauthStateCleanupContract.cleanup.path,
    schedule: "15 * * * *",
  },
  {
    path: cronDrainEmailOutboxContract.drain.path,
    schedule: "* * * * *",
  },
  {
    path: cronSyncSkillsContract.sync.path,
    schedule: "* * * * *",
  },
  {
    path: cronConnectorCatalogContract.sync.path,
    schedule: "* * * * *",
  },
  {
    path: cronOfficialWorkflowCatalogContract.sync.path,
    schedule: "* * * * *",
  },
  {
    path: cronProcessUsageEventsContract.process.path,
    schedule: "* * * * *",
  },
  {
    path: cronReconcileSocialKitDownloadsContract.reconcile.path,
    schedule: "* * * * *",
  },
  {
    path: cronReconcileBillingEntitlementsContract.reconcile.path,
    schedule: "0 * * * *",
  },
  {
    path: cronRefreshStoragePresignedUrlsContract.refresh.path,
    schedule: "* * * * *",
  },
  {
    path: cronMaterializePiResourceIndexesContract.materialize.path,
    schedule: "* * * * *",
  },
  {
    path: cronMaterializeMemorySummariesContract.materialize.path,
    schedule: "* * * * *",
  },
  {
    path: cronExtractPiMemoryStage1Contract.extract.path,
    schedule: "* * * * *",
  },
  {
    path: cronConsolidatePiMemoryPhase2Contract.consolidate.path,
    schedule: "* * * * *",
  },
  {
    path: cronComputerUseScreenshotCleanupContract.cleanup.path,
    schedule: "30 2 * * *",
  },
  {
    path: cronBrowserReconcileContract.reconcile.path,
    schedule: "* * * * *",
  },
  {
    path: cronSteerRunTimeBudgetContract.steer.path,
    schedule: "* * * * *",
  },
] satisfies readonly VercelCron[];

describe("vercel cron config", () => {
  it("matches API-owned cron schedules", () => {
    const crons = readVercelConfig().crons ?? [];

    expect(crons).toStrictEqual(expectedVercelCrons);
  });

  it("targets existing API routes without duplicate paths", () => {
    const crons = readVercelConfig().crons ?? [];
    const routePaths = new Set(
      ROUTES.map(({ route }) => {
        return route.path;
      }),
    );
    const cronPaths = crons.map(({ path }) => {
      return path;
    });

    expect(new Set(cronPaths).size).toBe(cronPaths.length);
    for (const path of cronPaths) {
      expect(
        routePaths.has(path),
        `${path} must be registered in API routes`,
      ).toBeTruthy();
    }

    expect(
      crons.filter(({ path }) => {
        return path === cronExtractPiMemoryStage1Contract.extract.path;
      }),
    ).toStrictEqual([
      {
        path: cronExtractPiMemoryStage1Contract.extract.path,
        schedule: "* * * * *",
      },
    ]);
    expect(
      crons.filter(({ path }) => {
        return path === cronConsolidatePiMemoryPhase2Contract.consolidate.path;
      }),
    ).toStrictEqual([
      {
        path: cronConsolidatePiMemoryPhase2Contract.consolidate.path,
        schedule: "* * * * *",
      },
    ]);
    expect(
      cronConsolidatePiMemoryPhase2Routes.map(({ route }) => {
        return route.path;
      }),
    ).toStrictEqual([cronConsolidatePiMemoryPhase2Contract.consolidate.path]);
  });
});
