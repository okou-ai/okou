import { screen, waitFor, within } from "@testing-library/react";
import { expect, test } from "vitest";
import userEvent from "@testing-library/user-event";
import { instructionsContract } from "@okouai/api-contracts/contracts/instructions";
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
    featureSwitches: { [FeatureSwitchKey.SingleAgent]: true },
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
  expect(
    queryAllByRoleFast("link").some((link) => {
      return link.textContent?.trim() === "My Okou";
    }),
  ).toBeFalsy();
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
    featureSwitches: { [FeatureSwitchKey.SingleAgent]: true },
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

test("A disabled member retains Agents navigation and the legacy management page", async () => {
  await setupPage({
    context,
    path: "/agents",
    featureSwitches: { [FeatureSwitchKey.SingleAgent]: false },
  });
  await screen.findByRole("heading", { name: "Agents" });
  expect(
    queryAllByRoleFast("link").some((link) => {
      return link.textContent?.trim() === "Agents";
    }),
  ).toBeTruthy();
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

test.each(["profile", "instructions"])(
  "Default configuration %s opens personal Instructions",
  async (tab) => {
    context.mocks.api(instructionsContract.get, ({ respond }) => {
      return respond(200, response("Personal value"));
    });
    await setupPage({
      context,
      path: `/agents/c0000000-0000-4000-a000-000000000001?tab=${tab}`,
      featureSwitches: { [FeatureSwitchKey.SingleAgent]: true },
    });
    await waitFor(() => {
      expect(location.pathname).toBe("/");
      expect(location.search).toBe("?settings=my-okou");
    });
    await screen.findByLabelText("Instructions");
  },
);

test("The default authorization link still opens account and permission controls", async () => {
  await setupPage({
    context,
    path: "/agents/c0000000-0000-4000-a000-000000000001?tab=authorization",
    featureSwitches: { [FeatureSwitchKey.SingleAgent]: true },
  });
  await waitFor(() => {
    expect(location.pathname).toBe("/connectors");
  });
  await screen.findByRole("heading", { name: "Connectors" });
});

test("My Okou settings are unavailable when SingleAgent is disabled", async () => {
  await setupPage({
    context,
    path: "/?settings=my-okou",
    featureSwitches: { [FeatureSwitchKey.SingleAgent]: false },
  });
  const dialog = await screen.findByRole("dialog", { name: "Settings" });
  expect(
    within(dialog).getByRole("heading", { name: "Preference" }),
  ).toBeInTheDocument();
  expect(
    queryAllByRoleFast("button", dialog).find((element) => {
      return element.textContent?.trim() === "My Okou";
    }),
  ).toBeUndefined();
  expect(screen.queryByLabelText("Instructions")).not.toBeInTheDocument();
  await waitFor(() => {
    expect(new URLSearchParams(location.search).get("settings")).toBe(
      "preference",
    );
  });
});
