import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  isInaccessible,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { paidToolsContract } from "@okouai/api-contracts/contracts/paid-tools";
import { WEBSITE_TEMPLATE_ITEMS } from "@okouai/core/website-template-items";
import {
  click,
  fill,
  queryAllByRoleFast,
  setupPage,
} from "../../../__tests__/page-helper.ts";
import {
  AGENT_ID,
  openTemplatePicker,
  createTemplateGalleryHelpers,
} from "./chat-composer-template-gallery-test-helpers.ts";
import {
  CLAUDE_SUBSCRIPTION_PROVIDER_ID,
  findComposerEditor,
  tabByText,
} from "./chat-composer-test-helpers.ts";
import { buildRunModel } from "./chat-model-builders.ts";

const context = testContext();
const { mockTemplateChat } = createTemplateGalleryHelpers(context);

function button(name: string, root: ParentNode = document.body) {
  const element = queryAllByRoleFast("button", root).find((candidate) => {
    return (
      (candidate.getAttribute("aria-label") ??
        candidate.textContent?.trim()) === name
    );
  });
  if (!element) {
    throw new Error(`Missing button: ${name}`);
  }
  return element;
}

async function setupComposer() {
  await setupPage({
    context,
    path: `/agents/${AGENT_ID}/chat`,
  });
  return findComposerEditor();
}

test("Explicit image creation shows the notice and stays blocked while image generation is off", async () => {
  const capture = mockTemplateChat();
  context.mocks.api(paidToolsContract.get, ({ respond }) => {
    return respond(200, { disabledTools: ["image-generation"] });
  });
  const editor = await setupComposer();
  click(button("Image", screen.getByRole("group", { name: "Choose a task" })));
  await screen.findByText("Image generation is off for you");
  expect(button("Open settings")).toBeInTheDocument();
  await fill(editor, "Create a launch scene");
  click(button("Send"));
  await waitFor(() => {
    return expect(
      screen.getAllByText("Image generation is off for you"),
    ).toHaveLength(2);
  });
  expect(capture.runPrompts).toStrictEqual([]);
  expect(editor).toHaveTextContent("Create a launch scene");
});

test("An image creation notice opens settings and a confirmed save restores creation", async () => {
  const capture = mockTemplateChat();
  context.mocks.data.availableRunModels([
    buildRunModel({
      model: "claude-sonnet-5",
      modelProviderId: CLAUDE_SUBSCRIPTION_PROVIDER_ID,
    }),
  ]);
  const disabled = new Set(["image-generation"]);
  context.mocks.api(paidToolsContract.get, ({ respond }) => {
    return respond(200, { disabledTools: [...disabled] });
  });
  context.mocks.api(paidToolsContract.update, ({ params, body, respond }) => {
    if (body.disabled) {
      disabled.add(params.toolId);
    } else {
      disabled.delete(params.toolId);
    }
    return respond(200, { toolId: params.toolId, disabled: body.disabled });
  });
  const editor = await setupComposer();
  click(button("Image", screen.getByRole("group", { name: "Choose a task" })));
  await screen.findByText("Image generation is off for you");
  click(button("Open settings"));
  const dialog = await screen.findByRole("dialog", { name: "Settings" });
  await within(dialog).findByRole("heading", { name: "Tools" });
  const toggle = await within(dialog).findByLabelText("Image generation");
  expect(toggle).toHaveRole("switch");
  await waitFor(() => {
    expect(isInaccessible(toggle)).toBeFalsy();
    return expect(toggle).not.toHaveAttribute("aria-disabled", "true");
  });
  click(toggle);
  await waitFor(() => {
    return expect(toggle).toBeChecked();
  });
  click(button("Close", dialog));
  await waitFor(() => {
    return expect(dialog).not.toBeInTheDocument();
  });
  await waitFor(() => {
    return expect(
      screen.queryByText("Image generation is off for you"),
    ).not.toBeInTheDocument();
  });
  await fill(editor, "Create an image of a launch scene");
  click(button("Send"));
  await waitFor(() => {
    return expect(capture.runPrompts).toHaveLength(1);
  });
});

test("A failed preference read blocks explicit creation but ordinary chat remains available", async () => {
  const capture = mockTemplateChat();
  context.mocks.api(paidToolsContract.get, ({ respond }) => {
    return respond(500, {
      error: {
        message: "Tool settings are temporarily unavailable",
        code: "INTERNAL_SERVER_ERROR",
      },
    });
  });
  const editor = await setupComposer();
  click(button("Image", screen.getByRole("group", { name: "Choose a task" })));
  await screen.findByLabelText("Remove Image");
  await fill(editor, "Explain the launch plan");
  click(button("Send"));
  await screen.findByText("Tool settings are temporarily unavailable");
  expect(capture.runPrompts).toStrictEqual([]);
  click(button("Remove Image"));
  click(button("Send"));
  await waitFor(() => {
    return expect(capture.runPrompts).toHaveLength(1);
  });
});

test("Gallery notices follow each paid branch for a member using default feature switches", async () => {
  mockTemplateChat();
  context.mocks.api(paidToolsContract.get, ({ respond }) => {
    return respond(200, { disabledTools: ["image-generation"] });
  });
  await setupPage({ context, path: `/agents/${AGENT_ID}/chat` });
  await findComposerEditor();
  const dialog = await openTemplatePicker(
    userEvent.setup({ delay: null }),
    "Image",
  );
  await within(dialog).findByText("Image generation is off for you");
  click(tabByText("Website"));
  await within(dialog).findByLabelText(
    `Select website template ${WEBSITE_TEMPLATE_ITEMS[0]?.title}`,
  );
  expect(within(dialog).queryByText(/is off for you/)).not.toBeInTheDocument();
});
