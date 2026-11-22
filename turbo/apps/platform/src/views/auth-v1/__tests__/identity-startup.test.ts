import { screen, waitFor } from "@testing-library/react";
import { expect, test } from "vitest";

import { installMockedClerkBootstrap } from "../../../__tests__/mock-auth.ts";
import { setupPage, startPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { bootstrapSkeleton } from "../../../test/bootstrap-skeleton.ts";

const context = testContext();
const workflows = {
  context,
  path: "/workflows",
  sharedWorkerTestTransport: "message-port",
} as const;
test("authentication-startup-011 Workflows reuses the identity load already in progress", async () => {
  const sdk = context.mocks.clerk();
  const pending = sdk.runtimePending();
  installMockedClerkBootstrap(context.signal);
  await waitFor(() => {
    return expect(sdk.loads).toHaveLength(1);
  });
  const opening = await startPage(workflows);

  pending.resolve();
  await opening.ready;
  await expect(
    screen.findByRole("heading", { name: "Workflows" }),
  ).resolves.toBeVisible();
  expect(sdk.loads).toHaveLength(1);
  expect(sdk.resourceRequests).toStrictEqual([]);
  expect(sdk.uiRequests).toStrictEqual([]);
});

test("authentication-startup-012 Unavailable identity service replaces the startup screen with an error", async () => {
  const sdk = context.mocks.clerk();

  const failure = new Error("Identity core unavailable during sign-in");
  sdk.resourceUnavailable(failure);
  const opening = await startPage({ context, path: "/sign-in", auth: null });
  await opening.content;
  await expect(screen.findByRole("alert")).resolves.toHaveTextContent(
    "Oops! Something went sideways",
  );
  await expect(opening.ready).rejects.toBe(failure);
  expect(bootstrapSkeleton()).toHaveAttribute("aria-hidden", "true");
  expect(sdk.loads).toStrictEqual([]);
  expect(screen.queryByTestId("clerk-sign-in")).toBeNull();
});

test.each([
  ["authentication-startup-014", "app.okou.ai", "test_production_key"],
  ["authentication-startup-015", "pr-30199-app.omby.ai", "test_preview_key"],
  ["authentication-startup-016", "okou.ai.evil.example", "test_preview_key"],
])("%s opens the hosted sign-in form for %s", async (_id, host, key) => {
  const sdk = context.mocks.clerk();
  await setupPage({ context, path: "/sign-in", host, auth: null });
  await expect(screen.findByTestId("clerk-sign-in")).resolves.toBeVisible();
  expect(sdk.resourceRequests).toStrictEqual([{ publishableKey: key }]);
  expect(sdk.loads).toContainEqual(
    expect.objectContaining({
      signInUrl: new URL("/sign-in", "https://" + host).href,
      signUpUrl: new URL("/sign-up", "https://" + host).href,
    }),
  );
  expect(sdk.uiRequests).toContain(
    document.querySelector<HTMLMetaElement>('meta[name="okou-clerk-ui-script"]')
      ?.content,
  );
});

test("authentication-startup-003 Workflows leaves foreground presence while the tab is hidden and keeps realtime", async () => {
  const tab = context.mocks.browser.visibilityState("visible");
  const realtime = context.mocks.ably;
  const presence = "user-org-foreground:test-user-123:org_default";
  await setupPage(workflows);
  await expect(
    screen.findByRole("heading", { name: "Workflows" }),
  ).resolves.toBeVisible();
  for (const state of ["visible", "hidden", "visible"] as const) {
    tab.changeTo(state);
    await waitFor(() => {
      return expect(realtime.getPresenceCount(presence)).toBe(
        state === "visible" ? 1 : 0,
      );
    });
    expect(
      realtime.hasSubscriptionOnChannel(
        "user:test-user-123",
        "connectorPermissionUpdated",
      ),
    ).toBeTruthy();
  }
});

test("authentication-startup-018 Changing the workspace leaves Workflows for home", async () => {
  const sdk = context.mocks.clerk();
  await setupPage(workflows);
  await expect(
    screen.findByRole("heading", { name: "Workflows" }),
  ).resolves.toBeVisible();
  expect(location.pathname).toBe("/workflows");
  sdk.organization({
    activeOrg: { id: "org_beta", name: "Beta" },
    memberships: [{ id: "org_beta" }],
  });
  sdk.stateChanged();
  await waitFor(() => {
    return expect(location.pathname).toBe("/");
  });
});
