import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import {
  click,
  fill,
  queryAllByRoleFast,
  setupPage,
} from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { findComposerEditor } from "./chat-composer-test-helpers.ts";
import {
  AGENT_ID,
  createTemplateGalleryHelpers,
} from "./chat-composer-template-gallery-test-helpers.ts";

const context = testContext();
const { mockTemplateChat } = createTemplateGalleryHelpers(context);

function control(
  role: "button" | "radio",
  name: string,
  container: ParentNode = document.body,
): HTMLElement {
  const result = queryAllByRoleFast(role, container).find((candidate) => {
    return (
      (candidate.getAttribute("aria-label") ??
        candidate.textContent?.trim()) === name
    );
  });
  if (!result) {
    throw new Error(`Expected ${role} named ${name}`);
  }
  return result;
}

function composerCard(editor: HTMLElement): HTMLElement {
  const card = editor.closest<HTMLElement>('[data-slot="chat-composer-card"]');
  if (!card) {
    throw new Error("Expected the composer card");
  }
  return card;
}

function outputPicker(options: HTMLElement): HTMLElement {
  return within(options).getByRole("group", { name: "Output format" });
}

function chartPicker(options: HTMLElement): HTMLElement {
  return within(options).getByRole("group", { name: "Preferred charts" });
}

async function expectSummary(
  editor: HTMLElement,
  name: string,
  text: RegExp,
): Promise<HTMLElement> {
  return await waitFor(() => {
    const summary = control("button", name, composerCard(editor));
    expect(summary).toBeInTheDocument();
    expect(
      composerCard(editor).querySelectorAll(
        "[data-structured-visualization-preferences]",
      ),
    ).toHaveLength(1);
    expect(summary).toHaveTextContent(text);
    return summary;
  });
}

async function setupCharts(homeCapabilities = false) {
  const { lifecycle } = mockTemplateChat();
  await setupPage({
    context,
    path: `/agents/${AGENT_ID}/chat?compose=1`,
    auth: {
      user: { id: "test-user-123", fullName: "Test User" },
      organization: {
        activeOrg: {
          id: "org_3ANttyrbWYJk6JKRSTRLEsbsDLe",
          name: "Okou",
        },
        memberships: [],
      },
    },
    featureSwitches: {
      [FeatureSwitchKey.HomeCapabilities]: homeCapabilities,
      [FeatureSwitchKey.SingleAgent]: false,
      [FeatureSwitchKey.ChatMessageVisualizationSummary]: true,
    },
  });
  const editor = await findComposerEditor();
  const choices = await screen.findByRole("group", {
    name: homeCapabilities ? "Explore Okou capabilities" : "Choose a task",
  });
  click(control("button", "Chart", choices));
  const options = await screen.findByRole("region", {
    name: "Visualization options",
  });
  return { editor, options, lifecycle };
}

test("The Charts draft summary follows output and chart choices back to the empty default", async () => {
  const { editor, options } = await setupCharts();
  const outputs = outputPicker(options);
  const charts = chartPicker(options);
  await expectSummary(editor, "Charts", /^Charts$/u);
  expect(
    control("button", "Remove Chart", composerCard(editor)),
  ).toBeInTheDocument();

  click(control("button", "Spreadsheet", outputs));
  await expectSummary(editor, "Spreadsheet", /^Spreadsheet$/u);

  click(control("button", "Bar chart", charts));
  await expectSummary(
    editor,
    "Spreadsheet, Charts: Bar chart",
    /^Spreadsheet · Bar$/u,
  );

  click(control("button", "Spreadsheet", outputs));
  await expectSummary(editor, "Charts: Bar chart", /^Bar$/u);

  click(control("button", "Sankey diagram", charts));
  await expectSummary(
    editor,
    "Charts: Bar chart, Sankey diagram",
    /^Bar, Sankey$/u,
  );
  click(control("button", "Line chart", charts));
  await expectSummary(
    editor,
    "Charts: Bar chart, Sankey diagram, Line chart",
    /^Bar \+2$/u,
  );

  click(control("button", "Bar chart", charts));
  await expectSummary(
    editor,
    "Charts: Sankey diagram, Line chart",
    /^Sankey, Line$/u,
  );
  click(control("button", "Line chart", charts));
  await expectSummary(editor, "Charts: Sankey diagram", /^Sankey$/u);
  click(control("button", "Sankey diagram", charts));
  await expectSummary(editor, "Charts", /^Charts$/u);
});

