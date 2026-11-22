import { workflowsCollectionContract } from "@okouai/api-contracts/contracts/workflows";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { expect, test } from "vitest";
import { setupPage, click, fill } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { findComposerEditor } from "./chat-composer-test-helpers.ts";
import {
  findFastControl,
  queryFastControl,
} from "./chat-message-experience-test-helpers.ts";
const context = testContext();
async function openMenu(draft: string, actions: boolean, total = 2) {
  const names =
    total === 2
      ? ["axiom-red", "axiom-status"]
      : Array.from({ length: total }, (_, index) => {
          return "daily-" + (index + 1);
        });
  context.mocks.api(workflowsCollectionContract.composer, ({ respond }) => {
    return respond(
      200,
      names.map((name, i) => {
        return {
          id: "aaaa1000-0000-4000-8000-" + String(i + 1).padStart(12, "0"),
          name,
          displayName: null,
          description: "Workflow for " + name,
        };
      }),
    );
  });
  context.mocks.browser.matchMedia(true);
  await setupPage({
    context,
    path: "/?compose=1",
    featureSwitches: { [FeatureSwitchKey.SlashActions]: actions },
  });
  const editor = await findComposerEditor();
  await fill(editor, draft);
  return editor;
}
function key(editor: HTMLElement, k: string) {
  fireEvent.keyDown(editor, { key: k });
}
async function pointer(name: string) {
  const options = await screen.findAllByText(name, { exact: true });
  const button = options
    .map((label) => {
      return label.closest("button");
    })
    .find(Boolean);
  if (!button) {
    throw new Error("Missing slash action " + name);
  }
  fireEvent.mouseMove(button);
  return button;
}
test.each([
  ["chat-composer-slash-panel-001", "Draft /网站", "Website"],
  ["chat-composer-slash-panel-008", "Draft /", "Presentation"],
] as const)(
  "%s Browse opens the picker from %s and removes only its slash token",
  async (_id, draft, tab) => {
    const editor = await openMenu(draft, false);
    click(await findFastControl("button", "Browse all templates"));
    const dialog = await screen.findByRole("dialog");
    await expect(findFastControl("tab", tab, dialog)).resolves.toBeVisible();
    expect(editor).toHaveTextContent(/^Draft\s*$/);
    expect(queryFastControl("button", "Browse all templates")).toBeNull();
  },
);
test.each([
  ["chat-composer-slash-panel-006", "keyboard", "axiom-status"],
  ["chat-composer-slash-panel-007", "pointer", "axiom-red"],
] as const)(
  "%s The %s owns the selected workflow when hover differs from the active choice",
  async (_id, method, choice) => {
    const editor = await openMenu("Draft /axiom", false);
    const first = await findFastControl("button", /\/axiom-red/);
    const second = await findFastControl("button", /\/axiom-status/);
    key(editor, "ArrowDown");
    await waitFor(() => {
      expect(second).toHaveAttribute("data-active", "true");
    });
    fireEvent.mouseMove(first);
    if (method === "keyboard") {
      key(editor, "Enter");
    } else {
      click(first);
    }
    await waitFor(() => {
      expect(editor).toHaveTextContent("Draft /" + choice);
    });
    expect(editor).toHaveFocus();
    expect(screen.queryByTestId("slash-workflow-menu")).toBeNull();
  },
);
test("chat-composer-slash-actions-003 Hovering Workflows exposes creation and management beside the actions before insertion", async () => {
  const editor = await openMenu("Draft /", true);
  await pointer("Workflows");
  const pane = await screen.findByRole("region", { name: "Workflows" });
  expect(within(pane).getByText("New workflow")).toBeVisible();
  expect(within(pane).getByText("Manage workflows")).toBeVisible();
  click(await findFastControl("button", /\/axiom-status/, pane));
  await waitFor(() => {
    expect(editor).toHaveTextContent("Draft /axiom-status");
  });
  expect(screen.queryByTestId("slash-workflow-menu")).toBeNull();
});
test("chat-composer-slash-actions-005 The Templates flyout opens the Presentation catalog", async () => {
  await openMenu("Draft /", true);
  await pointer("Templates");
  const pane = await screen.findByRole("region", { name: "Templates" });
  expect(within(pane).getByText("Presentation")).toBeVisible();
  click(await findFastControl("button", "Browse all templates", pane));
  const dialog = await screen.findByRole("dialog");
  await expect(
    findFastControl("tab", "Presentation", dialog),
  ).resolves.toBeVisible();
});
test("chat-composer-slash-actions-008 Choosing Every weekday puts the cadence in the editable automation request", async () => {
  const editor = await openMenu("Draft /", true);
  await pointer("Schedule");
  const pane = await screen.findByRole("region", { name: "Schedule" });
  click(await within(pane).findByText("Every weekday"));
  await waitFor(() => {
    expect(editor).toHaveTextContent(/every weekday at 9:00/i);
  });
  expect(editor).toHaveTextContent(/schedule|automation/i);
  expect(screen.queryByTestId("slash-workflow-menu")).toBeNull();
});
test("chat-composer-slash-actions-015 Typing sch selects Schedule and Enter chooses it without a cadence", async () => {
  const editor = await openMenu("Draft /sch", true);
  const row = await screen.findByText("Schedule", { exact: true });
  expect(row.closest("button")).toHaveAttribute("data-active", "true");
  expect(queryFastControl("button", "Model")).toBeNull();
  key(editor, "Enter");
  await waitFor(() => {
    expect(editor).toHaveTextContent(/schedule|automation/i);
  });
  expect(editor).not.toHaveTextContent(/every weekday|9:00/i);
  expect(screen.queryByTestId("slash-workflow-menu")).toBeNull();
  expect(editor).not.toHaveTextContent("/sch");
});
