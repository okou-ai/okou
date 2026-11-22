import { screen } from "@testing-library/react";
import { expect, test, vi } from "vitest";
import { testContext } from "../../signals/__tests__/test-helpers.ts";
import { installMockedClerkBootstrap } from "../../__tests__/mock-auth.ts";
import {
  createBootstrapRoot,
  installBootstrapSkeleton,
} from "../../test/bootstrap-skeleton.ts";
import { startPlatformEntrypoint } from "../../lib/platform-entrypoint.ts";
const context = testContext();

test("platform-entrypoint-002 Chrome 138 enters the application and shows the signed-out page", async () => {
  context.mocks.browser.url("https://app.okou.ai/sign-in");
  context.mocks.browser.userAgent(
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/138.0 Safari/537.36",
  );
  vi.stubGlobal("SharedWorker", class {});
  const sdk = context.mocks.clerk();
  sdk.user(null, null);
  sdk.sessionSignedOut(true);
  installMockedClerkBootstrap(context.signal);
  context.mocks.posthog();
  const sentry = context.mocks.sentry();
  const root = createBootstrapRoot();
  installBootstrapSkeleton(context.signal);
  document.body.append(root);
  context.signal.addEventListener(
    "abort",
    () => {
      return root.remove();
    },
    { once: true },
  );
  startPlatformEntrypoint();
  await expect(screen.findByTestId("clerk-sign-in")).resolves.toBeVisible();
  expect(
    sentry.initializations.map((init) => {
      return init.runtime;
    }),
  ).toStrictEqual(["page"]);
  expect(screen.queryByRole("heading", { name: /to continue/i })).toBeNull();
});
