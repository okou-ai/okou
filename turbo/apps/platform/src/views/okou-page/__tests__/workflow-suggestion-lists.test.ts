import { screen, within, waitFor } from "@testing-library/react";
import { expect, test } from "vitest";
import { click } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { findFastControl } from "./chat-message-experience-test-helpers.ts";
import {
  slashMenu,
  move,
  active,
  closed,
} from "./workflow-menu-navigation-fixtures.ts";
const context = testContext();
const keyboardCases = [
  {
    id: "chat-composer-slash-panel-015",
    desktop: true,
    key: "ArrowUp",
    workflow: "/axiom-traces",
  },
  {
    id: "chat-composer-slash-panel-016",
    desktop: false,
    key: "ArrowDown",
    workflow: "/axiom-red",
  },
] as const;
test.each(keyboardCases)(
  "$id Five $key presses cross from capabilities to $workflow and Tab inserts it",
  async ({ desktop, key, workflow }) => {
    const { panel, editor } = await slashMenu(context, { desktop });
    for (let i = 0; i < 5; i++) {
      move(editor, key);
    }
    expect(active(panel)).toHaveTextContent(workflow);
    move(editor, "Tab");
    await closed(panel);
    expect(editor).toHaveTextContent("Draft " + workflow);
  },
);
test("chat-composer-slash-panel-023 Manage workflows opens the workflow directory from expanded suggestions", async () => {
  const { panel } = await slashMenu(context, { many: true });
  click(await findFastControl("button", "Show 8 more", panel));
  click(await within(panel).findByText("Manage workflows"));
  await waitFor(() => {
    return expect(location.pathname).toBe("/workflows");
  });
  await closed(panel);
  await expect(
    screen.findByText("Workflows", { selector: "h1,h2" }),
  ).resolves.toBeVisible();
});

test("Expanding the desktop list preserves the draft until its last workflow is selected", async () => {
  const { panel, editor } = await slashMenu(context, { many: true });
  const menu = within(panel);
  const initial = Array.from(panel.querySelectorAll("button"), (el) => {
    return el.textContent?.match(/\/daily-\d+/)?.[0];
  }).filter(Boolean);
  expect(initial).toContain("/daily-1");
  expect(initial).not.toContain("/daily-9");
  const draft = editor.textContent;
  click(await findFastControl("button", "Show 8 more", panel));
  const last = await findFastControl("button", /\/daily-12\b/, panel);
  const nine = await findFastControl("button", /\/daily-9\b/, panel);
  expect(
    nine.compareDocumentPosition(menu.getByText("New workflow")) &
      Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy();
  expect(menu.getByText("Manage workflows")).toBeVisible();
  expect(editor.textContent).toBe(draft);
  click(last);
  await closed(panel);
  expect(editor.textContent).toContain("/daily-12");
});
