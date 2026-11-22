import { screen, waitFor, within } from "@testing-library/react";
import { expect, test } from "vitest";
import userEvent from "@testing-library/user-event";
import { instructionsContract } from "@okouai/api-contracts/contracts/instructions";
import { feedContract } from "@okouai/api-contracts/contracts/feed";
import { proactiveSuggestionsContract } from "@okouai/api-contracts/contracts/proactive-suggestions";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import {
  click,
  fill,
  queryAllByRoleFast,
  setupPage,
} from "../../__tests__/page-helper.ts";
import { testContext } from "../../signals/__tests__/test-helpers.ts";

const context = testContext();

function button(name: string) {
  const target = queryAllByRoleFast("button").find((element) => {
    return element.textContent?.trim() === name;
  });
  if (!target) {
    throw new Error(`Missing button ${name}`);
  }
  return target;
}

function response(content: string, version = "opaque-v1") {
  return {
    orgId: "test-org-123",
    userId: "test-user-123",
    content,
    version,
    updatedAt: "2026-11-05T00:00:00Z",
  };
}

async function setupPersonal(content = "Use concise updates") {
  context.mocks.data.org({ role: "member" });
  context.mocks.api(instructionsContract.get, ({ respond }) => {
    return respond(200, response(content));
  });
  await setupPage({
    context,
    path: "/?settings=my-okou",
    featureSwitches: {
      [FeatureSwitchKey.AgentSuggestion]: false,
    },
  });
  return await screen.findByLabelText("Instructions");
}

test("An ordinary enabled member edits personal Instructions and deliberately clears them", async () => {
  let stored = response("Use concise updates");
  context.mocks.api(instructionsContract.update, ({ body, respond }) => {
    expect(body).toStrictEqual({ content: "", ifVersion: "opaque-v1" });
    stored = response(body.content, "opaque-v2");
    return respond(200, stored);
  });
  const editor = await setupPersonal();
  context.mocks.api(instructionsContract.get, ({ respond }) => {
    return respond(200, stored);
  });
  expect(
    screen.getByText("Your instructions for Okou in this workspace"),
  ).toBeInTheDocument();
  expect(screen.getByRole("dialog", { name: "Settings" })).toContainElement(
    editor,
  );
  expect(button("My Okou")).toBeInTheDocument();
  await fill(editor, "");
  const bar = await screen.findByTestId("unsaved-bar");
  click(within(bar).getByTestId("save-button"));
  await screen.findByText("Instructions saved");
  await waitFor(() => {
    expect(screen.getByLabelText("Instructions").textContent).toBe("");
  });
  expect(screen.queryByTestId("unsaved-bar")).not.toBeInTheDocument();
});

test("Discard restores the saved document and save failure retains the retryable local draft", async () => {
  let fails = true;
  let stored = response("Use concise updates");
  context.mocks.api(instructionsContract.update, ({ body, respond }) => {
    if (fails) {
      return respond(500, {
        error: { code: "INTERNAL_SERVER_ERROR", message: "Publication failed" },
      });
    }
    stored = response(body.content, "opaque-v2");
    return respond(200, stored);
  });
  const editor = await setupPersonal();
  context.mocks.api(instructionsContract.get, ({ respond }) => {
    return respond(200, stored);
  });
  await fill(editor, "Unsaved draft");
  click(
    (await screen.findByTestId("unsaved-bar")).querySelector(
      '[data-testid="discard-button"]',
    )!,
  );
  await waitFor(() => {
    expect(screen.getByLabelText("Instructions")).toHaveTextContent(
      "Use concise updates",
    );
  });
  await fill(screen.getByLabelText("Instructions"), "Kept after failure");
  click(button("Save"));
  await screen.findByText(
    "Couldn’t save your instructions. Your draft is kept. Try again.",
  );
  expect(screen.getByLabelText("Instructions")).toHaveTextContent(
    "Kept after failure",
  );
  fails = false;
  click(button("Save"));
  await screen.findByText("Instructions saved");
  await waitFor(() => {
    expect(screen.queryByTestId("unsaved-bar")).not.toBeInTheDocument();
  });
});

