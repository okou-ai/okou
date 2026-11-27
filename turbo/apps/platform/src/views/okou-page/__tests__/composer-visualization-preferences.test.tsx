import { screen, waitFor } from "@testing-library/react";
import { test, expect } from "vitest";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
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
function visualizationOptions() {
  return screen.findByRole("region", {
    name: "Visualization options",
  });
}
async function option(name: string) {
  await press(name, await visualizationOptions());
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
async function pending(
  path: string,
  output: "Spreadsheet" | "Presentation" = "Spreadsheet",
) {
  context.mocks.data.userPreferences({ presentationFormat: "pptx" });
  const gate = createDeferredPromise<void>(context.signal);
  const fixture = createTemplateGalleryHelpers(context).mockTemplateChat({
    sendGate: gate.promise,
  });
  await setupPage({
    context,
    path,
    featureSwitches: { [FeatureSwitchKey.PresentationOutputFormat]: true },
  });
  await press("Chart");
  await option(output);
  await option("Bar chart");
  await fill(await findComposerEditor(), first);
  await press("Send");
  const sent = await message(first);
  expect(summary(sent)).toStrictEqual([`${output} · Bar`]);
  return { gate, fixture, sent };
}
test.each(["Spreadsheet", "Presentation"] as const)(
  "composer-visualization-preferences-003 accepting the first %s send consumes only its draft chart choices",
  async (output) => {
    const { gate, fixture, sent } = await pending(
      "/chats/" + THREAD_ID,
      output,
    );
    const draft = await board();
    expect(summary(draft)).toStrictEqual([`${output} · Bar`]);
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
    expect(summary(sent)).toStrictEqual([`${output} · Bar`]);
  },
);

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
    const panel = await visualizationOptions();
    await press("Spreadsheet", panel);
    await press("Website", panel);
    await press("Sankey diagram", panel);
    expect(summary(await board())).toStrictEqual(["Website · Bar, Sankey"]);
    await press("Website", panel);
    await press("Spreadsheet", panel);
    await press("Sankey diagram", panel);
    expect(summary(await board())).toStrictEqual(["Spreadsheet · Bar"]);
    gate.resolve();
    // The prompt's run link appears when the app renders the persisted event.
    await waitFor(() => {
      expect(
        document.querySelector('[data-role="user"][id^="run-"]'),
      ).toHaveTextContent(first);
    });
    expect(fixture.sentMessages[0]).toBeDefined();
    fixture.lifecycle.completeRun("The first chart is ready.");
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
