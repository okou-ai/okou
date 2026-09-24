import { modelMenuOption } from "./chat-model-menu-test-helpers.ts";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { agentDraftContract } from "@okouai/api-contracts/contracts/agent-draft";
import { browserContract } from "@okouai/api-contracts/contracts/browser";
import type {
  ChatRunOptionsRequest,
  GenerationTemplateRequest,
  UserMessageDocument,
} from "@okouai/api-contracts/contracts/chat-threads";
import type { UserModelPreferenceResponse } from "@okouai/api-contracts/contracts/user-model-preference";
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
  context,
  queryComposerModelTrigger,
  mockAgent,
  mockBillingCapabilities,
  mockOrgModelRoutes,
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
  const trigger = queryComposerModelTrigger(label);
  if (!trigger) {
    throw new Error(`${label} composer model picker not found`);
  }
  return trigger;
}

/** A slash panel row opens the template picker, and it covers the composer. */
function fastControl(
  role: "button" | "radio" | "tab" | "menuitem",
  label: string,
  container: ParentNode = document,
): HTMLElement {
  const control = queryAllByRoleFast(role, container).find((candidate) => {
    return (
      candidate.getAttribute("aria-label") === label ||
      candidate.textContent?.trim() === label ||
      // A type row in the flyout's rail reads as its type over its model.
      (role === "menuitem" && candidate.textContent?.startsWith(label) === true)
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
  const types = await screen.findByRole("menu", { name: "Models" });
  click(fastControl("menuitem", "Video", types));
  const videoModels = await screen.findByRole("menu", {
    name: "Video models",
  });
  await waitFor(() => {
    expect(modelMenuOption(/Seedance 2\.0/u, videoModels)).toHaveAttribute(
      "aria-checked",
      "true",
    );
  });
  await userEvent.setup({ delay: null }).keyboard("{Escape}");
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

test("A selected video model remains available for an ordinary chat", async () => {
  const submissions = installVideoSubmissionCapture();
  await setupPage({
    context,
    path: `/agents/${AGENT_ID}/chat`,
  });
  await enterVideoMode("Claude Fable 5.1");
  const prompt = "Explain how video models differ.";
  const editor = await enterText(prompt);
  await sendCurrent(editor, prompt);
  await waitFor(() => {
    expect(submissions).toHaveLength(1);
  });
  expect(submissions[0]?.runOptions).toBeUndefined();
  expect(submissions[0]?.userMessage?.parts).not.toContainEqual(
    expect.objectContaining({ type: "additional_info" }),
  );
});

async function restoreTemplateDraft(template: GenerationTemplateRequest) {
  const submissions = installVideoSubmissionCapture();
  context.mocks.api(agentDraftContract.get, ({ respond }) => {
    return respond(200, {
      draftUserMessage: {
        version: 1,
        parts: [
          { type: "text", text: "Continue this video " },
          {
            type: "template",
            titleSnapshot: "Saved style",
            template,
          },
        ],
      },
      draftAttachments: null,
    });
  });
  await setupPage({
    context,
    path: `/agents/${AGENT_ID}/chat`,
    featureSwitches: {
      [FeatureSwitchKey.ComposerTaskChips]: true,
      [FeatureSwitchKey.ComposerSlashTemplatePanel]: true,
    },
  });
  const editor = await screen.findByRole("textbox", { name: "Message" });
  await waitFor(() => {
    expect(editor).toHaveTextContent("Continue this video");
  });
  return { editor, submissions };
}

const RETIRED_TEMPLATES: readonly GenerationTemplateRequest[] = [
  {
    type: "video",
    selection: { stylePresetId: "video-template:epic-grandeur" },
  },
  { type: "video", selection: { stylePresetId: "avatar-template:42" } },
  { type: "intro-video", selection: {} },
];

test.each(RETIRED_TEMPLATES)(
  "A saved $type brief can be edited and sent after template retirement",
  async (template) => {
    const { editor, submissions } = await restoreTemplateDraft(template);
    await userEvent.setup({ delay: null }).type(editor, "with my provider");
    const prompt = "Continue this video with my provider";
    await sendCurrent(editor, prompt);
    await waitFor(() => {
      expect(submissions).toHaveLength(1);
    });
    expect(submissions[0]?.userMessage?.parts).toStrictEqual(
      expect.arrayContaining([{ type: "text", text: prompt }]),
    );
    expect(
      submissions[0]?.userMessage?.parts.some((part) => {
        return part.type === "template";
      }),
    ).toBeFalsy();
  },
);

test("A copied video brief and avatar feedback can be edited and sent", async () => {
  const submissions = installVideoSubmissionCapture();
  await setupPage({ context, path: `/agents/${AGENT_ID}/chat` });
  const editor = await screen.findByRole("textbox", { name: "Message" });
  const prompt = "Reuse the existing script.";
  const quote = "The original opening scene";
  const userMessage: UserMessageDocument = {
    version: 1,
    parts: [
      { type: "text", text: prompt },
      {
        type: "template",
        titleSnapshot: "Epic Grandeur",
        template: {
          type: "video",
          selection: { stylePresetId: "video-template:epic-grandeur" },
        },
      },
      {
        type: "feedback",
        quote,
        note: [
          { type: "text", text: "Keep the introduction." },
          {
            type: "template",
            titleSnapshot: "Avatar presenter",
            template: {
              type: "video",
              selection: { stylePresetId: "avatar-template:42" },
            },
          },
          {
            type: "template",
            titleSnapshot: "Intro video",
            template: { type: "intro-video", selection: {} },
          },
        ],
      },
    ],
  };
  const clipboard = new DataTransfer();
  const payload = encodeURIComponent(
    JSON.stringify({ text: prompt, attachments: [], userMessage }),
  );
  clipboard.setData(
    "text/html",
    `<div data-okou-chat-message="${payload}">${prompt}</div>`,
  );
  clipboard.setData("text/plain", prompt);
  const user = userEvent.setup({ delay: null });
  await user.click(editor);
  await user.paste(clipboard);

  const feedback = await screen.findByRole("textbox", {
    name: "Ask or comment on this quote",
  });
  expect(feedback).toHaveTextContent("Keep the introduction.");
  await user.type(feedback, " Add the product facts.");
  await sendCurrent(editor, prompt);

  await waitFor(() => {
    expect(submissions).toHaveLength(1);
  });
  expect(submissions[0]?.userMessage?.parts).toStrictEqual(
    expect.arrayContaining([
      { type: "text", text: prompt },
      {
        type: "feedback",
        quote,
        note: [
          {
            type: "text",
            text: "Keep the introduction. Add the product facts.",
          },
        ],
      },
    ]),
  );
  expect(
    submissions[0]?.userMessage?.parts.some((part) => {
      return part.type === "template";
    }),
  ).toBeFalsy();
});
