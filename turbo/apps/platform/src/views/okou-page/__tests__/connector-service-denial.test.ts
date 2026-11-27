import { slackConnectContract } from "@okouai/api-contracts/contracts/slack-connect";
import { screen } from "@testing-library/react";
import { expect, test } from "vitest";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { startPage } from "../../../__tests__/page-helper.ts";
const context = testContext();
test("fetch-002 An empty connector denial surfaces the thrown HTTP status in the connection page and its notification", async () => {
  const asked = context.mocks.deferred<void>(),
    released = context.mocks.deferred<void>();
  context.mocks.http.get(
    "*" + slackConnectContract.getLinkStatus.path,
    async () => {
      if (!asked.settled()) {
        asked.resolve();
      }
      await released.promise;
      return Response.json(
        { error: { code: "FORBIDDEN", message: "" } },
        { status: 403 },
      );
    },
  );
  const page = await startPage({
    context,
    host: "app.okou.ai",
    path: "/settings/slack?w=T9876&u=U3210",
  });
  await asked.promise;
  expect(screen.queryByText("HTTP 403")).toBeNull();
  released.resolve();
  await page.ready;
  await expect(
    screen.findByText("HTTP 403", { selector: "p" }),
  ).resolves.toBeVisible();
  await expect(
    screen.findByText("HTTP 403", { selector: "[data-title]" }),
  ).resolves.toBeVisible();
});
