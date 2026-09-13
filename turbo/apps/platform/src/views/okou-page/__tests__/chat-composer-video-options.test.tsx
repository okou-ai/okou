import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { browserContract } from "@okouai/api-contracts/contracts/browser";
import type {
  ChatRunOptionsRequest,
  UserMessageDocument,
} from "@okouai/api-contracts/contracts/chat-threads";
import type { UserModelPreferenceResponse } from "@okouai/api-contracts/contracts/user-model-preference";
import { VIDEO_TEMPLATE_ITEMS } from "@okouai/core";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { expect, test } from "vitest";

import {
  click,
  fill,
  queryAllByRoleFast,
  setupPage,
} from "../../../__tests__/page-helper.ts";
import { mockChatLifecycle } from "./chat-test-helpers.ts";
import {
  AGENT_ID,
  composerInlineTemplates,
  context,
  mockAgent,
  mockBillingCapabilities,
  mockOrgModelRoutes,
  tabByText,
} from "./chat-composer-test-helpers.ts";

interface SubmittedMessage {
  readonly userMessage?: UserMessageDocument;
  readonly runOptions?: ChatRunOptionsRequest;
}

function installVideoEnvironment(): void {
  const preference: UserModelPreferenceResponse = {
    selectedModel: "claude-fable-5-1",
    serviceTier: null,
    modelSettings: {},
    selectedImageModel: "fal-ai/nano-banana-2",
    selectedVideoModel: "dreamina-seedance-2-0-260128",
    updatedAt: "2026-06-13T00:00:00.000Z",
  };
  context.mocks.browser.matchMedia((query) => {
    return query === "(min-width: 640px)";
  });
  context.mocks.api(browserContract.get, ({ respond }) => {
    return respond(404, {
      error: {
        code: "BROWSER_NOT_FOUND",
        message: "Managed browser not found",
      },
    });
  });
  context.mocks.data.userModelPreference(preference);
  mockAgent();
  mockOrgModelRoutes("claude-fable-5-1");
  mockBillingCapabilities({
    supportByok: true,
    restrictedBuiltInModels: false,
  });
}

function pickerTrigger(label: string): HTMLElement {
  const trigger = screen.queryByRole("combobox", { name: label });
  if (!(trigger instanceof HTMLElement)) {
    throw new Error(`${label} composer model picker not found`);
  }
  return trigger;
}

function fastControl(
  role: "button" | "radio",
  label: string,
  container: ParentNode = document,
): HTMLElement {
  const control = queryAllByRoleFast(role, container).find((candidate) => {
    return (
      candidate.getAttribute("aria-label") === label ||
      candidate.textContent?.trim() === label
    );
  });
  if (!control) {
    throw new Error(`${label} ${role} not found`);
  }
  return control;
}

async function enterVideoMode(triggerLabel: string): Promise<void> {
  await waitFor(() => {
    expect(pickerTrigger(triggerLabel)).toBeInTheDocument();
  });
  click(pickerTrigger(triggerLabel));
  await screen.findByRole("radiogroup", { name: "Models" });
  click(fastControl("radio", "Video"));
  await waitFor(() => {
    expect(fastControl("button", "Seedance 2.0")).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });
  await userEvent.setup({ delay: null }).keyboard("{Escape}");
}

async function openVideoOptions(expectedSpec: string): Promise<HTMLElement> {
  const chip = await waitFor(() => {
    return fastControl("button", `Video options ${expectedSpec}`);
  });
  click(chip);
  return await screen.findByLabelText("Video options");
}

function optionRadio(group: HTMLElement, label: string): HTMLElement {
  const radio = queryAllByRoleFast("radio", group).find((candidate) => {
    return candidate.textContent?.trim() === label;
  });
  if (!radio) {
    throw new Error(`${label} video option not found`);
  }
  return radio;
}

function sendButton(): HTMLElement {
  const send = queryAllByRoleFast("button").find((button) => {
    return button.getAttribute("aria-label") === "Send";
  });
  if (!(send instanceof HTMLElement)) {
    throw new Error("Accessible Send button not found");
  }
  return send;
}

async function enterText(text: string): Promise<HTMLElement> {
  const editor = await screen.findByRole("textbox", { name: "Message" });
  await fill(editor, text);
  await waitFor(() => {
    expect(editor).toHaveTextContent(text);
  });
  return editor;
}

async function sendCurrent(editor: HTMLElement, text: string): Promise<void> {
  const send = await waitFor(() => {
    expect(editor).toHaveTextContent(text);
    const currentSend = sendButton();
    expect(currentSend).toBeEnabled();
    return currentSend;
  });
  click(send);
}

async function selectVideoTemplate(): Promise<
  (typeof VIDEO_TEMPLATE_ITEMS)[number]
