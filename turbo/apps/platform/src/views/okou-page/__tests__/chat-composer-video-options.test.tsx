import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { agentDraftContract } from "@okouai/api-contracts/contracts/agent-draft";
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
  if (chip.getAttribute("aria-expanded") !== "true") {
    click(chip);
  }
  return await screen.findByLabelText("Video options");
}

async function selectToolbarOption(
  label: string,
  value: string,
): Promise<void> {
  click(await screen.findByRole("combobox", { name: label }));
  click(await screen.findByRole("option", { name: value }));
  await waitFor(() => {
    expect(screen.getByRole("combobox", { name: label })).toHaveTextContent(
      value,
    );
  });
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
  "Keep video settings collapsed until requested with Create enabled: %s",
  async (enabled) => {
    installVideoSubmissionCapture();
    await setupPage({
      context,
      path: `/agents/${AGENT_ID}/chat`,
      featureSwitches: { [FeatureSwitchKey.ComposerCreateCommands]: enabled },
    });
    await selectVideoTemplate();
    for (const label of ["Ratio", "Resolution", "Duration"]) {
      expect(screen.getByRole("combobox", { name: label })).toHaveAttribute(
        "aria-expanded",
        "false",
      );
    }
    expect(
      fastControl("button", "Video options 16:9 · 8s · 720p"),
    ).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByLabelText("Video options")).not.toBeInTheDocument();
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
              "- Aspect ratio: 16:9",
              "- Duration: 8s",
              "- Resolution: 720p",
              "- Audio: on",
              "Where this run's message asks for something else, the message wins, for that parameter only.",
            ].join("\n"),
          }
        : undefined,
    );
    expect(submissions[0]?.runOptions).toStrictEqual(
      enabled
        ? undefined
        : {
            video: {
              aspectRatio: "16:9",
              duration: "8s",
              resolution: "720p",
              generateAudio: true,
            },
          },
    );
  },
);

test.each([false, true])(
  "Submit a selected video ratio with Create enabled: %s",
  async (enabled) => {
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
    await selectToolbarOption("Ratio", "9:16");
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
              "- Duration: 8s",
              "- Resolution: 720p",
              "- Audio: on",
              "Where this run's message asks for something else, the message wins, for that parameter only.",
            ].join("\n"),
          }
        : undefined,
    );
    expect(submissions[0]?.runOptions).toStrictEqual(
      enabled
        ? undefined
        : {
            video: {
              aspectRatio: "9:16",
              duration: "8s",
              resolution: "720p",
              generateAudio: true,
            },
          },
    );
    await expect(screen.findByText(prompt)).resolves.toBeVisible();
  },
);

test.each(["task", "command"] as const)(
  "Submit the current model's defaults without a template through the video %s",
  async (entry) => {
    const submissions = installVideoSubmissionCapture();
    await setupPage({
      locale: "en-US",
      context,
      path: `/agents/${AGENT_ID}/chat`,
      featureSwitches: {
        [FeatureSwitchKey.ComposerCreateCommands]: entry === "command",
        [FeatureSwitchKey.ComposerTaskChips]: entry === "task",
      },
    });
    const prompt = "Generate a video without a template.";
    const editor = await enterText(prompt);
    if (entry === "task") {
      click(
        fastControl(
          "button",
          "Video",
          screen.getByRole("group", { name: "Choose a task" }),
        ),
      );
    } else {
      await fill(editor, "/create video");
      await userEvent.setup({ delay: null }).keyboard("{Enter}");
      await enterText(prompt);
    }
    click(await screen.findByRole("combobox", { name: "Video models" }));
    click(await screen.findByRole("option", { name: "MiniMax H3" }));
    await waitFor(() => {
      expect(
        screen.getByRole("combobox", { name: "Resolution" }),
      ).toHaveTextContent("2k");
    });
    await sendCurrent(editor, prompt);
    await waitFor(() => {
      expect(submissions).toHaveLength(1);
    });
    expect(videoTemplatePart(submissions[0]!)).toBeUndefined();
    expect(submissions[0]?.runOptions).toBeUndefined();
    expect(submissions[0]?.userMessage?.parts).toContainEqual({
      type: "additional_info",
      text: [
        "# Video Generation Defaults",
        "The user set these for videos generated in this run:",
        "- Aspect ratio: 16:9",
        "- Duration: 8s",
        "- Resolution: 2k",
        "- Audio: on",
        "Where this run's message asks for something else, the message wins, for that parameter only.",
        "",
        "Create a video.",
      ].join("\n"),
    });
  },
);

