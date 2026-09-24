import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { paidToolsContract } from "@okouai/api-contracts/contracts/paid-tools";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { WEBSITE_TEMPLATE_ITEMS } from "@okouai/core/website-template-items";
import {
  click,
  fill,
  queryAllByRoleFast,
  setupPage,
} from "../../../__tests__/page-helper.ts";
import {
  AGENT_ID,
  context,
  mockTemplateChat,
  openTemplatePicker,
} from "./chat-composer-template-gallery-test-helpers.ts";
import { findComposerEditor, tabByText } from "./chat-composer-test-helpers.ts";

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

async function setupComposer(enabled = true, taskChips = false) {
  await setupPage({
    context,
    path: `/agents/${AGENT_ID}/chat`,
    featureSwitches: {
      [FeatureSwitchKey.PaidToolControls]: enabled,
      [FeatureSwitchKey.SettingsToolsTab]: true,
      [FeatureSwitchKey.ChatPreference]: true,
      [FeatureSwitchKey.ComposerSlashTemplatePanel]: true,
      [FeatureSwitchKey.ComposerTaskChips]: taskChips,
    },
  });
  return findComposerEditor();
}

async function selectCreation() {
  const user = userEvent.setup({ delay: null });
  const editor = await screen.findByRole("textbox", { name: "Message" });
  await user.click(editor);
  await user.paste("/");
  const menu = await screen.findByTestId("slash-workflow-menu");
  await userEvent.setup({ delay: null }).click(button("Illustration", menu));
  const dialog = await screen.findByRole("dialog");
  click(within(dialog).getByLabelText("Close"));
  await waitFor(() => {
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
  await screen.findByLabelText("Remove Image");
}

test("Explicit image creation remains blocked when the settings rollout is off", async () => {
  const capture = mockTemplateChat();
  context.mocks.api(paidToolsContract.get, ({ respond }) => {
    return respond(200, { disabledTools: ["image-generation"] });
  });
  const editor = await setupComposer(false);
  await selectCreation();
  await fill(editor, "Create a launch scene");
  expect(screen.queryByText("Open settings")).not.toBeInTheDocument();
  click(button("Send"));
  await screen.findByText("Image generation is off for you");
  expect(capture.runPrompts).toStrictEqual([]);
  expect(editor).toHaveTextContent("Create a launch scene");
});

test("An image creation notice opens settings and a confirmed save restores creation", async () => {
  const capture = mockTemplateChat();
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
  const editor = await setupComposer(true, true);
  click(button("Image", screen.getByRole("group", { name: "Choose a task" })));
  await screen.findByText("Image generation is off for you");
  click(button("Open settings"));
  const dialog = await screen.findByRole("dialog", { name: "Settings" });
  await within(dialog).findByRole("heading", { name: "Tools" });
  const toggle = await within(dialog).findByRole("switch", {
    name: "Image generation",
  });
  await waitFor(() => {
    return expect(toggle).not.toHaveAttribute("aria-disabled", "true");
  });
  click(toggle);
  await waitFor(() => {
    return expect(toggle).toBeChecked();
  });
  click(within(dialog).getByLabelText("Close"));
  await waitFor(() => {
    return expect(
      screen.queryByRole("dialog", { name: "Settings" }),
    ).not.toBeInTheDocument();
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
  const editor = await setupComposer(false);
  await selectCreation();
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

test("Gallery notices follow each paid branch without blocking unrelated previews", async () => {
  mockTemplateChat();
  context.mocks.api(paidToolsContract.get, ({ respond }) => {
    return respond(200, {
      disabledTools: ["image-generation"],
    });
  });
  await setupComposer();
  const dialog = await openTemplatePicker(
    userEvent.setup({ delay: null }),
    "Illustration",
  );
  await within(dialog).findByText("Image generation is off for you");
  click(tabByText("Website"));
  await within(dialog).findByLabelText(
    `Select website template ${WEBSITE_TEMPLATE_ITEMS[0]?.title}`,
  );
  expect(within(dialog).queryByText(/is off for you/)).not.toBeInTheDocument();
});
