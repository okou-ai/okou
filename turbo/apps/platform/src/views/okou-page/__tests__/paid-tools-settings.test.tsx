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

async function openPaidTools(path = "/?settings=tools") {
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
      [FeatureSwitchKey.SettingsToolsTab]: true,
      [FeatureSwitchKey.ChatPreference]: true,
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

test("Members manage Paid tools in Tools, separately from Chat", async () => {
  const dialog = await openPaidTools("/?settings=preference");
  click(button("Chat", dialog));
  expect(
    within(dialog).queryByRole("switch", { name: "Web search" }),
  ).not.toBeInTheDocument();
  click(button("Tools", dialog));
  const toggle = await readySwitch("Web search");
  expect(toggle).toBeChecked();
  expect(within(dialog).getAllByRole("switch")).toHaveLength(12);
  expect(
    within(dialog).getByText(
      "These settings apply only to you in Research team.",
    ),
  ).toBeInTheDocument();
  expect(
    within(dialog).getByText(/Tasks already running or prepared/),
  ).toBeInTheDocument();
  expect(window.location.search).toContain("settings=tools");
  expect(
    queryAllByRoleFast("button", dialog).some((element) => {
      return element.textContent === "Tools";
    }),
  ).toBeTruthy();
});

test("Paid tools rollout disabled hides Tools even when its tab switch is on", async () => {
  await setupPage({
    context,
    path: "/?settings=tools",
    featureSwitches: {
      [FeatureSwitchKey.ChatPreference]: true,
      [FeatureSwitchKey.PaidToolControls]: false,
      [FeatureSwitchKey.SettingsToolsTab]: true,
    },
  });
  const dialog = await screen.findByRole("dialog", { name: "Settings" });
  await within(dialog).findByRole("heading", { name: "Preference" });
  expect(button("Chat", dialog)).toBeInTheDocument();
  expect(
    queryAllByRoleFast("button", dialog).some((element) => {
      return element.textContent === "Tools";
    }),
  ).toBeFalsy();
  expect(
    within(dialog).queryByRole("switch", { name: "Web search" }),
  ).not.toBeInTheDocument();
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
  expect(
    within(dialog).queryByRole("switch", { name: "Web search" }),
  ).not.toBeInTheDocument();
  available = true;
  click(button("Retry", dialog));
  await expect(readySwitch("Web search")).resolves.not.toBeChecked();
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
