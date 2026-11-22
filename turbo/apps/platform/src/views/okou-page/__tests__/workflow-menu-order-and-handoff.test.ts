import { fireEvent, screen, within, waitFor } from "@testing-library/react";
import { expect, test } from "vitest";
import { click, fill } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  slashMenu,
  move,
  moveTo,
  active,
  closed,
} from "./workflow-menu-navigation-fixtures.ts";
import { composerInlineTemplates } from "./chat-composer-test-helpers.ts";
const context = testContext();
function labels(panel: HTMLElement) {
  return [...panel.querySelectorAll("button")].map((b) => {
    return b.textContent?.trim() ?? "";
  });
}
const names = ["Find people", "Research", "Create", "Workflow"] as const;
test("chat-composer-slash-panel-013 Workflows lead the desktop list above the composer while upward navigation reaches Find people then Research", async () => {
  const { panel, editor } = await slashMenu(context);
  const rows = labels(panel);
  expect(
    rows.slice(0, 3).every((s) => {
      return s.startsWith("/axiom-");
    }),
  ).toBeTruthy();
  expect(
    rows.slice(3, 7).map((s, i) => {
      return s.startsWith([...names].reverse()[i]!);
    }),
  ).toStrictEqual([true, true, true, true]);
  expect(rows.at(-1)).toBe("Browse all templates");
  expect(panel.closest("[data-side]")).toHaveAttribute("data-side", "top");
  move(editor, "ArrowUp");
  expect(active(panel)).toHaveTextContent("Find people");
  move(editor, "ArrowUp");
  expect(active(panel)).toHaveTextContent("Research");
});
test("chat-composer-slash-panel-020 The desktop workflow expander waits for activation, resets on reopening and disappears during search", async () => {
  const { panel, editor } = await slashMenu(context, { many: true });
  moveTo(editor, panel, "Show 8 more");
  expect(active(panel)).toHaveTextContent("Show 8 more");
  expect(within(panel).queryByText("daily-9", { exact: true })).toBeNull();
  move(editor, "Enter");
  await expect(
    within(panel).findByText("daily-9", { exact: true }),
  ).resolves.toBeVisible();
  moveTo(editor, panel, "/daily-2");
  expect(active(panel)).toHaveTextContent("/daily-2");
  moveTo(editor, panel, "/daily-3");
  move(editor, "Tab");
  await closed(panel);
  expect(editor).toHaveTextContent("/daily-3");
  await fill(editor, "Fresh /");
  const fresh = await screen.findByTestId("slash-workflow-menu");
  await expect(within(fresh).findByText("Show 8 more")).resolves.toBeVisible();
  move(editor, "Escape");
  await closed(fresh);
  await fill(editor, "Fresh /daily");
  const results = await screen.findByTestId("slash-workflow-menu");
  const matches = labels(results).filter((s) => {
    return s.startsWith("/daily-");
  });
  expect(matches.length).toBeGreaterThan(0);
  expect(
    matches.every((s) => {
      return s.includes("daily");
    }),
  ).toBeTruthy();
  expect(within(results).queryByText("Show 8 more")).toBeNull();
  expect(within(results).queryByText("New workflow")).toBeNull();
});
test("chat-composer-slash-panel-024 Website stays selected as the pointer moves onto the cover inserted into the focused draft", async () => {
  const path = "/chats/b0000000-0000-4000-a000-000000000900";
  const { panel, editor } = await slashMenu(context, { actions: true });
  expect(location.pathname).toBe(path.split("?")[0]);
  const templates = await within(panel).findByText("Templates", {
    exact: true,
  });
  fireEvent.mouseMove(templates);
  const website = await waitFor(() => {
    const el = within(panel).queryByText("Website", { exact: true });
    if (!el) {
      throw new Error("Template actions: " + labels(panel).join(" | "));
    }
    return el;
  });
  fireEvent.mouseMove(website);
  const cover = await waitFor(() => {
    const b = panel.querySelector<HTMLButtonElement>(
      '[data-slot="slash-template-cover"]',
    );
    expect(b).toBeVisible();
    return b!;
  });
  const title = cover
    .getAttribute("aria-label")!
    .replace(/^Use (?:template )?/i, "");
  fireEvent.mouseLeave(website, { relatedTarget: cover });
  fireEvent.mouseEnter(cover, { relatedTarget: website });
  fireEvent.mouseMove(cover);
  expect(website.closest("button")).toHaveAttribute("aria-pressed", "true");
  click(cover);
  await closed(panel);
  expect(composerInlineTemplates()).toHaveLength(1);
  expect(composerInlineTemplates()[0]).toHaveTextContent(title);
  expect(editor).toHaveFocus();
  expect(editor).toHaveTextContent("Draft");
  expect(editor.textContent).not.toContain("/");
  expect(screen.queryByRole("dialog")).toBeNull();
});
