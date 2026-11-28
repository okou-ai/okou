import { cronComputerUseScreenshotCleanupContract } from "@okouai/api-contracts/contracts/cron";
import { expect, test } from "vitest";
import { setupApp } from "../../../__tests__/test-helpers";
import { accept, testContext } from "../../../__tests__/test-context";
import { cronComputerUseScreenshotCleanupRoutes } from "../cron-computer-use-screenshot-cleanup";

const context = testContext();
const cleanup = () => {
  return setupApp({ context, routes: cronComputerUseScreenshotCleanupRoutes })(
    cronComputerUseScreenshotCleanupContract,
  );
};

test("global-sweep-contracts-001 rejects screenshot cleanup without the cron secret", async () => {
  const [missing, wrong] = await Promise.all([
    accept(cleanup().cleanup({ headers: {} }), [401]),
    accept(
      cleanup().cleanup({ headers: { authorization: "Bearer wrong-secret" } }),
      [401],
    ),
  ]);

  const expected = {
    error: { message: "Invalid cron secret", code: "UNAUTHORIZED" },
  };
  expect(missing.body).toStrictEqual(expected);
  expect(wrong.body).toStrictEqual(expected);
});
