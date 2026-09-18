import { act, screen, waitFor, within } from "@testing-library/react";
import { expect, test } from "vitest";
import { paidToolsContract } from "@okouai/api-contracts/contracts/paid-tools";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import {
  click,
  queryAllByRoleFast,
  setupPage,
} from "../../../__tests__/page-helper.ts";
import { mockedClerk } from "../../../__tests__/mock-auth.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";

const context = testContext();

function button(name: string, container: ParentNode = document.body) {
  const element = queryAllByRoleFast("button", container).find((candidate) => {
    return (
      (candidate.getAttribute("aria-label") ??
        candidate.textContent?.trim()) === name
    );
  });
  if (!element) {
    throw new Error(`Button not found: ${name}`);
  }
  return element;
}

async function openPaidTools(path = "/?settings=paid-tools") {
  context.mocks.data.org({
    id: "org_default",
    name: "Research team",
    role: "member",
  });
  await setupPage({
    context,
    path,
    auth: {
      user: { id: "test-user-123", fullName: "Test User" },
      organization: {
        activeOrg: { id: "org_default", name: "Research team" },
        memberships: [{ id: "org_default" }],
      },
    },
    featureSwitches: {
      [FeatureSwitchKey.PaidToolControls]: true,
      [FeatureSwitchKey.ChatPreference]: false,
    },
  });
  return screen.findByRole("dialog", { name: "Settings" });
}

async function readySwitch(name: string) {
  const toggle = await screen.findByRole("switch", { name });
  await waitFor(() => {
    return expect(toggle).not.toHaveAttribute("aria-disabled", "true");
  });
  return toggle;
}

test("Members open Paid tools independently of Chat preferences and see their workspace scope", async () => {
  const dialog = await openPaidTools("/?settings=preference");
  click(button("Paid tools", dialog));
  const toggle = await readySwitch("Web search");
  expect(toggle).toBeChecked();
  expect(within(dialog).getAllByRole("switch")).toHaveLength(12);
  expect(
    within(dialog).getByText(
      "These settings apply only to you in Research team.",
    ),
  ).toBeInTheDocument();
  expect(
    within(dialog).getByText(/Running tasks and tasks already prepared/),
  ).toBeInTheDocument();
  expect(window.location.search).toContain("settings=paid-tools");
  expect(
    queryAllByRoleFast("button", dialog).some((element) => {
      return element.textContent === "Chat";
    }),
  ).toBeFalsy();
});

test("Disabled rollout hides Paid tools and resolves direct links to Preferences", async () => {
  await setupPage({
    context,
    path: "/?settings=paid-tools",
    featureSwitches: { [FeatureSwitchKey.PaidToolControls]: false },
  });
  const dialog = await screen.findByRole("dialog", { name: "Settings" });
  await within(dialog).findByRole("heading", { name: "Preference" });
  expect(
    within(dialog).queryByRole("switch", { name: "Web search" }),
  ).not.toBeInTheDocument();
  expect(
    queryAllByRoleFast("button", dialog).some((element) => {
      return element.textContent === "Paid tools";
    }),
  ).toBeFalsy();
  expect(window.location.search).toContain("settings=preference");
});

test("Paid tools toggles save inverted enabled state and can re-enable a tool", async () => {
  const updates: { toolId: string; disabled: boolean }[] = [];
  context.mocks.api(paidToolsContract.get, ({ respond }) => {
    return respond(200, { disabledTools: ["web-search"] });
  });
  context.mocks.api(paidToolsContract.update, ({ params, body, respond }) => {
    updates.push({ toolId: params.toolId, disabled: body.disabled });
    return respond(200, { toolId: params.toolId, disabled: body.disabled });
  });
  await openPaidTools();
  const toggle = await readySwitch("Web search");
  expect(toggle).not.toBeChecked();
  click(toggle);
  await waitFor(() => {
    return expect(toggle).toBeChecked();
  });
  await readySwitch("Web search");
  click(toggle);
  await waitFor(() => {
    return expect(toggle).not.toBeChecked();
  });
  expect(updates).toStrictEqual([
    { toolId: "web-search", disabled: false },
    { toolId: "web-search", disabled: true },
  ]);
});

