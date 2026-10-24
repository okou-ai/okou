import { ListObjectsV2Command, PutObjectCommand } from "@aws-sdk/client-s3";
import {
  chatThreadSnapshotArchiveSchema,
  chatThreadsContract,
} from "@okouai/api-contracts/contracts/chat-threads";
import { randomUUID } from "node:crypto";
import { cronCompactChatThreadSnapshotsContract } from "@okouai/api-contracts/contracts/cron";
import { http, HttpResponse } from "msw";
import { beforeEach, describe, expect, it } from "vitest";
import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { mockEnv } from "../../../lib/env";
import { server } from "../../../mocks/server";
import { chatThreadRoutes } from "../chat-threads";
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
import { cronSyncSkillsRoutes } from "../cron-sync-skills";
import { createBddApi } from "./helpers/api-bdd";
import { createChatFilesBddApi } from "./helpers/api-bdd-chat-files";
import {
  expectGlobalSweepMissingAuth,
  expectGlobalSweepWrongAuth,
} from "./helpers/global-sweep-contract";
import { createRouteMocks } from "./helpers/route-test";

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

  it("keeps snapshots readable as the cursor advances with unchanged and changed content", async () => {
    const app = await setupApp({
      context,
      routes: [...cronCompactChatThreadSnapshotsRoutes, ...chatThreadRoutes],
      isolatePg: true,
    });
    const bdd = createBddApi(context);
    const chat = createChatFilesBddApi(context);
    const owner = bdd.user();
    bdd.acceptAgentStorageWrites();
    const agent = await bdd.createAgent(owner, {
      displayName: "Sidebar snapshot agent",
    });
    mockEnv("R2_USER_STORAGES_BUCKET_NAME", `snapshot-${randomUUID()}`);
    const objects = new Map<string, Buffer>();
    context.mocks.s3.send.mockImplementation((request: unknown) => {
      if (request instanceof PutObjectCommand) {
        const { Bucket, Key, Body } = request.input;
        if (!Bucket || !Key || !Buffer.isBuffer(Body)) {
          throw new Error("Expected snapshot upload bytes and object identity");
        }
        objects.set(`${Bucket}/${Key}`, Buffer.from(Body));
        return Promise.resolve({});
      }
      if (request instanceof ListObjectsV2Command) {
        return Promise.resolve({ Contents: [], IsTruncated: false });
      }
      throw new Error("Unexpected snapshot storage request");
    });
    server.use(
      http.get(
        "https://r2.example.com/storage/archive.tar.gz",
        ({ request }) => {
          const object = new URL(request.url).searchParams.get("object");
          const body = object === null ? undefined : objects.get(object);
          return body
            ? new HttpResponse(new Uint8Array(body), {
                headers: {
                  "content-type": "application/json",
                  "content-encoding": "gzip",
                },
              })
            : new HttpResponse(null, { status: 404 });
        },
      ),
    );

    async function compactAndRead() {
      await accept(
        app(cronCompactChatThreadSnapshotsContract).compact({
          headers: { authorization: `Bearer ${CRON_SECRET}` },
        }),
        [200],
      );
      createRouteMocks(context).clerk.session(owner.userId, owner.orgId);
      const snapshot = await accept(
        app(chatThreadsContract).snapshot({
          headers: { authorization: "Bearer clerk-session" },
        }),
        [200],
      );
      if (!("url" in snapshot.body)) {
        throw new Error("Expected a downloadable sidebar snapshot");
      }
      return snapshot.body;
    }

    async function download(url: string) {
      const response = await fetch(url);
      expect(response.status).toBe(200);
      return chatThreadSnapshotArchiveSchema.parse(await response.json());
    }

    const thread = await chat.createThread(owner, {
      agentId: agent.agentId,
      title: "Original title",
      model: null,
    });
    const initial = await compactAndRead();
    const initialArchive = await download(initial.url);
    expect(initialArchive.chatThreads).toStrictEqual([
      expect.objectContaining({ id: thread.id, title: "Original title" }),
    ]);

    // A thread created and deleted between compactions advances the lifecycle
    // cursor while leaving the sidebar projection unchanged.
    const temporary = await chat.createThread(owner, {
      agentId: agent.agentId,
      title: "Temporary thread",
      model: null,
    });
    await chat.deleteThread(owner, temporary.id);
    const unchanged = await compactAndRead();
    expect(unchanged.latestSeqId).toBeGreaterThan(initial.latestSeqId ?? 0);
    expect(unchanged.url).toBe(initial.url);
    await expect(download(unchanged.url)).resolves.toStrictEqual(
      initialArchive,
    );

    await chat.renameThread(owner, thread.id, "Updated title");
    const changed = await compactAndRead();
    expect(changed.latestSeqId).toBeGreaterThan(unchanged.latestSeqId ?? 0);
    expect((await download(changed.url)).chatThreads).toStrictEqual([
      expect.objectContaining({ id: thread.id, title: "Updated title" }),
    ]);
    await expect(download(initial.url)).resolves.toStrictEqual(initialArchive);
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
