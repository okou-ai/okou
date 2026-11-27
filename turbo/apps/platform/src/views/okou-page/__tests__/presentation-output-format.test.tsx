import { screen, waitFor, within } from "@testing-library/react";
import { expect, test } from "vitest";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { composerDraftContract } from "@okouai/api-contracts/contracts/composer-draft";
import {
  click,
  fill,
  queryAllByRoleFast,
  setupPage,
} from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { findComposerEditor } from "./chat-composer-test-helpers.ts";
import { clickComposerAddMenuItem } from "./chat-composer-add-menu-test-helpers.ts";
import {
  captureTemplateSubmission,
  deck,
  presentationPart,
} from "./template-submission-fixtures.ts";

const context = testContext();
const enabledFeatures = Object.freeze({
  [FeatureSwitchKey.PresentationOutputFormat]: true,
});

function button(name: string, container: ParentNode = document.body) {
  const found = queryAllByRoleFast("button", container).find((candidate) => {
    return (
      (candidate.getAttribute("aria-label") ??
        candidate.textContent?.trim()) === name
    );
  });
  if (!found) {
    throw new Error(`Expected button ${name}`);
  }
  return found;
}

async function selectPresentation() {
  const discovery = await screen.findByRole("group", {
    name: "Explore Okou capabilities",
  });
  click(button("Presentation", discovery));
  await screen.findByRole("combobox", { name: "Slide count" });
}

async function openChart() {
  await clickComposerAddMenuItem("Create");
  const types = screen.getByRole("radiogroup", { name: "Create" });
  const chart = queryAllByRoleFast("radio", types).find((candidate) => {
    return candidate.textContent?.trim() === "Chart";
  });
  if (!chart) {
    throw new Error("Expected Chart type");
  }
  click(chart);
  return await screen.findByRole("region", { name: "Visualization options" });
}

const presentationInstructions = [
  "Create a presentation.",
  "",
  "# Presentation Generation Defaults",
  "The user set these for presentations generated in this run:",
  "- Slide count: 8-12",
  "Where this run's message asks for a different slide count, the message wins.",
].join("\n");

test.each(["html", "pptx"] as const)(
  "A member with a saved %s default submits the selected style and slide count with the original request",
  async (presentationFormat) => {
    context.mocks.data.userPreferences({ presentationFormat });
    const submission = captureTemplateSubmission(context);
    await setupPage({ context, path: "/", featureSwitches: enabledFeatures });
    const editor = await findComposerEditor();
    await selectPresentation();
    const prompt = "Our launch deck; use PPTX for this one";
    await fill(editor, prompt);
    const shelf = screen.getByRole("group", { name: "Presentation templates" });
    click(button(deck.title, shelf));
    click(button("Send"));

    const { userMessage } = await submission.promise;
    expect(userMessage?.parts).toContainEqual({ type: "text", text: prompt });
    expect(
      userMessage?.parts.find((part) => {
        return part.type === "template";
      }),
    ).toStrictEqual(presentationPart());
    expect(userMessage?.parts).toContainEqual({
      type: "additional_info",
      text: presentationInstructions,
    });
  },
);

test.each(["html", "pptx"] as const)(
  "A restored explicit %s template selection keeps its format when sent",
  async (outputFormat) => {
    context.mocks.data.userPreferences({
      presentationFormat: outputFormat === "html" ? "pptx" : "html",
    });
    const part = presentationPart();
    const explicit = {
      ...part,
      template: {
        ...part.template,
        selection: { ...part.template.selection, outputFormat },
      },
    };
    const prompt = "Prepare the quarterly deck";
    context.mocks.api(composerDraftContract.get, ({ respond }) => {
      return respond(200, {
        draftUserMessage: {
          version: 1,
          parts: [explicit, { type: "text", text: prompt }],
        },
        draftAttachments: null,
      });
    });
    const submission = captureTemplateSubmission(context);
    await setupPage({ context, path: "/", featureSwitches: enabledFeatures });
    const editor = await findComposerEditor();
    await waitFor(() => {
      expect(editor).toHaveTextContent(deck.title);
    });
    await selectPresentation();
    click(button("Send"));
    expect((await submission.promise).userMessage?.parts).toStrictEqual([
      { type: "additional_info", text: presentationInstructions },
      explicit,
      { type: "text", text: prompt },
    ]);
  },
);

