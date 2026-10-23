import { aroundEach, describe, expect, it } from "vitest";

import { testContext } from "../../../__tests__/test-context";
import { withMockNowForTest } from "../../../lib/time";
import { settleIncludingAbort } from "../../utils";
import { createPublicComputerUseScenario } from "./helpers/public-computer-use-scenario";

const context = testContext();
const STARTED_AT_MS = Date.parse("2026-09-19T02:00:00.000Z");

aroundEach(async (runTest) => {
  await withMockNowForTest(STARTED_AT_MS, runTest);
});

async function prepareScreenshotCompletion(
  scenario: ReturnType<typeof createPublicComputerUseScenario>,
) {
  const actor = scenario.user();
  const host = await scenario.computerUse.startComputerUseHost(actor, {
    hostName: "Screenshot completion Desktop",
  });
  const created = await scenario.computerUse.createComputerUseReadCommand(
    actor,
    { kind: "app.state", app: "Safari" },
  );
  const claimed = await scenario.computerUse.claimNextComputerUseCommand(
    host.connection,
  );
  expect(claimed).toMatchObject({
    status: "command",
    command: { id: created.commandId },
  });
  const bytes = Buffer.from("screenshot completion bytes 中文🙂");
  return {
    actor,
    host,
    commandId: created.commandId,
    bytes,
    result: {
      snapshotId: "screenshot_completion",
      screenshot: `data:image/png;base64,${bytes.toString("base64")}`,
      screenshotWidth: 1440,
      screenshotHeight: 900,
    },
  };
}

async function expectRunningWithoutScreenshot(
  scenario: ReturnType<typeof createPublicComputerUseScenario>,
  fixture: Awaited<ReturnType<typeof prepareScreenshotCompletion>>,
) {
  const command = await scenario.computerUse.readComputerUseCommand(
    fixture.actor,
    fixture.commandId,
  );
  expect(command).toMatchObject({ status: "running", completedAt: null });
  expect(command.result).toBeUndefined();
  const content = await scenario.computerUse.requestComputerUseScreenshot(
    fixture.actor,
    fixture.commandId,
    [404],
  );
  expect(content.body).toStrictEqual({
    error: {
      message: "Computer-use command screenshot not found",
      code: "NOT_FOUND",
    },
  });
}

async function completeAndReadScreenshot(
  scenario: ReturnType<typeof createPublicComputerUseScenario>,
  fixture: Awaited<ReturnType<typeof prepareScreenshotCompletion>>,
) {
  await scenario.computerUse.completeComputerUseCommandWith(
    fixture.host.connection,
    fixture.commandId,
    { status: "succeeded", result: fixture.result },
  );
  const command = await scenario.computerUse.readComputerUseCommand(
    fixture.actor,
    fixture.commandId,
  );
  expect(command).toMatchObject({ status: "succeeded" });
  expect(command.result?.screenshot).toStrictEqual({
    type: "s3",
    mimeType: "image/png",
    sizeBytes: fixture.bytes.length,
    width: 1440,
    height: 900,
  });
  const content = await scenario.computerUse.resolveComputerUseScreenshot(
    fixture.actor,
    fixture.commandId,
  );
  expect(content).toMatchObject({
    downloadUrl: expect.stringContaining(
      encodeURIComponent(`${fixture.commandId}/screenshot.png`),
    ),
    filename: "screenshot.png",
    contentType: "image/png",
    size: fixture.bytes.length,
    cacheControl: "private, no-store",
  });
}

describe("Computer Use screenshot completion", () => {
  it("keeps an upload failure recoverable through ordinary completion", async () => {
    const scenario = createPublicComputerUseScenario(context);
    return await scenario.run(async () => {
      const fake = scenario.computerUse.installComputerUseS3Fake();
      const fixture = await prepareScreenshotCompletion(scenario);
      fake.failNextPutObject(new Error("Screenshot storage is unavailable"));

      await expect(
        scenario.computerUse.completeComputerUseCommandWith(
          fixture.host.connection,
          fixture.commandId,
          { status: "succeeded", result: fixture.result },
        ),
      ).rejects.toThrow("Unknown response status 500");
      await expectRunningWithoutScreenshot(scenario, fixture);
      await completeAndReadScreenshot(scenario, fixture);
    });
  });

  it("drains an admitted upload before rejecting a cancelled API completion", async () => {
    const scenario = createPublicComputerUseScenario(context);
    return await scenario.run(async () => {
      const fake = scenario.computerUse.installComputerUseS3Fake();
      const fixture = await prepareScreenshotCompletion(scenario);
      const owner = new AbortController();
      const barrier = fake.holdNextPutObject();
      const pending = settleIncludingAbort(() => {
        return scenario.computerUse.completeComputerUseCommandWith(
          fixture.host.connection,
          fixture.commandId,
          { status: "succeeded", result: fixture.result },
          AbortSignal.any([context.signal, owner.signal]),
        );
      });
      const checked = await settleIncludingAbort(async () => {
        const started = await Promise.race([barrier.entered, pending]);
        if ("ok" in started) {
          if (!started.ok) {
            throw started.error;
          }
          throw new Error("Completion finished before the upload response");
        }
        owner.abort(
          new DOMException("Computer Use API instance stopped", "AbortError"),
        );
        await expectRunningWithoutScreenshot(scenario, fixture);
        barrier.release();
        await expect(pending).resolves.toMatchObject({
          ok: false,
          error: expect.objectContaining({
            message: expect.stringContaining("Unknown response status 500"),
          }),
        });
        await expectRunningWithoutScreenshot(scenario, fixture);
        await completeAndReadScreenshot(scenario, fixture);
      });
      owner.abort();
      barrier.release();
      await pending;
      if (!checked.ok) {
        throw checked.error;
      }
    });
  });
});