test("A concurrent CLI save cannot be overwritten without explicit reload", async () => {
  let stored = response("Use concise updates");
  context.mocks.api(instructionsContract.update, ({ body, respond }) => {
    expect(body.ifVersion).toBe("opaque-v1");
    return respond(409, {
      error: { code: "CONFLICT", message: "Instructions changed" },
    });
  });
  const editor = await setupPersonal();
  await fill(editor, "Local draft to review");
  stored = response("Newer CLI instructions", "opaque-v2");
  context.mocks.api(instructionsContract.get, ({ respond }) => {
    return respond(200, stored);
  });
  click(button("Save"));
  await screen.findByText(/Your saved instructions changed elsewhere/);
  expect(screen.getByLabelText("Instructions")).toHaveTextContent(
    "Local draft to review",
  );
  expect(button("Save")).toBeDisabled();
  click(button("Reload saved instructions"));
  await waitFor(() => {
    expect(screen.getByLabelText("Instructions")).toHaveTextContent(
      "Newer CLI instructions",
    );
  });
});

test("An undone edit cannot hide later CLI instructions", async () => {
  const editor = await setupPersonal();
  await fill(editor, "Temporary edit");
  await screen.findByTestId("unsaved-bar");
  const user = userEvent.setup({ delay: null });
  await user.keyboard("{Control>}z{/Control}");
  await waitFor(() => {
    expect(screen.getByLabelText("Instructions")).toHaveTextContent(
      "Use concise updates",
    );
  });
  context.mocks.api(instructionsContract.get, ({ respond }) => {
    return respond(200, response("Instructions saved by CLI", "opaque-v2"));
  });
  context.mocks.ably.trigger("personalInstructionsChanged");
  await waitFor(() => {
    expect(screen.getByLabelText("Instructions")).toHaveTextContent(
      "Instructions saved by CLI",
    );
  });
  expect(screen.queryByTestId("unsaved-bar")).not.toBeInTheDocument();
});

test("A newer saved version keeps the local draft and offers reload before saving", async () => {
  const editor = await setupPersonal();
  await fill(editor, "Local draft to keep");
  await screen.findByTestId("unsaved-bar");
  context.mocks.api(instructionsContract.get, ({ respond }) => {
    return respond(200, response("Newer saved instructions", "opaque-v2"));
  });
  context.mocks.ably.trigger("personalInstructionsChanged");
  await screen.findByText(/Your saved instructions changed elsewhere/);
  expect(screen.getByLabelText("Instructions")).toHaveTextContent(
    "Local draft to keep",
  );
  expect(button("Save")).toBeDisabled();
  click(button("Reload saved instructions"));
  await waitFor(() => {
    expect(screen.getByLabelText("Instructions")).toHaveTextContent(
      "Newer saved instructions",
    );
  });
  expect(screen.queryByTestId("unsaved-bar")).not.toBeInTheDocument();
});

test("Returning to the tab catches instruction updates missed while away", async () => {
  const visibility = context.mocks.browser.visibilityState("visible");
  await setupPersonal();
  visibility.changeTo("hidden");
  context.mocks.api(instructionsContract.get, ({ respond }) => {
    return respond(200, response("Saved while away", "opaque-v2"));
  });
  visibility.changeTo("visible");
  await waitFor(() => {
    expect(screen.getByLabelText("Instructions")).toHaveTextContent(
      "Saved while away",
    );
  });
});

async function openPersonalSettings() {
  const rail = await screen.findByTestId("labeled-nav-rail");
  click(within(rail).getByLabelText("Test User"));
  const menu = await screen.findByRole("menu");
  click(within(menu).getByText("Settings"));
  await screen.findByRole("dialog", { name: "Settings" });
  click(button("My Okou"));
  return screen.findByLabelText("Instructions");
}