test("A failed load shows no assumed enabled tools and can be retried", async () => {
  let available = false;
  context.mocks.api(paidToolsContract.get, ({ respond }) => {
    return available
      ? respond(200, { disabledTools: ["web-search"] })
      : respond(500, {
          error: {
            message: "Preferences temporarily unavailable",
            code: "INTERNAL_SERVER_ERROR",
          },
        });
  });
  const dialog = await openPaidTools();
  await within(dialog).findByText("Your tool settings could not be loaded.");
  expect(within(dialog).queryByRole("switch")).not.toBeInTheDocument();
  available = true;
  click(button("Retry", dialog));
  await expect(readySwitch("Web search")).resolves.not.toBeChecked();
});

test("A failed save preserves the confirmed value and exposes an explicit retry", async () => {
  let available = false;
  context.mocks.api(paidToolsContract.update, ({ params, body, respond }) => {
    return available
      ? respond(200, { toolId: params.toolId, disabled: body.disabled })
      : respond(500, {
          error: {
            message: "Preference could not be saved",
            code: "INTERNAL_SERVER_ERROR",
          },
        });
  });
  const dialog = await openPaidTools();
  const toggle = await readySwitch("Web search");
  click(toggle);
  await within(dialog).findByText("Your change was not saved.");
  expect(toggle).toBeChecked();
  available = true;
  click(button("Retry", dialog));
  await waitFor(() => {
    return expect(toggle).not.toBeChecked();
  });
  expect(
    within(dialog).queryByText("Your change was not saved."),
  ).not.toBeInTheDocument();
});

test("Saving one tool leaves other tools usable and preserves concurrent results", async () => {
  const release = context.mocks.deferred<void>();
  context.mocks.api(
    paidToolsContract.update,
    async ({ params, body, respond, withSignal }) => {
      if (params.toolId === "web-search") {
        await withSignal(release.promise);
      }
      return respond(200, { toolId: params.toolId, disabled: body.disabled });
    },
  );
  await openPaidTools();
  const web = await readySwitch("Web search");
  const people = await readySwitch("People search");
  click(web);
  await waitFor(() => {
    return expect(web).toHaveAttribute("aria-disabled", "true");
  });
  expect(people).not.toHaveAttribute("aria-disabled", "true");
  click(people);
  await waitFor(() => {
    return expect(people).not.toBeChecked();
  });
  release.resolve();
  await waitFor(() => {
    return expect(web).not.toBeChecked();
  });
  expect(people).not.toBeChecked();
});

test("An in-flight read from the previous workspace cannot populate the next workspace", async () => {
  const oldResponse = context.mocks.deferred<void>();
  const requested = context.mocks.deferred<void>();
  let first = true;
  context.mocks.api(paidToolsContract.get, async ({ respond, withSignal }) => {
    if (first) {
      first = false;
      requested.resolve();
      await withSignal(oldResponse.promise);
      return respond(200, { disabledTools: ["web-search"] });
    }
    return respond(200, { disabledTools: ["people-search"] });
  });
  await openPaidTools();
  await requested.promise;
  expect(
    screen.queryByRole("switch", { name: "Web search" }),
  ).not.toBeInTheDocument();
  act(() => {
    context.mocks.clerk().organization({
      activeOrg: { id: "org_second", name: "Second workspace" },
      memberships: [{ id: "org_second" }],
    });
    context.mocks.clerk().stateChanged();
  });
  await screen.findByText(
    "These settings apply only to you in Second workspace.",
  );
  await expect(readySwitch("People search")).resolves.not.toBeChecked();
  oldResponse.resolve();
  await expect(readySwitch("Web search")).resolves.toBeChecked();
});

