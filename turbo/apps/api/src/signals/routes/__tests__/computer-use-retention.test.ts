import { DeleteObjectsCommand } from "@aws-sdk/client-s3";
import { cronComputerUseScreenshotCleanupContract } from "@okouai/api-contracts/contracts/cron";
import { aroundEach, beforeEach, describe, expect, it } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { mockEnv } from "../../../lib/env";
import { mockNow, withMockNowForTest } from "../../../lib/time";
import { cronComputerUseScreenshotCleanupRoutes } from "../cron-computer-use-screenshot-cleanup";
import { createPublicComputerUseScenario } from "./helpers/public-computer-use-scenario";

const context = testContext();
const STARTED_AT = Date.parse("2026-10-15T02:00:00.000Z");
const COMPLETED_AT = STARTED_AT + 1000;
const RETENTION_MS = 72 * 60 * 60 * 1000;
const CRON_SECRET = "computer-use-retention-operator";

aroundEach(async (runTest) => {
  await withMockNowForTest(STARTED_AT, runTest);
});

beforeEach(() => {
  mockEnv("CRON_SECRET", CRON_SECRET);
});

function createScenario(app: Awaited<ReturnType<typeof setupApp>>) {
  const cron = app(cronComputerUseScreenshotCleanupContract);
  const scenario = createPublicComputerUseScenario(context);
  return {
    ...scenario,
    cleanup: async () => {
      return await accept(
        cron.cleanup({
          headers: { authorization: `Bearer ${CRON_SECRET}` },
        }),
        [200],
      );
    },
  };
}

