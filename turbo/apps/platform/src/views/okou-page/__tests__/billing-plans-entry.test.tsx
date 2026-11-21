import {
  billingStatusContract,
  billingUsagePackMigrationContract,
} from "@okouai/api-contracts/contracts/billing";
import { screen, waitFor, within } from "@testing-library/react";
import { mockChatLifecycle } from "./chat-test-helpers.ts";
import { expect, test } from "vitest";
import { click } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { createDeferredPromise } from "../../../signals/utils.ts";
import {
  action,
  billing,
  findAction,
  openWorkspace,
  packages,
  setBilling,
} from "./workspace-billing-fixtures.ts";
const context = testContext();
const plans = "/?settings=billing&billingView=plans";
const free = billing("limited-free-1");
test("billing-plans-entry-001 Closing the sidebar upgrade returns to chat without opening Settings", async () => {
  setBilling(context, () => {
    return free;
  });
  packages(context);
  const threadId = context.resourceId;
  const prompt = "Review my team's billing.";
  mockChatLifecycle(context, {
    threadId,
    historyEvents: [
      { role: "user", content: prompt, createdAt: "2026-03-10T12:00:00Z" },
    ],
  });
  await openWorkspace(context, "/chats/" + threadId);
  await expect(screen.findByText(prompt)).resolves.toBeInTheDocument();
  click(await screen.findByText("Get Pro"));
  const chooser = await screen.findByRole("dialog", { name: "Choose a plan" });
  click(await action("Close", chooser));
  await waitFor(() => {
    return expect(chooser).not.toBeInTheDocument();
  });
  expect(
    screen.queryByRole("dialog", { name: "Settings" }),
  ).not.toBeInTheDocument();
  expect(
    new URL(window.location.href).searchParams.has("settings"),
  ).toBeFalsy();
});
test("billing-plans-entry-002 A mobile admin opens the chooser from Me", async () => {
  setBilling(context, () => {
    return free;
  });
  packages(context);
  context.mocks.browser.matchMedia(false);
  await openWorkspace(context, "/me");
  await expect(
    screen.findByRole("heading", { name: "Me" }),
  ).resolves.toBeInTheDocument();
  click(await screen.findByText("Get Pro"));
  await expect(
    screen.findByRole("dialog", { name: "Choose a plan" }),
  ).resolves.toBeInTheDocument();
});
test("billing-plans-entry-003 Plan selection precedes catalog availability and survives a round trip from packages", async () => {
  const eligibility = createDeferredPromise<void>(context.signal);
  const catalog = createDeferredPromise<void>(context.signal);
  setBilling(context, () => {
    return free;
  });
  packages(context, catalog.promise);
  context.mocks.api(
    billingUsagePackMigrationContract.get,
    async ({ respond }) => {
      await eligibility.promise;
      return respond(404, {
        error: { code: "NOT_FOUND", message: "No migration" },
      });
    },
  );
  await openWorkspace(context, "/");
  click(await screen.findByText("Get Pro"));
  const pending = await screen.findByRole("dialog", { name: "Billing" });
  expect(within(pending).getByRole("status")).toBeInTheDocument();
  eligibility.resolve();
  const chooser = await screen.findByRole("dialog", { name: "Choose a plan" });
  expect(findAction("Start with Pro", chooser)).toBeUndefined();
  catalog.resolve();
  click(await action("Start with Pro", chooser));
  await expect(screen.findByText("Step 2 of 2")).resolves.toBeInTheDocument();
  click(await action("Back"));
  await expect(screen.findByText("Step 1 of 2")).resolves.toBeInTheDocument();
  await expect(action("Start with Pro")).resolves.toBeEnabled();
  click(await action("Close", chooser));
  await waitFor(() => {
    return expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
});
test("billing-plans-entry-005 Closing during eligibility leaves chat available for a fresh upgrade", async () => {
  const eligibility = createDeferredPromise<void>(context.signal);
  packages(context);
  context.mocks.api(billingStatusContract.get, async ({ respond }) => {
    await eligibility.promise;
    return respond(200, free);
  });
  await openWorkspace(context, plans);
  const pending = await screen.findByRole("dialog", { name: "Billing" });
  expect(within(pending).getByRole("status")).toBeInTheDocument();
  click(await action("Close", pending));
  await waitFor(() => {
    return expect(pending).not.toBeInTheDocument();
  });
  eligibility.resolve();
  const upgrade = await screen.findByText("Get Pro");
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  click(upgrade);
  const chooser = await screen.findByRole("dialog", { name: "Choose a plan" });
  await expect(action("Start with Pro", chooser)).resolves.toBeEnabled();
  expect(within(chooser).getByText("Step 1 of 2")).toBeInTheDocument();
  expect(screen.getAllByRole("dialog")).toHaveLength(1);
});
test("billing-plans-entry-009 Focus stays on Close while the workspace's plan eligibility refreshes", async () => {
  const refresh = createDeferredPromise<void>(context.signal);
  const started = createDeferredPromise<void>(context.signal);
  let refreshing = false;
  packages(context);
  context.mocks.api(billingStatusContract.get, async ({ respond }) => {
    if (!refreshing) {
      return respond(200, free);
    }
    if (!started.settled()) {
      started.resolve();
    }
    await refresh.promise;
    return respond(
      200,
      billing("pro", {
        hasSubscription: false,
        subscriptionStatus: "atom_grant",
      }),
    );
  });
  await openWorkspace(context, plans);
  click(await action("Start with Pro"));
  const config = await screen.findByRole("dialog", {
    name: "Configure member packages",
  });
  await expect(action("Upgrade to Pro", config)).resolves.toBeEnabled();
  const close = await action("Close", config);
  close.focus();
  expect(close).toHaveFocus();
  refreshing = true;
  context.mocks.ably.trigger("billing:changed", {});
  await started.promise;
  expect(config).toHaveTextContent("Step 2 of 2");
  expect(close).toHaveFocus();
  refresh.resolve();
  await expect(
    action("Configure member packages", config),
  ).resolves.toBeEnabled();
  expect(config).toHaveTextContent("Step 2 of 2");
  expect(close).toHaveFocus();
});