> {
  const template = VIDEO_TEMPLATE_ITEMS[0];
  if (!template) {
    throw new Error("Video template catalog is empty");
  }
  click(
    await waitFor(() => {
      return fastControl("button", "Template");
    }),
  );
  await screen.findByRole("dialog");
  click(tabByText("Video"));
  await waitFor(() => {
    expect(
      fastControl("button", `Select video template ${template.title}`),
    ).toBeInTheDocument();
  });
  click(fastControl("button", `Select video template ${template.title}`));
  await waitFor(() => {
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(
      composerInlineTemplates().some((node) => {
        return node.textContent?.includes(template.title);
      }),
    ).toBeTruthy();
  });
  return template;
}

function videoTemplatePart(message: SubmittedMessage) {
  return message.userMessage?.parts.find((part) => {
    return part.type === "template" && part.template.type === "video";
  });
}

function installVideoSubmissionCapture(): SubmittedMessage[] {
  const submissions: SubmittedMessage[] = [];
  installVideoEnvironment();
  mockChatLifecycle(context, {
    onRunCreate: ({ userMessage, runOptions }) => {
      submissions.push({ userMessage, runOptions });
    },
  });

  return submissions;
}

test.each([false, true])(
  "Show default video option controls with Create enabled: %s",
  async (enabled) => {
    installVideoSubmissionCapture();
    await setupPage({
      context,
      path: `/agents/${AGENT_ID}/chat`,
      featureSwitches: { [FeatureSwitchKey.ComposerCreateCommands]: enabled },
    });
    await enterVideoMode("Claude Fable 5.1");
    await selectVideoTemplate();
    await expect(
      openVideoOptions("16:9 · 8s · 720p"),
    ).resolves.toBeInTheDocument();
    await userEvent.setup({ delay: null }).keyboard("{Escape}");
  },
);

test.each([false, true])(
  "Submit default video options with Create enabled: %s",
  async (enabled) => {
    const submissions = installVideoSubmissionCapture();
    await setupPage({
      locale: "en-US",
      context,
      path: `/agents/${AGENT_ID}/chat`,
      featureSwitches: { [FeatureSwitchKey.ComposerCreateCommands]: enabled },
    });

    const prompt = "Generate the first cinematic clip.";
    const editor = await enterText(prompt);
    await enterVideoMode("Claude Fable 5.1");
    const template = await selectVideoTemplate();
    await sendCurrent(editor, prompt);

    await waitFor(() => {
      expect(submissions).toHaveLength(1);
      expect(editor).toHaveTextContent(/^$/u);
      expect(videoTemplatePart(submissions[0]!)).toStrictEqual({
        type: "template",
        titleSnapshot: template.title,
        template: {
          type: "video",
          selection: { stylePresetId: template.id },
        },
      });
      expect(submissions[0]?.runOptions).toBeUndefined();
      expect(submissions[0]?.userMessage?.parts).not.toContainEqual(
        expect.objectContaining({ type: "additional_info" }),
      );
    });
  },
);

test.each([false, true])(
  "Submit a selected video ratio with Create enabled: %s",
  async (enabled) => {
    const user = userEvent.setup({ delay: null });
    const submissions = installVideoSubmissionCapture();
    await setupPage({
      locale: "en-US",
      context,
      path: `/agents/${AGENT_ID}/chat`,
      featureSwitches: { [FeatureSwitchKey.ComposerCreateCommands]: enabled },
    });

    const prompt = "Generate the portrait cinematic clip.";
    const editor = await enterText(prompt);
    await enterVideoMode("Claude Fable 5.1");
    const template = await selectVideoTemplate();
    const options = await openVideoOptions("16:9 · 8s · 720p");
    const ratioGroup = screen.getByRole("radiogroup", { name: "Ratio" });
    expect(options).toContainElement(ratioGroup);
    click(optionRadio(ratioGroup, "9:16"));
    await user.keyboard("{Escape}");
    await sendCurrent(editor, prompt);

    await waitFor(() => {
      expect(submissions).toHaveLength(1);
      expect(editor).toHaveTextContent(/^$/u);
      expect(videoTemplatePart(submissions[0]!)).toStrictEqual({
        type: "template",
        titleSnapshot: template.title,
        template: {
          type: "video",
          selection: { stylePresetId: template.id },
        },
      });
    });
    expect(
      submissions[0]?.userMessage?.parts.find((part) => {
        return part.type === "additional_info";
      }),
    ).toStrictEqual(
      enabled
        ? {
            type: "additional_info",
            text: [
              "# Video Generation Defaults",
              "The user set these for videos generated in this run:",
              "- Aspect ratio: 9:16",
              "Where this run's message asks for something else, the message wins, for that parameter only.",
            ].join("\n"),
          }
        : undefined,
    );
    expect(submissions[0]?.runOptions).toStrictEqual(
      enabled ? undefined : { video: { aspectRatio: "9:16" } },
    );
    await expect(screen.findByText(prompt)).resolves.toBeVisible();
  },
);
