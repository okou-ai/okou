import { screen, waitFor } from "@testing-library/react";
import { test, expect } from "vitest";
import { click, setupPage, fill } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { createDeferredPromise } from "../../../signals/utils.ts";
import {
  createTemplateGalleryHelpers,
  THREAD_ID,
} from "./chat-composer-template-gallery-test-helpers.ts";
import { findFastControl } from "./chat-message-experience-test-helpers.ts";
import { findComposerEditor } from "./chat-composer-test-helpers.ts";
import { createChatEvent } from "../../../mocks/mock-helpers.ts";
import { clickComposerAddMenuItem } from "./chat-composer-add-menu-test-helpers.ts";
const context = testContext(),
  first = "Plot quarterly revenue",
  second = "Reserve a separate coastal chart";
async function press(name: string, root?: HTMLElement) {
  click(await findFastControl("button", name, root));
}
async function option(name: string) {
  const panel = await screen.findByRole("region", {
    name: "Visualization options",
  });
  await press(name, panel);
}
function holder(element: HTMLElement, selector: string) {
  const node = element.closest(selector);
  if (!(node instanceof HTMLElement)) {
    throw new Error("Missing " + selector);
  }
  return node;
}
function summary(node: HTMLElement) {
  return Array.from(
    node.querySelectorAll("[data-structured-visualization-preferences]"),
  ).map((e) => {
    return e.textContent;
  });
}
async function board() {
  return holder(await findComposerEditor(), '[data-slot="chat-composer-card"]');
}
async function message(text: string) {
  return await waitFor(() => {
    const post = Array.from(
      document.querySelectorAll<HTMLElement>('[data-role="user"]'),
    ).find((row) => {
      return row.textContent?.includes(text);
    });
    if (!post) {
      throw new Error("Missing sent message " + text);
    }
    return post;
  });
}
test("composer-visualization-preferences-001 a read-only chart summary tracks each selected format and chart in order", async () => {
  createTemplateGalleryHelpers(context).mockTemplateChat();
  await setupPage({ context, path: "/" });
  await press("Chart");
  await option("Spreadsheet");
  await option("Bar chart");
  const draft = await board();
  expect(summary(draft)).toStrictEqual(["Spreadsheet · Bar"]);
  const chip = draft.querySelector<HTMLElement>(
    "[data-structured-visualization-preferences]",
  );
  if (!chip) {
    throw new Error("Missing summary");
  }
  click(chip);
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(screen.queryByRole("menu")).toBeNull();
  expect(summary(draft)).toStrictEqual(["Spreadsheet · Bar"]);
  await option("Spreadsheet");
  expect(summary(draft)).toStrictEqual(["Bar"]);
  await option("Sankey diagram");
  expect(summary(draft)).toStrictEqual(["Bar, Sankey"]);
  await option("Line chart");
  expect(summary(draft)).toStrictEqual(["Bar +2"]);
  await option("Bar chart");
  expect(summary(draft)).toStrictEqual(["Sankey, Line"]);
  await option("Line chart");
  await option("Sankey diagram");
  expect(summary(draft)).toStrictEqual([]);
  await expect(findFastControl("button", "Send")).resolves.toBeDisabled();
});
async function pending(path: string) {
  const gate = createDeferredPromise<void>(context.signal);
  const fixture = createTemplateGalleryHelpers(context).mockTemplateChat({
    sendGate: gate.promise,
  });
  await setupPage({ context, path });
  await press("Chart");
  await option("Spreadsheet");
  await option("Bar chart");
  await fill(await findComposerEditor(), first);
  await press("Send");
  const sent = await message(first);
  expect(summary(sent)).toStrictEqual(["Spreadsheet · Bar"]);
  return { gate, fixture, sent };
}
test("composer-visualization-preferences-003 accepting the first send consumes only its draft chart choices", async () => {
  const { gate, fixture, sent } = await pending("/chats/" + THREAD_ID);
  const draft = await board();
  expect(summary(draft)).toStrictEqual(["Spreadsheet · Bar"]);
  gate.resolve();
  await waitFor(() => {
    expect(summary(draft)).toStrictEqual([]);
  });
  fixture.lifecycle.completeRun("Quarterly chart received");
  createChatEvent(THREAD_ID);
  await screen.findByText("Quarterly chart received");
  await fill(await findComposerEditor(), second);
  await press("Send");
  expect(summary(await message(second))).toStrictEqual([]);
  expect(summary(sent)).toStrictEqual(["Spreadsheet · Bar"]);
});

test.each([
  { id: "004", path: "/" },
  { id: "007", path: "/chats/" + THREAD_ID },
])(
  "composer-visualization-preferences-$id a draft edited back to its original options survives the send receipt",
  async ({ path }) => {
    const { gate, fixture } = await pending(path);
    const destination = location.pathname;
    expect(destination).toMatch(/^\/chats\/[a-f0-9-]+$/u);
    expect(fixture.sentMessages).toStrictEqual([]);
    await fill(await findComposerEditor(), second);
    await clickComposerAddMenuItem("Create");
    await screen.findByRole("region", { name: "Visualization options" });
    await option("Spreadsheet");
    await option("Website");
    await option("Sankey diagram");
    expect(summary(await board())).toStrictEqual(["Website · Bar, Sankey"]);
    await option("Website");
    await option("Spreadsheet");
    await option("Sankey diagram");
    expect(summary(await board())).toStrictEqual(["Spreadsheet · Bar"]);
    gate.resolve();
    await waitFor(() => {
      return expect(fixture.sentMessages[0]).toBeDefined();
    });
    fixture.lifecycle.completeRun("The first chart is ready.");
    createChatEvent(destination.slice(7));
    await screen.findByText("The first chart is ready.");
    expect(location.pathname).toBe(destination);
    await expect(findComposerEditor()).resolves.toHaveTextContent(second);
    expect(summary(await message(first))).toStrictEqual(["Spreadsheet · Bar"]);
    expect(summary(await board())).toStrictEqual(["Spreadsheet · Bar"]);
    for (const [label, selected] of [
      ["Spreadsheet", "true"],
      ["Bar chart", "true"],
      ["Sankey diagram", "false"],
    ] as const) {
      await expect(findFastControl("button", label)).resolves.toHaveAttribute(
        "aria-pressed",
        selected,
      );
    }
  },
);