test("A restored feedback template keeps its explicit format with a different member default", async () => {
  context.mocks.data.userPreferences({ presentationFormat: "pptx" });
  const part = presentationPart();
  const feedback = {
    type: "feedback" as const,
    quote: "Revise the launch deck.",
    note: [
      { type: "text" as const, text: "Use " },
      {
        ...part,
        template: {
          ...part.template,
          selection: {
            ...part.template.selection,
            outputFormat: "html" as const,
          },
        },
      },
      { type: "text" as const, text: " for this revision." },
    ],
  };
  context.mocks.api(composerDraftContract.get, ({ respond }) => {
    return respond(200, {
      draftUserMessage: { version: 1, parts: [feedback] },
      draftAttachments: null,
    });
  });
  const submission = captureTemplateSubmission(context);
  await setupPage({ context, path: "/", featureSwitches: enabledFeatures });
  const editor = await findComposerEditor();
  await waitFor(() => {
    expect(editor).toHaveTextContent(feedback.quote);
  });
  await selectPresentation();
  click(button("Send"));
  expect((await submission.promise).userMessage?.parts).toContainEqual(
    feedback,
  );
});

test.each(["html", "pptx"] as const)(
  "Chart presentation output preserves the selected category and chart with a saved %s default",
  async (presentationFormat) => {
    context.mocks.data.userPreferences({ presentationFormat });
    const submission = captureTemplateSubmission(context);
    await setupPage({ context, path: "/", featureSwitches: enabledFeatures });
    const editor = await findComposerEditor();
    const chart = await openChart();
    const outputs = within(chart).getByRole("group", { name: "Output format" });
    click(button("Presentation", outputs));
    click(button("Bar chart", chart));
    const prompt = "Explain our quarterly results";
    await fill(editor, prompt);
    click(button("Send"));
    const { userMessage } = await submission.promise;
    expect(userMessage?.parts).toStrictEqual([
      {
        type: "additional_info",
        text: [
          "# Visualization",
          "The user wants a visualized result for this run.",
          "- Preferred output format: presentation",
          "- Preferred chart types: bar",
          "Chart selections are preferences, not requirements. Never invent or alter data to force a preferred chart; use another suitable visual treatment when the data does not support one.",
          "Where this run's message asks for a different output or visual treatment, the message wins.",
          "",
          "# Visualization Selection",
          "These are the preferences the user explicitly selected in the composer:",
          "- User-selected output format: presentation",
          "- User-selected chart types: bar",
        ].join("\n"),
      },
      { type: "text", text: prompt },
    ]);
  },
);

test.each(["Website", "Report"] as const)(
  "A saved presentation default preserves the Chart %s output choice",
  async (output) => {
    context.mocks.data.userPreferences({ presentationFormat: "pptx" });
    const submission = captureTemplateSubmission(context);
    await setupPage({ context, path: "/", featureSwitches: enabledFeatures });
    const editor = await findComposerEditor();
    const chart = await openChart();
    const outputs = within(chart).getByRole("group", { name: "Output format" });
    click(button(output, outputs));
    expect(button(output, outputs)).toHaveAttribute("aria-pressed", "true");
    await fill(editor, "Make a dashboard");
    click(button("Send"));
    const instructions = (await submission.promise).userMessage?.parts.find(
      (part) => {
        return part.type === "additional_info";
      },
    );
    expect(instructions?.text).toContain(
      `- Preferred output format: ${output.toLowerCase()}`,
    );
    expect(instructions?.text).toContain(
      `- User-selected output format: ${output.toLowerCase()}`,
    );
  },
);

test("An untagged message submits only the user's request with a saved presentation default", async () => {
  context.mocks.data.userPreferences({ presentationFormat: "pptx" });
  const submission = captureTemplateSubmission(context);
  await setupPage({ context, path: "/", featureSwitches: enabledFeatures });
  const prompt = "哈哈哈";
  await fill(await findComposerEditor(), prompt);
  click(button("Send"));
  const body = await submission.promise;
  expect(body.userMessage?.parts).toStrictEqual([
    { type: "text", text: prompt },
  ]);
  expect(body.prompt).toBe(prompt);
});

test("A chosen template keeps its slide range when format preferences are disabled", async () => {
  context.mocks.data.userPreferences({ presentationFormat: "pptx" });
  const submission = captureTemplateSubmission(context);
  await setupPage({
    context,
    path: "/",
    featureSwitches: { [FeatureSwitchKey.PresentationOutputFormat]: false },
  });
  await selectPresentation();
  const text = "Prepare the intertidal field report";
  await fill(await findComposerEditor(), text);
  const shelf = screen.getByRole("group", { name: "Presentation templates" });
  click(button(deck.title, shelf));
  click(button("Send"));
  const parts = (await submission.promise).userMessage?.parts;
  expect(parts).toContainEqual({ type: "text", text });
  expect(
    parts?.find((part) => {
      return part.type === "template";
    }),
  ).toStrictEqual(presentationPart());
  expect(parts).toContainEqual({
    type: "additional_info",
    text: presentationInstructions,
  });
});
