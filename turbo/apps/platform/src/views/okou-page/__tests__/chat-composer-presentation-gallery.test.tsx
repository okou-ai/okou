import { click, fill, setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { screen, waitFor, within } from "@testing-library/react";
import { test, expect } from "vitest";
import { findAction } from "./connector-integrations-test-helpers.ts";
import userEvent from "@testing-library/user-event";
import {
  captureTemplateSubmission,
  deck,
  serveDeck,
  presentationPart,
} from "./template-submission-fixtures.ts";
import { agentDraftContract } from "@okouai/api-contracts/contracts/agent-draft";
const context = testContext();

test("chat-composer-presentation-gallery-001 Deep dive is persisted with the selected template without sending", async () => {
  const sent = captureTemplateSubmission(context);
  serveDeck(context, "<section data-slide>Revenue</section>");
  const saved = context.mocks.deferred<void>();
  context.mocks.api(agentDraftContract.get, ({ respond }) => {
    return respond(200, {
      draftUserMessage: { version: 1, parts: [presentationPart()] },
      draftAttachments: [],
    });
  });
  context.mocks.api(agentDraftContract.patch, ({ body, respond }) => {
    if (
      body.draftUserMessage?.parts.some((p) => {
        return (
          p.type === "template" &&
          p.template.type === "presentation" &&
          p.template.selection.templateId === deck.templateId &&
          p.template.selection.colorSystemId === "color-system:ocean-deep"
        );
      })
    ) {
      saved.resolve();
    }
    return respond(204);
  });
  await setupPage({ context, path: "/", host: "app.okou.ai" });
  click(await findAction("button", "Presentation"));
  const editor = await screen.findByLabelText("Message");
  await waitFor(() => {
    return expect(editor).toHaveTextContent(deck.title);
  });
  click(await findAction("button", "Preview template " + deck.title));
  const modal = await screen.findByRole("dialog");
  click(await findAction("button", "Deep dive", modal));
  click(await findAction("button", "Use this template", modal));
  await saved.promise;
  expect(editor).toHaveTextContent(deck.title);
  expect(sent.settled()).toBeFalsy();
});
test("chat-composer-presentation-gallery-002 the restored ocean theme reaches the quarterly presentation request", async () => {
  const sent = captureTemplateSubmission(context);
  const part = presentationPart("color-system:ocean-deep");
  const prompt = "Create the quarterly presentation.";
  context.mocks.api(agentDraftContract.get, ({ respond }) => {
    return respond(200, {
      draftUserMessage: {
        version: 1,
        parts: [part, { type: "text", text: prompt }],
      },
      draftAttachments: [],
    });
  });
  await setupPage({ context, path: "/" });
  const editor = await screen.findByLabelText("Message");
  await waitFor(() => {
    return expect(editor).toHaveTextContent(prompt);
  });
  expect(editor).toHaveTextContent(deck.title);
  click(await findAction("button", "Send"));
  const parts = (await sent.promise).userMessage?.parts;
  expect(parts).toContainEqual({ type: "text", text: prompt });
  expect(parts).toContainEqual(
    expect.objectContaining({
      type: "template",
      template: expect.objectContaining({
        selection: expect.objectContaining(part.template.selection),
      }),
    }),
  );
});
test("chat-composer-presentation-gallery-003 selecting an unthemed recommendation sends its default palette", async () => {
  const sent = captureTemplateSubmission(context);
  await setupPage({ context, path: "/" });
  const editor = await screen.findByLabelText("Message");
  const prompt = "Create a presentation with this template.";
  await fill(editor, prompt);
  click(await findAction("button", "Presentation"));
  click(await findAction("button", deck.title));
  await waitFor(() => {
    return expect(editor).toHaveTextContent(deck.title);
  });
  click(await findAction("button", "Send"));
  const parts = (await sent.promise).userMessage?.parts;
  expect(parts).toContainEqual({ type: "text", text: prompt });
  expect(parts).toContainEqual(
    expect.objectContaining({
      type: "template",
      template: expect.objectContaining({
        selection: expect.objectContaining({
          templateId: deck.templateId,
          colorSystemId: deck.colorSystemId,
        }),
      }),
    }),
  );
});
test("chat-composer-presentation-gallery-004 a four-slide preview respects both ends while navigating by mouse and keyboard", async () => {
  serveDeck(
    context,
    ["Plan", "Schedule", "Owners", "Budget"]
      .map((s) => {
        return "<section data-slide>" + s + "</section>";
      })
      .join(""),
  );
  await setupPage({ context, path: "/", host: "app.okou.ai" });
  click(await findAction("button", "Presentation"));
  click(await findAction("button", "Preview template " + deck.title));
  const modal = await screen.findByRole("dialog");
  await within(modal).findByText("1 / 4");
  await expect(
    findAction("button", "Preview previous slide", modal),
  ).resolves.toBeDisabled();
  click(await findAction("button", "Preview next slide", modal));
  await within(modal).findByText("2 / 4");
  const stage = await within(modal).findByRole("group", {
    name: deck.title + " slide preview",
  });
  stage.focus();
  await userEvent.keyboard("{ArrowRight}");
  await within(modal).findByText("3 / 4");
  click(await findAction("button", "Preview slide 4", modal));
  await within(modal).findByText("4 / 4");
  stage.focus();
  await userEvent.keyboard("{ArrowRight}");
  expect(within(modal).getByText("4 / 4")).toBeVisible();
  click(await findAction("button", "Preview previous slide", modal));
  await expect(within(modal).findByText("3 / 4")).resolves.toBeVisible();
  expect(
    within(modal)
      .getByTitle(deck.title + " HTML preview")
      .getAttribute("srcdoc"),
  ).toContain("Owners");
});