test("Removing Chart and choosing another task preserves its draft summary for the return", async () => {
  const { editor, options } = await setupCharts();
  const draft = "Keep my quarterly analysis draft.";
  await fill(editor, draft);
  click(control("button", "Spreadsheet", outputPicker(options)));
  await expectSummary(editor, "Spreadsheet", /^Spreadsheet$/u);
  click(control("button", "Bar chart", chartPicker(options)));
  const selection = "Spreadsheet, Charts: Bar chart";
  await expectSummary(editor, selection, /^Spreadsheet · Bar$/u);

  click(control("button", "Remove Chart", composerCard(editor)));
  const choices = await screen.findByRole("group", {
    name: "Choose a task",
  });
  click(control("button", "Image", choices));
  await screen.findByRole("group", { name: "Image styles" });
  expect(
    control("button", "Remove Image", composerCard(editor)),
  ).toBeInTheDocument();
  expect(
    queryAllByRoleFast("button", composerCard(editor)).find((candidate) => {
      return candidate.getAttribute("aria-label") === selection;
    }),
  ).toBeUndefined();
  expect(editor).toHaveTextContent(draft);

  click(control("button", "Remove Image", composerCard(editor)));
  const restoredChoices = await screen.findByRole("group", {
    name: "Choose a task",
  });
  click(control("button", "Chart", restoredChoices));
  const restoredOptions = await screen.findByRole("region", {
    name: "Visualization options",
  });
  await expectSummary(editor, selection, /^Spreadsheet · Bar$/u);
  expect(
    control("button", "Spreadsheet", outputPicker(restoredOptions)),
  ).toHaveAttribute("aria-pressed", "true");
  expect(
    control("button", "Bar chart", chartPicker(restoredOptions)),
  ).toHaveAttribute("aria-pressed", "true");
  expect(editor).toHaveTextContent(draft);
});

test.each([false, true])(
  "A sent Chart draft retains its summary and keyboard editing with HomeCapabilities=%s",
  async (homeCapabilities) => {
    const {
      editor: homeEditor,
      options,
      lifecycle,
    } = await setupCharts(homeCapabilities);
    click(control("button", "Spreadsheet", outputPicker(options)));
    await expectSummary(homeEditor, "Spreadsheet", /^Spreadsheet$/u);
    click(control("button", "Bar chart", chartPicker(options)));
    const selection = "Spreadsheet, Charts: Bar chart";
    await expectSummary(homeEditor, selection, /^Spreadsheet · Bar$/u);
    const prompt = "Compare our quarterly sales.";
    await fill(homeEditor, prompt);
    click(control("button", "Send", composerCard(homeEditor)));

    const chat = await screen.findByRole("region", { name: "Chat thread" });
    const editor = await findComposerEditor();
    await waitFor(() => {
      expect(
        control("button", "Stop", composerCard(editor)),
      ).toBeInTheDocument();
    });
    lifecycle.completeRun("The quarterly comparison is ready.");
    await screen.findByText("The quarterly comparison is ready.");
    await waitFor(() => {
      expect(
        queryAllByRoleFast("button", composerCard(editor)).find((candidate) => {
          return candidate.getAttribute("aria-label") === "Stop";
        }),
      ).toBeUndefined();
    });
    expect(within(chat).getByText(prompt)).toBeInTheDocument();
    const summary = await expectSummary(
      editor,
      selection,
      /^Spreadsheet · Bar$/u,
    );
    expect(
      screen.queryByRole("region", { name: "Visualization options" }),
    ).toBeNull();
    const path = window.location.pathname;
    expect(path).toMatch(/^\/chats\//u);

    const user = userEvent.setup({ delay: null });
    summary.focus();
    await user.keyboard("{Enter}");
    const reopened = await screen.findByRole("dialog", {
      name: "Visualization options",
    });
    expect(
      control("button", "Spreadsheet", outputPicker(reopened)),
    ).toHaveAttribute("aria-pressed", "true");
    expect(
      control("button", "Bar chart", chartPicker(reopened)),
    ).toHaveAttribute("aria-pressed", "true");
    await expectSummary(editor, selection, /^Spreadsheet · Bar$/u);
    expect(
      control("button", "Remove Chart", composerCard(editor)),
    ).toBeInTheDocument();
    expect(within(chat).getByText(prompt)).toBeInTheDocument();
    expect(window.location.pathname).toBe(path);

    click(control("button", "Spreadsheet", outputPicker(reopened)));
    click(control("button", "Line chart", chartPicker(reopened)));
    await expectSummary(
      editor,
      "Charts: Bar chart, Line chart",
      /^Bar, Line$/u,
    );
    expect(
      within(chat).getByRole("group", { name: selection }),
    ).toHaveTextContent("Spreadsheet · Bar");
    await user.keyboard("{Escape}");
    await waitFor(() => {
      expect(
        screen.queryByRole("dialog", { name: "Visualization options" }),
      ).toBeNull();
      expect(
        control(
          "button",
          "Charts: Bar chart, Line chart",
          composerCard(editor),
        ),
      ).toHaveFocus();
    });
  },
);