test("Selecting a video model alone keeps Creative Video settings hidden and unsent", async () => {
  const submissions = installVideoSubmissionCapture();
  await setupPage({
    context,
    path: `/agents/${AGENT_ID}/chat`,
  });
  await enterVideoMode("Claude Fable 5.1");
  expect(screen.queryByLabelText("Video options")).not.toBeInTheDocument();
  expect(
    queryAllByRoleFast("button").some((button) => {
      return button.getAttribute("aria-label")?.startsWith("Video options ");
    }),
  ).toBeFalsy();
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

test("Changing a Creative Video style retains settings without reopening the panel", async () => {
  installVideoSubmissionCapture();
  await setupPage({ context, path: `/agents/${AGENT_ID}/chat` });
  const editor = await enterText("Keep this scene description");
  await selectVideoTemplate();
  await selectToolbarOption("Ratio", "9:16");
  await selectToolbarOption("Resolution", "1080p");
  await selectToolbarOption("Duration", "10s");
  click(fastControl("button", "Generate audio"));
  expect(fastControl("button", "Generate audio")).toHaveAttribute(
    "aria-pressed",
    "false",
  );
  const summary = fastControl("button", "Video options 9:16 · 10s · 1080p");
  expect(summary).toHaveAttribute("aria-description", "Audio off");
  const edit = composerInlineTemplates()[0]?.querySelector("button");
  if (!edit) {
    throw new Error("Template edit button missing");
  }
  click(edit);
  const dialog = await screen.findByRole("dialog");
  expect(
    queryAllByRoleFast("tab", dialog).map((tab) => {
      return tab.textContent?.trim();
    }),
  ).toStrictEqual(["Video"]);
  await userEvent.setup({ delay: null }).click(tabByText("Video"));
  await userEvent.setup({ delay: null }).keyboard("{End}{ArrowDown}");
  expect(tabByText("Video")).toHaveAttribute("aria-selected", "true");
  const template = VIDEO_TEMPLATE_ITEMS[1]!;
  click(
    fastControl("button", `Select video template ${template.title}`, dialog),
  );
  await waitFor(() => {
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(editor).toHaveTextContent(template.title);
  });
  expect(editor).toHaveTextContent("Keep this scene description");
  expect(screen.queryByLabelText("Video options")).not.toBeInTheDocument();
  expect(
    fastControl("button", "Video options 9:16 · 10s · 1080p"),
  ).toHaveAttribute("aria-description", "Audio off");
  expect(screen.getByRole("combobox", { name: "Ratio" })).toHaveTextContent(
    "9:16",
  );
  expect(
    screen.getByRole("combobox", { name: "Resolution" }),
  ).toHaveTextContent("1080p");
  expect(screen.getByRole("combobox", { name: "Duration" })).toHaveTextContent(
    "10s",
  );
});

async function restoreVideoDraft(stylePresetId: string): Promise<HTMLElement> {
  installVideoSubmissionCapture();
  context.mocks.api(agentDraftContract.get, ({ respond }) => {
    return respond(200, {
      draftUserMessage: {
        version: 1,
        parts: [
          { type: "text", text: "Continue this video " },
          {
            type: "template",
            titleSnapshot: "Saved style",
            template: {
              type: "video",
              selection: { stylePresetId },
            },
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
      [FeatureSwitchKey.IntroVideo]: true,
      [FeatureSwitchKey.ComposerCreateCommands]: true,
      [FeatureSwitchKey.ComposerTaskChips]: true,
    },
  });
  const editor = await screen.findByRole("textbox", { name: "Message" });
  await waitFor(() => {
    expect(editor).toHaveTextContent("Saved style");
  });
  return editor;
}

test("A restored Creative Video draft keeps settings collapsed until requested", async () => {
  await restoreVideoDraft(VIDEO_TEMPLATE_ITEMS[0]!.id);
  expect(
    fastControl("button", "Video options 16:9 · 8s · 720p"),
  ).toHaveAttribute("aria-expanded", "false");
  expect(screen.queryByLabelText("Video options")).not.toBeInTheDocument();
  await expect(openVideoOptions("16:9 · 8s · 720p")).resolves.toBeVisible();
});

test("A legacy Intro Video draft excludes settings even after choosing Create video", async () => {
  await restoreVideoDraft("explainer-video");
  const tasks = screen.getByRole("group", { name: "Choose a task" });
  click(fastControl("button", "Video", tasks));
  expect(screen.queryByLabelText("Video options")).not.toBeInTheDocument();
  expect(
    queryAllByRoleFast("button").some((button) => {
      return button.getAttribute("aria-label")?.startsWith("Video options ");
    }),
  ).toBeFalsy();
});
