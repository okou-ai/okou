import { screen } from "@testing-library/react";
import { expect, test } from "vitest";
import { testContext } from "../../signals/__tests__/test-helpers.ts";
import { prepareSignedOutDocument } from "./entrypoint-fixture.ts";
import { startPlatformEntrypoint } from "../../lib/platform-entrypoint.ts";
const context = testContext();

test("platform-entrypoint-002 Chrome 138 enters the application and shows the signed-out page", async () => {
  const { sentry } = prepareSignedOutDocument(
    context,
    "https://app.okou.ai/sign-in",
  );
  startPlatformEntrypoint();
  await expect(screen.findByTestId("clerk-sign-in")).resolves.toBeVisible();
  expect(sentry.initializations).toHaveLength(1);
  expect(screen.queryByRole("heading", { name: /to continue/i })).toBeNull();
});
