import { fireEvent, screen, within, waitFor } from "@testing-library/react";
import { expect, test, vi } from "vitest";
import { click } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { composerModelTrigger } from "./chat-composer-test-helpers.ts";
import { findFastControl } from "./chat-message-experience-test-helpers.ts";
import {
  slashMenu,
  move,
  active,
  moveTo,
  closed,
} from "./workflow-menu-navigation-fixtures.ts";
const context = testContext();
test("chat-composer-slash-actions-004 Keyboard selection enters and leaves Workflows before inserting the chosen command", async () => {
  const { editor, panel } = await slashMenu(context, { actions: true });
  moveTo(editor, panel, "Workflows");
  move(editor, "ArrowRight");
  expect(active(panel)).toHaveTextContent("/axiom-red");
  move(editor, "ArrowLeft");
  expect(active(panel)).toHaveTextContent("Workflows");
  expect(editor).toHaveTextContent("Draft /");
  move(editor, "Enter");
  move(editor, "ArrowDown");
  expect(active(panel)).toHaveTextContent("/axiom-status");
  move(editor, "Enter");
  await closed(panel);
  expect(editor).toHaveTextContent("Draft /axiom-status");
});
test("chat-composer-slash-actions-006 The model flyout shows the current selection and switches models without consuming the draft", async () => {
  const { editor, panel } = await slashMenu(context, { actions: true });
  fireEvent.mouseMove(await findFastControl("button", /^Model/, panel));
  const choice = await screen.findByRole("region", { name: "Model" });
  const previous = await findFastControl("button", /Claude Fable 5.1/, choice);
  expect(previous.querySelector("svg.lucide-check")).toBeVisible();
  click(await findFastControl("button", /Claude Sonnet 5/, choice));
  await composerModelTrigger("Claude Sonnet 5");
  await closed(panel);
  expect(editor.textContent?.trim()).toBe("Draft");
});
test("chat-composer-slash-actions-010 Schedule keyboard navigation returns to Schedule before inserting a weekday automation", async () => {
  const { editor, panel } = await slashMenu(context, { actions: true });
  moveTo(editor, panel, "Schedule");
  move(editor, "ArrowRight");
  expect(active(panel)).toHaveTextContent("Every morning");
  move(editor, "ArrowLeft");
  expect(active(panel)).toHaveTextContent("Schedule");
  move(editor, "Enter");
  move(editor, "ArrowDown");
  expect(active(panel)).toHaveTextContent("Every weekday");
  move(editor, "Enter");
  await closed(panel);
  expect(editor).toHaveTextContent(
    /schedul.*automation|automation.*every weekday/i,
  );
  expect(editor).toHaveTextContent("every weekday at 9:00");
});
test("chat-composer-slash-actions-011 Narrow Effort choices replace the root menu until Back restores Model", async () => {
  const { panel } = await slashMenu(context, { actions: true, desktop: false });
  click(await findFastControl("button", /^Effort/, panel));
  await expect(within(panel).findByText("Low")).resolves.toBeVisible();
  expect(within(panel).queryByText("Model")).toBeNull();
  click(await findFastControl("button", /back/i, panel));
  await expect(within(panel).findByText("Model")).resolves.toBeVisible();
  expect(within(panel).queryByText("Low")).toBeNull();
});
function geometry(x: number) {
  return (editor: HTMLElement) => {
    const card = editor.closest<HTMLElement>(
      '[data-slot="chat-composer-card"]',
    )!;
    vi.spyOn(card, "getBoundingClientRect").mockReturnValue(
      new DOMRect(0, 0, 900, 120),
    );
    const rect = new DOMRect(x, 18, 1, 16);
    vi.spyOn(Range.prototype, "getBoundingClientRect").mockReturnValue(rect);
    vi.spyOn(Range.prototype, "getClientRects").mockReturnValue(
      Object.assign([rect], {
        item: (i: number) => {
          return i === 0 ? rect : null;
        },
      }),
    );
  };
}
test("chat-composer-slash-actions-019 A right-half slash places its workflow flyout on the left with reversed arrow navigation", async () => {
  const { editor, panel } = await slashMenu(context, {
    actions: true,
    geometry: geometry(720),
  });
  const root = panel.querySelector('[data-slot="slash-panel"]');
  await waitFor(() => {
    return expect(root).toHaveAttribute("data-side", "end");
  });
  moveTo(editor, panel, "Workflows");
  move(editor, "ArrowLeft");
  expect(active(panel)).toHaveTextContent("/axiom-red");
  expect(root?.querySelector('[data-slot="slash-flyout"]')).toBeVisible();
  move(editor, "ArrowRight");
  expect(active(panel)).toHaveTextContent("Workflows");
});
test("chat-composer-slash-actions-020 A slash at the left of the editor aligns the opened menu with its starting edge", async () => {
  const { panel } = await slashMenu(context, {
    actions: true,
    geometry: geometry(60),
  });
  expect(panel.querySelector('[data-slot="slash-panel"]')).toHaveAttribute(
    "data-side",
    "start",
  );
});
