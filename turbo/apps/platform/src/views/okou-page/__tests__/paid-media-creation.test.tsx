import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { paidToolsContract } from "@okouai/api-contracts/contracts/paid-tools";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { VIDEO_TEMPLATE_ITEMS } from "@okouai/core/video-template-items";
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
      [FeatureSwitchKey.ComposerSlashTemplatePanel]: true,
      [FeatureSwitchKey.ComposerTaskChips]: taskChips,
      [FeatureSwitchKey.IntroVideo]: true,
    },
  });
  return findComposerEditor();
}

async function selectCreation(mode: "image" | "video") {
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
  await screen.findByTestId("composer-create-mode");
  if (mode === "video") {
    click(screen.getByRole("combobox", { name: "Choose a type" }));
    click(await screen.findByRole("option", { name: "Video" }));
  }
}

test.each(["image", "video"] as const)(
  "Explicit %s creation remains blocked when the settings rollout is off",
  async (mode) => {
    const capture = mockTemplateChat();
    context.mocks.api(paidToolsContract.get, ({ respond }) => {
      return respond(200, { disabledTools: [`${mode}-generation`] });
    });
    const editor = await setupComposer(false);
    await selectCreation(mode);
    await fill(editor, "Create a launch scene");
    expect(
      screen.queryByText("Open paid tool settings"),
    ).not.toBeInTheDocument();
    click(button("Send"));
    await screen.findByText(
      `${mode === "image" ? "Image" : "Video"} generation is disabled in your paid tool settings.`,
    );
    expect(capture.runPrompts).toStrictEqual([]);
    expect(editor).toHaveTextContent("Create a launch scene");
  },
);

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
  await screen.findByText(
    "Image generation is disabled in your paid tool settings.",
  );
  click(button("Open paid tool settings"));
  const dialog = await screen.findByRole("dialog", { name: "Settings" });
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
      screen.queryByText(
        "Image generation is disabled in your paid tool settings.",
      ),
    ).not.toBeInTheDocument();
  });
  await fill(editor, "Create an image of a launch scene");
  click(button("Send"));
  await waitFor(() => {
    return expect(capture.runPrompts).toHaveLength(1);
  });
});

test("A pending creation check keeps its submitted intent while the picker changes", async () => {
  const capture = mockTemplateChat();
  const requested = context.mocks.deferred<void>();
  const release = context.mocks.deferred<void>();
  context.mocks.api(paidToolsContract.get, async ({ respond, withSignal }) => {
    requested.resolve();
    await withSignal(release.promise);
    return respond(200, { disabledTools: ["video-generation"] });
  });
  const editor = await setupComposer(false);
  await selectCreation("image");
  await fill(editor, "Create a launch scene");
  const send = button("Send");
  click(send);
  await requested.promise;
  await waitFor(() => {
    expect(button("Send")).toBeDisabled();
  });
  click(screen.getByRole("combobox", { name: "Choose a type" }));
  click(await screen.findByRole("option", { name: "Video" }));
  release.resolve();
  await waitFor(() => {
    expect(capture.sentMessages).toHaveLength(1);
  });
  expect(capture.sentMessages[0]?.parts).toContainEqual({
    type: "additional_info",
    text: "Create an image.",
  });
  expect(JSON.stringify(capture.sentMessages[0])).not.toContain(
    "Create a video.",
  );
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
  await selectCreation("image");
  await fill(editor, "Explain the launch plan");
  click(button("Send"));
  await screen.findByText("Tool settings are temporarily unavailable");
  expect(capture.runPrompts).toStrictEqual([]);
  click(button("Exit create mode"));
  click(button("Send"));
  await waitFor(() => {
    return expect(capture.runPrompts).toHaveLength(1);
  });
});

test("Gallery notices follow each paid branch without blocking unrelated previews", async () => {
  mockTemplateChat();
  context.mocks.api(paidToolsContract.get, ({ respond }) => {
    return respond(200, {
      disabledTools: ["image-generation", "avatar-video-generation"],
    });
  });
  await setupComposer();
  const dialog = await openTemplatePicker(
    userEvent.setup({ delay: null }),
    "Illustration",
  );
  await within(dialog).findByText(
    "Image generation is disabled in your paid tool settings.",
  );
  click(tabByText("Avatar"));
  await within(dialog).findByText(
    "Avatar video generation is disabled in your paid tool settings.",
  );
  click(tabByText("Creative video"));
  await within(dialog).findByLabelText(
    `Select video template ${VIDEO_TEMPLATE_ITEMS[0]?.title}`,
  );
  expect(
    within(dialog).queryByText(/is disabled in your paid tool settings/),
  ).not.toBeInTheDocument();
});

test("A selected disabled video template can still be discussed without a Create intent", async () => {
  const capture = mockTemplateChat();
  context.mocks.api(paidToolsContract.get, ({ respond }) => {
    return respond(200, { disabledTools: ["video-generation"] });
  });
  const editor = await setupComposer();
  const dialog = await openTemplatePicker(
    userEvent.setup({ delay: null }),
    "Creative video",
  );
  await within(dialog).findByText(
    "Video generation is disabled in your paid tool settings.",
  );
  click(
    await within(dialog).findByLabelText(
      `Select video template ${VIDEO_TEMPLATE_ITEMS[0]?.title}`,
    ),
  );
  await waitFor(() => {
    return expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
  expect(screen.queryByTestId("composer-create-mode")).not.toBeInTheDocument();
  await userEvent.setup({ delay: null }).click(editor);
  await userEvent
    .setup({ delay: null })
    .keyboard("Explain what this style looks like");
  click(button("Send"));
  await waitFor(() => {
    return expect(capture.runPrompts).toHaveLength(1);
  });
  expect(capture.selectedTemplates).toHaveLength(1);
});

test("A stale workspace preference response never replaces the current owner's notice", async () => {
  mockTemplateChat();
  const firstRequest = context.mocks.deferred<void>();
  const release = context.mocks.deferred<void>();
  let first = true;
  context.mocks.api(paidToolsContract.get, async ({ respond, withSignal }) => {
    if (first) {
      first = false;
      firstRequest.resolve();
      await withSignal(release.promise);
      return respond(200, { disabledTools: ["image-generation"] });
    }
    return respond(200, { disabledTools: ["video-generation"] });
  });
  await setupComposer();
  await selectCreation("image");
  await firstRequest.promise;
  act(() => {
    context.mocks.clerk().organization({
      activeOrg: { id: "org_second", name: "Second workspace" },
      memberships: [{ id: "org_second" }],
    });
    context.mocks.clerk().stateChanged();
  });
  release.resolve();
  await waitFor(() => {
    return expect(
      screen.queryByText("Loading your tool settings…"),
    ).not.toBeInTheDocument();
  });
  expect(
    screen.queryByText(
      "Image generation is disabled in your paid tool settings.",
    ),
  ).not.toBeInTheDocument();
  click(screen.getByRole("combobox", { name: "Choose a type" }));
  click(await screen.findByRole("option", { name: "Video" }));
  await screen.findByText(
    "Video generation is disabled in your paid tool settings.",
  );
});