test("Dismissing Settings cancels an in-flight save and reopening reads current settings", async () => {
  const release = context.mocks.deferred<void>();
  const started = context.mocks.deferred<void>();
  let disabledTools: string[] = [];
  context.mocks.api(paidToolsContract.get, ({ respond }) => {
    return respond(200, { disabledTools });
  });
  context.mocks.api(
    paidToolsContract.update,
    async ({ params, body, respond, withSignal }) => {
      started.resolve();
      await withSignal(release.promise);
      return respond(200, { toolId: params.toolId, disabled: body.disabled });
    },
  );
  await openPaidTools();
  click(await readySwitch("Web search"));
  await started.promise;
  click(screen.getByLabelText("Close"));
  await waitFor(() => {
    return expect(
      screen.queryByRole("dialog", { name: "Settings" }),
    ).not.toBeInTheDocument();
  });
  disabledTools = ["people-search"];
  release.resolve();
  const rail = await screen.findByTestId("labeled-nav-rail");
  click(within(rail).getByLabelText("Test User"));
  const menu = await screen.findByRole("menu");
  click(within(menu).getByText("Settings"));
  const dialog = await screen.findByRole("dialog", { name: "Settings" });
  click(button("Paid tools", dialog));
  await expect(readySwitch("Web search")).resolves.toBeChecked();
  await expect(readySwitch("People search")).resolves.not.toBeChecked();
});

test("A workspace switch while a save obtains its token prevents sending that save under the new workspace", async () => {
  const tokenRequested = context.mocks.deferred<void>();
  const releaseToken = context.mocks.deferred<void>();
  const updates: string[] = [];
  context.mocks.api(paidToolsContract.update, ({ params, body, respond }) => {
    updates.push(params.toolId);
    return respond(200, { toolId: params.toolId, disabled: body.disabled });
  });
  await openPaidTools();
  const webSearch = await readySwitch("Web search");
  mockedClerk.sessionGetToken.mockImplementationOnce(async () => {
    tokenRequested.resolve();
    await releaseToken.promise;
    return "old-workspace-token";
  });
  click(webSearch);
  await tokenRequested.promise;
  act(() => {
    context.mocks.clerk().organization({
      activeOrg: { id: "org_second", name: "Second workspace" },
      memberships: [{ id: "org_second" }],
    });
    context.mocks.clerk().stateChanged();
  });
  releaseToken.resolve();
  await screen.findByText(
    "These settings apply only to you in Second workspace.",
  );
  await expect(readySwitch("Web search")).resolves.toBeChecked();
  expect(updates).toStrictEqual([]);
});

test("A same-identity Clerk refresh preserves an in-flight save and its confirmed value", async () => {
  const release = context.mocks.deferred<void>();
  const started = context.mocks.deferred<void>();
  context.mocks.api(paidToolsContract.get, ({ respond }) => {
    // A reload before the pending mutation commits would still return enabled.
    return respond(200, { disabledTools: [] });
  });
  context.mocks.api(
    paidToolsContract.update,
    async ({ params, body, respond, withSignal }) => {
      started.resolve();
      await withSignal(release.promise);
      return respond(200, { toolId: params.toolId, disabled: body.disabled });
    },
  );
  await openPaidTools();
  const toggle = await readySwitch("Web search");
  click(toggle);
  await started.promise;
  act(() => {
    context.mocks.clerk().organization({
      activeOrg: { id: "org_default", name: "Renamed research team" },
      memberships: [{ id: "org_default" }],
    });
    context.mocks.clerk().stateChanged();
  });
  await screen.findByText(
    "These settings apply only to you in Renamed research team.",
  );
  expect(screen.getByRole("switch", { name: "Web search" })).toHaveAttribute(
    "aria-disabled",
    "true",
  );
  release.resolve();
  await waitFor(() => {
    return expect(
      screen.getByRole("switch", { name: "Web search" }),
    ).not.toBeChecked();
  });
});