test("Settings navigation and dismissal retain the draft and its original version", async () => {
  const editor = await setupPersonal();
  await fill(editor, "Draft across navigation");
  click(button("Chat"));
  await screen.findByRole("heading", { name: "Chat" });
  click(button("My Okou"));
  await waitFor(() => {
    expect(screen.getByLabelText("Instructions")).toHaveTextContent(
      "Draft across navigation",
    );
  });
  const dialog = screen.getByRole("dialog", { name: "Settings" });
  click(within(dialog).getByLabelText("Close"));
  await waitFor(() => {
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
  await openPersonalSettings();
  expect(screen.getByLabelText("Instructions")).toHaveTextContent(
    "Draft across navigation",
  );
  expect(screen.getByTestId("unsaved-bar")).toBeInTheDocument();
});

test("Fetch failure offers retry without fabricating shared Instructions", async () => {
  context.mocks.api(instructionsContract.get, ({ respond }) => {
    return respond(500, {
      error: { code: "INTERNAL_SERVER_ERROR", message: "Read failed" },
    });
  });
  await setupPage({
    context,
    path: "/?settings=my-okou",
  });
  await screen.findByText("Couldn’t load your instructions. Try again.");
  context.mocks.api(instructionsContract.get, ({ respond }) => {
    return respond(200, response("Personal retry"));
  });
  click(button("Retry"));
  await waitFor(() => {
    expect(screen.getByLabelText("Instructions")).toHaveTextContent(
      "Personal retry",
    );
  });
});

test("Workspace switching isolates drafts and restores the original workspace draft", async () => {
  const clerk = context.mocks.clerk();
  const editor = await setupPersonal();
  await fill(editor, "Alpha local draft");
  click(
    within(screen.getByRole("dialog", { name: "Settings" })).getByLabelText(
      "Close",
    ),
  );
  await waitFor(() => {
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
  context.mocks.api(instructionsContract.get, ({ respond }) => {
    return respond(200, response("Beta personal instructions", "beta-v1"));
  });
  clerk.organization({ activeOrg: { id: "org_beta", name: "Beta" } });
  clerk.stateChanged();
  await screen.findByRole("img", { name: "Beta" });
  await openPersonalSettings();
  await waitFor(() => {
    expect(screen.getByLabelText("Instructions")).toHaveTextContent(
      "Beta personal instructions",
    );
  });
  await fill(screen.getByLabelText("Instructions"), "Beta local draft");
  click(
    within(screen.getByRole("dialog", { name: "Settings" })).getByLabelText(
      "Close",
    ),
  );
  await waitFor(() => {
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
  context.mocks.api(instructionsContract.get, ({ respond }) => {
    return respond(200, response("Use concise updates"));
  });
  clerk.organization({ activeOrg: { id: "org_default", name: "Alpha" } });
  clerk.stateChanged();
  await screen.findByRole("img", { name: "Alpha" });
  await openPersonalSettings();
  await waitFor(() => {
    expect(screen.getByLabelText("Instructions")).toHaveTextContent(
      "Alpha local draft",
    );
  });
});

const proactiveFeatures = {
  [FeatureSwitchKey.AgentSuggestion]: true,
} as const;

test("An Instructions link opens its editor and a later ordinary visit starts on Proactive", async () => {
  context.mocks.api(instructionsContract.get, ({ respond }) => {
    return respond(200, response("Instructions from the welcome link"));
  });
  await setupPage({
    context,
    path: "/?settings=my-okou&focus=instructions",
    featureSwitches: proactiveFeatures,
  });
  const instructions = await screen.findByRole("tabpanel", {
    name: "Instructions",
  });
  const editor = await within(instructions).findByRole("textbox", {
    name: "Instructions",
  });
  expect(editor).toHaveTextContent("Instructions from the welcome link");
  click(button("Chat"));
  await screen.findByRole("heading", { name: "Chat" });
  click(button("My Okou"));
  await screen.findByRole("tabpanel", { name: "Proactive" });
  click(within(screen.getByRole("tablist")).getByText("Instructions"));
  await screen.findByRole("tabpanel", { name: "Instructions" });
  expect(new URLSearchParams(location.search).get("focus")).toBe(
    "instructions",
  );
  const dialog = screen.getByRole("dialog", { name: "Settings" });
  click(within(dialog).getByLabelText("Close"));
  await waitFor(() => {
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
  expect(new URLSearchParams(location.search).get("focus")).toBeNull();
});

test("My Okou opens Proactive first, unifies legacy Suggestions choices, and retains an Instructions draft across tabs", async () => {
  context.mocks.api(instructionsContract.get, ({ respond }) => {
    return respond(200, response("A saved instruction"));
  });
  await setupPage({
    context,
    path: "/?settings=my-okou",
    featureSwitches: proactiveFeatures,
  });
  const panel = within(
    await screen.findByRole("tabpanel", { name: "Proactive" }),
  );
  const offers = await panel.findByRole("switch", { name: "Offers" });
  const mixed = await panel.findByRole("combobox", { name: "Suggestions" });
  expect(mixed).toHaveAccessibleDescription(
    "New cards are on. Hourly checks and daily profile updates are off. Choose one setting for both.",
  );
  click(mixed);
  click(await screen.findByRole("option", { name: "Turn both off" }));
  const suggestions = await panel.findByRole("switch", { name: "Suggestions" });
  await waitFor(() => {
    expect(suggestions).not.toHaveAttribute("aria-disabled", "true");
  });
  expect(suggestions).not.toBeChecked();
  click(suggestions);
  await waitFor(() => {
    expect(panel.getByRole("switch", { name: "Suggestions" })).toBeChecked();
  });
  click(offers);
  await waitFor(() => {
    expect(offers).not.toBeChecked();
  });
  expect(panel.getByRole("switch", { name: "System updates" })).toBeChecked();
  expect(
    panel.getAllByRole("switch").map((control) => {
      return control.getAttribute("aria-label");
    }),
  ).toStrictEqual([
    "Morning brief",
    "Suggestions",
    "What’s new",
    "Offers",
    "System updates",
  ]);
  const [proactiveTab, editorTab] = queryAllByRoleFast(
    "tab",
    screen.getByRole("tablist"),
  );
  expect(proactiveTab).toHaveTextContent("Proactive");
  expect(editorTab).toHaveTextContent("Instructions");
  click(editorTab);
  const editor = await screen.findByRole("textbox", { name: "Instructions" });
  await fill(editor, "Keep this draft");
  click(proactiveTab);
  const restored = await screen.findByRole("switch", { name: "Suggestions" });
  await waitFor(() => {
    expect(restored).toBeChecked();
  });
  click(editorTab);
  const retained = await screen.findByRole("textbox", { name: "Instructions" });
  expect(retained).toHaveTextContent("Keep this draft");
});

test("a member with only hourly checks can opt into new cards without showing a stale mixed state during refresh", async () => {
  const refresh = context.mocks.deferred<void>();
  let initial = true;
  context.mocks.api(feedContract.sources, async ({ respond }) => {
    const suggestions = !initial;
    initial = false;
    if (suggestions) {
      await refresh.promise;
    }
    return respond(200, {
      suggestions,
      whatsNew: true,
      offers: true,
      systemUpdates: true,
    });
  });
  context.mocks.api(proactiveSuggestionsContract.get, ({ respond }) => {
    return respond(200, {
      enabled: true,
      status: "enabled",
      unavailableReason: null,
    });
  });
  await setupPage({
    context,
    path: "/?settings=my-okou",
    featureSwitches: proactiveFeatures,
  });
  const panel = within(
    await screen.findByRole("tabpanel", { name: "Proactive" }),
  );
  const choice = await panel.findByRole("combobox", { name: "Suggestions" });
  expect(choice).toHaveAccessibleDescription(
    "Hourly checks and daily profile updates are on. New cards are off. Choose one setting for both.",
  );
  click(choice);
  click(await screen.findByRole("option", { name: "Turn both on" }));
  try {
    const pending = await panel.findByRole("switch", { name: "Suggestions" });
    expect(pending).toBeChecked();
    expect(pending).toHaveAttribute("aria-disabled", "true");
  } finally {
    refresh.resolve();
  }
  await waitFor(() => {
    expect(
      panel.getByRole("switch", { name: "Suggestions" }),
    ).not.toHaveAttribute("aria-disabled", "true");
  });
});

test("existing morning brief links open the Proactive tab in My Okou", async () => {
  await setupPage({
    context,
    path: "/?settings=preference&focus=morning-brief",
    featureSwitches: proactiveFeatures,
  });
  const panel = await screen.findByRole("tabpanel", { name: "Proactive" });
  const brief = await within(panel).findByRole("switch", {
    name: "Morning brief",
  });
  expect(brief).toBeEnabled();
  click(button("Preference"));
  await screen.findByRole("heading", { name: "Appearance" });
  expect(screen.queryByRole("switch", { name: "Morning brief" })).toBeNull();
  expect(new URLSearchParams(location.search).get("focus")).toBeNull();
});

test("the morning brief link opens Preference when the Suggestions feature switch is off", async () => {
  await setupPage({
    context,
    path: "/?settings=preference&focus=morning-brief",
    featureSwitches: {
      [FeatureSwitchKey.AgentSuggestion]: false,
    },
  });
  const dialog = await screen.findByRole("dialog", { name: "Settings" });
  await within(dialog).findByRole("heading", { name: "Preference" });
  const brief = await within(dialog).findByRole("switch", {
    name: "Morning brief",
  });
  expect(brief).toBeEnabled();
});