describe("Computer Use command retention", () => {
  it("removes screenshots, results and audit records 72 hours after completion while retaining queued work", async () => {
    const app = await setupApp({
      context,
      routes: cronComputerUseScreenshotCleanupRoutes,
      isolatePg: true,
    });
    const scenario = createScenario(app);
    await scenario.run(async () => {
      const computerUse = scenario.computerUse;
      const fake = computerUse.installComputerUseS3Fake();
      const actor = scenario.user();
      const host = await computerUse.startComputerUseHost(actor);
      const bytes = Buffer.from("private window screenshot");
      const commandIds: string[] = [];

      for (const outcome of ["screenshot", "text", "failed"] as const) {
        const created = await computerUse.createComputerUseWriteCommand(actor, {
          kind: "app.open",
          app: "com.apple.Safari",
        });
        commandIds.push(created.commandId);
        const claimed = await computerUse.claimNextComputerUseCommand(
          host.connection,
        );
        expect(claimed).toMatchObject({
          status: "command",
          command: { id: created.commandId },
        });
        mockNow(COMPLETED_AT);
        await computerUse.completeComputerUseCommandWith(
          host.connection,
          created.commandId,
          outcome === "failed"
            ? {
                status: "failed",
                error: {
                  code: "accessibility_unavailable",
                  message: "private error text",
                },
              }
            : {
                status: "succeeded",
                result: {
                  appState: "private window text",
                  ...(outcome === "screenshot"
                    ? {
                        screenshot: `data:image/png;base64,${bytes.toString("base64")}`,
                      }
                    : {}),
                },
              },
        );
      }
      const queued = await computerUse.createComputerUseReadCommand(actor, {
        kind: "app.state",
        app: "com.apple.Safari",
      });
      const screenshotId = commandIds[0];
      if (!screenshotId) {
        throw new Error("Expected the screenshot command's public identity");
      }

      // Created more than 72 hours ago, but completed less than 72 hours ago.
      mockNow(COMPLETED_AT + RETENTION_MS - 1);
      await scenario.cleanup();
      for (const commandId of commandIds) {
        const retained = await computerUse.readComputerUseCommand(
          actor,
          commandId,
        );
        expect(retained.completedAt).toBe(new Date(COMPLETED_AT).toISOString());
        const audit = await computerUse.listComputerUseAuditEvents(actor, {
          commandId,
        });
        expect(audit.auditEvents.length).toBeGreaterThan(0);
      }
      const screenshot = await computerUse.resolveComputerUseScreenshot(
        actor,
        screenshotId,
      );
      expect(screenshot).toMatchObject({
        downloadUrl: expect.stringContaining(
          encodeURIComponent(`${screenshotId}/screenshot.png`),
        ),
        contentType: "image/png",
        size: bytes.length,
      });

      mockNow(COMPLETED_AT + RETENTION_MS);
      await scenario.cleanup();
      for (const commandId of commandIds) {
        const removed = await computerUse.requestReadComputerUseCommand(
          actor,
          commandId,
          [404],
        );
        expect(removed.status).toBe(404);
        const audit = await computerUse.listComputerUseAuditEvents(actor, {
          commandId,
        });
        expect(audit.auditEvents).toStrictEqual([]);
      }
      const removedScreenshot = await computerUse.requestComputerUseScreenshot(
        actor,
        screenshotId,
        [404],
      );
      expect(removedScreenshot.status).toBe(404);
      const pending = await computerUse.readComputerUseCommand(
        actor,
        queued.commandId,
      );
      expect(pending).toMatchObject({ status: "queued", completedAt: null });

      const uploaded = fake.puts[0];
      if (!uploaded) {
        throw new Error("Expected the uploaded screenshot");
      }
      expect(context.mocks.s3.send).toHaveBeenCalledWith(
        expect.any(DeleteObjectsCommand),
        expect.objectContaining({ abortSignal: expect.any(AbortSignal) }),
      );
      expect(context.mocks.s3.send).toHaveBeenCalledWith(
        expect.objectContaining({
          input: {
            Bucket: uploaded.bucket,
            Delete: { Objects: [{ Key: uploaded.key }] },
          },
        }),
        expect.anything(),
      );
      // Repeated operator delivery leaves the retained public state intact.
      await scenario.cleanup();
      const stillQueued = await computerUse.readComputerUseCommand(
        actor,
        queued.commandId,
      );
      expect(stillQueued.status).toBe("queued");
    });
  });

  it("retains command data when object deletion fails and removes it on the next sweep", async () => {
    const app = await setupApp({
      context,
      routes: cronComputerUseScreenshotCleanupRoutes,
      isolatePg: true,
    });
    const scenario = createScenario(app);
    await scenario.run(async () => {
      const computerUse = scenario.computerUse;
      const fake = computerUse.installComputerUseS3Fake();
      const actor = scenario.user();
      const host = await computerUse.startComputerUseHost(actor);
      const created = await computerUse.createComputerUseWriteCommand(actor, {
        kind: "app.open",
        app: "com.apple.Safari",
      });
      await computerUse.claimNextComputerUseCommand(host.connection);
      await computerUse.completeComputerUseCommandWith(
        host.connection,
        created.commandId,
        {
          status: "succeeded",
          result: {
            appState: "recoverable private window text",
            screenshot: `data:image/png;base64,${Buffer.from("recoverable screenshot").toString("base64")}`,
          },
        },
      );

      mockNow(STARTED_AT + RETENTION_MS);
      fake.failNextDeleteObjects(new Error("Object storage is unavailable"));
      await expect(scenario.cleanup()).rejects.toThrow(
        "Unknown response status 500",
      );
      const retained = await computerUse.readComputerUseCommand(
        actor,
        created.commandId,
      );
      expect(retained.result?.appState).toBe("recoverable private window text");
      const screenshot = await computerUse.resolveComputerUseScreenshot(
        actor,
        created.commandId,
      );
      expect(screenshot).toMatchObject({
        downloadUrl: expect.stringContaining(
          encodeURIComponent(`${created.commandId}/screenshot.png`),
        ),
        size: Buffer.byteLength("recoverable screenshot"),
      });
      const audit = await computerUse.listComputerUseAuditEvents(actor, {
        commandId: created.commandId,
      });
      expect(audit.auditEvents.length).toBeGreaterThan(0);

      await scenario.cleanup();
      const removed = await computerUse.requestReadComputerUseCommand(
        actor,
        created.commandId,
        [404],
      );
      expect(removed.status).toBe(404);
      const removedAudit = await computerUse.listComputerUseAuditEvents(actor, {
        commandId: created.commandId,
      });
      expect(removedAudit.auditEvents).toStrictEqual([]);
    });
  });
});
