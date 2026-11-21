import { click, fill, setupPage } from "../../../__tests__/page-helper.ts";
import {
  testContext,
  createTestRuntime,
} from "../../../signals/__tests__/test-helpers.ts";
import { cleanup, screen, waitFor } from "@testing-library/react";
import { test, expect } from "vitest";
import { findAction } from "./connector-integrations-test-helpers.ts";
import {
  captureTemplateSubmission,
  deck,
  presentationPart,
} from "./template-submission-fixtures.ts";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { agentDraftContract } from "@okouai/api-contracts/contracts/agent-draft";
const context = testContext();

const owner = {
  user: {
    id: "test-user-123",
    email: "bingjie@okou.ai",
    fullName: "Presentation owner",
  },
} as const;
const enabled = { [FeatureSwitchKey.PresentationOutputFormat]: true } as const;
async function openPresentation(prompt: string, formatsEnabled = true) {
  const sent = captureTemplateSubmission(context);
  await setupPage({
    context,
    path: "/",
    auth: owner,
    featureSwitches: {
      [FeatureSwitchKey.PresentationOutputFormat]: formatsEnabled,
    },
  });
  const editor = await screen.findByLabelText("Message");
  await fill(editor, prompt);
  click(await findAction("button", "Presentation"));
  const shelf = await screen.findByRole("group", {
    name: "Presentation templates",
  });
  return { editor, sent, shelf };
}
test("presentation-output-format-001 the HTML preference leaves an explicit PPTX request in the message", async () => {
  const prompt = "Our launch deck; use PPTX for this one";
  const { editor, sent, shelf } = await openPresentation(prompt);
  const formats = await screen.findByRole("group", { name: "Output format" });
  await expect(findAction("button", "HTML", formats)).resolves.toHaveAttribute(
    "aria-pressed",
    "true",
  );
  click(await findAction("button", deck.title, shelf));
  await waitFor(() => {
    return expect(editor).toHaveTextContent(deck.title);
  });
  click(await findAction("button", "Send"));
  const parts = (await sent.promise).userMessage?.parts;
  expect(parts).toContainEqual({ type: "text", text: prompt });
  expect(
    parts?.find((p) => {
      return p.type === "template";
    }),
  ).toMatchObject({
    template: {
      type: "presentation",
      selection: { templateId: deck.templateId, outputFormat: "html" },
    },
  });
  const instructions = parts?.find((p) => {
    return p.type === "additional_info";
  })?.text;
  expect(instructions).toContain("Output format: HTML format");
  expect(instructions).toContain(
    "different output format or slide count, the message wins",
  );
});
test("presentation-output-format-003 changing the format after selecting a template sends PPTX", async () => {
  const { editor, sent, shelf } = await openPresentation("Describe our route");
  click(await findAction("button", deck.title, shelf));
  await waitFor(() => {
    return expect(editor).toHaveTextContent(deck.title);
  });
  click(await findAction("button", "PPTX"));
  click(await findAction("button", "Send"));
  const parts = (await sent.promise).userMessage?.parts;
  expect(
    parts?.find((p) => {
      return p.type === "template";
    }),
  ).toMatchObject({
    template: {
      type: "presentation",
      selection: { templateId: deck.templateId, outputFormat: "pptx" },
    },
  });
});
test("presentation-output-format-009 disabled format selection keeps the slide-count defaults", async () => {
  const prompt = "Prepare our deck.";
  const { editor, sent, shelf } = await openPresentation(prompt, false);
  expect(screen.queryByRole("group", { name: "Output format" })).toBeNull();
  click(await findAction("button", deck.title, shelf));
  await waitFor(() => {
    return expect(editor).toHaveTextContent(deck.title);
  });
  click(await findAction("button", "Send"));
  const parts = (await sent.promise).userMessage?.parts;
  expect(parts).toContainEqual({ type: "text", text: prompt });
  const template = parts?.find((p) => {
    return p.type === "template";
  })?.template;
  if (template?.type !== "presentation") {
    throw new Error("Missing sent presentation");
  }
  expect(template.selection.templateId).toBe(deck.templateId);
  expect(template.selection.outputFormat).toBeUndefined();
  const instructions = parts?.find((p) => {
    return p.type === "additional_info";
  })?.text;
  expect(instructions).toContain("Slide count: 8-12");
  expect(instructions).toContain("different slide count, the message wins");
});
test("presentation-output-format-004 changing the format updates the embedded feedback template without losing its note", async () => {
  const sent = captureTemplateSubmission(context);
  const template = presentationPart();
  const note = {
    type: "feedback" as const,
    quote: "Revise the launch deck",
    note: [
      { type: "text" as const, text: "Start with " },
      {
        ...template,
        template: {
          ...template.template,
          selection: {
            ...template.template.selection,
            outputFormat: "html" as const,
          },
        },
      },
      { type: "text" as const, text: " then add results." },
    ],
  };
  context.mocks.api(agentDraftContract.get, ({ respond }) => {
    return respond(200, {
      draftUserMessage: { version: 1, parts: [note] },
      draftAttachments: [],
    });
  });
  await setupPage({
    context,
    path: "/",
    auth: owner,
    featureSwitches: enabled,
  });
  await screen.findByText(/Revise the launch deck/);
  click(await findAction("button", "Presentation"));
  click(await findAction("button", "PPTX"));
  click(await findAction("button", "Send"));
  const feedback = (await sent.promise).userMessage?.parts.find((p) => {
    return p.type === "feedback";
  });
  expect(feedback).toMatchObject({
    quote: note.quote,
    note: [
      note.note[0],
      {
        type: "template",
        template: {
          type: "presentation",
          selection: { templateId: deck.templateId, outputFormat: "pptx" },
        },
      },
      note.note[2],
    ],
  });
});
test("presentation-output-format-005 the saved PPTX format survives a new app and is used for a presentation chart", async () => {
  const sent = captureTemplateSubmission(context);
  const fresh = createTestRuntime(context);
  await setupPage({
    context,
    path: "/",
    auth: owner,
    featureSwitches: enabled,
  });
  click(await findAction("button", "Presentation"));
  click(await findAction("button", "PPTX"));
  await expect(findAction("button", "PPTX")).resolves.toHaveAttribute(
    "aria-pressed",
    "true",
  );
  cleanup();
  await setupPage({
    context: fresh,
    path: "/",
    auth: owner,
    featureSwitches: enabled,
  });
  click(await findAction("button", "Presentation"));
  await expect(findAction("button", "PPTX")).resolves.toHaveAttribute(
    "aria-pressed",
    "true",
  );
  click(await findAction("button", "Remove Presentation"));
  click(await findAction("button", "Chart"));
  const output = await screen.findByRole("group", { name: "Output format" });
  click(await findAction("button", "Presentation", output));
  const nested = await screen.findByRole("group", {
    name: "Presentation format",
  });
  await expect(findAction("button", "PPTX", nested)).resolves.toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await fill(
    await screen.findByLabelText("Message"),
    "Explain our quarterly results",
  );
  click(await findAction("button", "Send"));
  const info = (await sent.promise).userMessage?.parts.find((p) => {
    return p.type === "additional_info";
  })?.text;
  expect(info).toContain("presentation (PPTX format)");
  expect(info).toContain("okou generate presentation --format pptx");
  expect(info).toContain("User-selected output format: presentation");
});
