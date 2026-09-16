import { agentDraftContract } from "@okouai/api-contracts/contracts/agent-draft";
import {
  introVideoPresenterContract,
  type IntroVideoStyle,
  type IntroVideoAvatar,
} from "@okouai/api-contracts/contracts/intro-video-presenter";
import { webFilesContract } from "@okouai/api-contracts/contracts/web-files";
import { featureSwitchesContract } from "@okouai/api-contracts/contracts/feature-switches";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import {
  click,
  queryAllByRoleFast,
  setupPage,
  startPage,
} from "../../../__tests__/page-helper.ts";
import { createDeferredPromise } from "../../../signals/utils.ts";
import {
  AGENT_ID,
  context,
  expectInlineTemplate,
  mockPlayableMedia,
  mockTemplateChat,
  openTemplatePicker,
  sendComposerMessage,
} from "./chat-composer-template-gallery-test-helpers.ts";

const STYLES: readonly IntroVideoStyle[] = [
  {
    id: "minimalism",
    name: "Minimalism",
    tags: ["iconic-artist"],
    aspectRatio: "16:9",
    thumbnailUrl: "https://files.example.test/minimalism.png",
    previewVideoUrl: "https://files.example.test/minimalism.mp4",
  },
  {
    id: "watercolor",
    name: "Watercolor",
    tags: ["handmade"],
    aspectRatio: "16:9",
  },
  { id: "cinema", name: "Cinema", tags: ["cinematic"], aspectRatio: "16:9" },
];
const AVATAR: Readonly<IntroVideoAvatar> = {
  id: "daphne-grey",
  groupId: "daphne",
  name: "Daphne in Grey blazer",
  defaultVoiceId: "daphne-voice",
  defaultVoiceName: "Daphne - Warm & Friendly",
  defaultVoiceSampleUrl: "https://files.example.test/daphne-voice.mp3",
  previewImageUrl: "https://files.example.test/daphne.png",
};
const VOICE = Object.freeze({
  id: "annie",
  name: "Annie",
  language: "English",
  gender: "female" as const,
  sampleUrl: "https://files.example.test/annie.mp3",
});
/** HeyGen lists some voices under a second id that plays the same sample. */
const VOICE_TWIN = Object.freeze({ ...VOICE, id: "annie-second-id" });

function installCatalogs() {
  const capture = mockTemplateChat();
  context.mocks.api(introVideoPresenterContract.styles, ({ respond }) => {
    return respond(200, {
      styles: [...STYLES],
      hasMore: false,
      nextToken: null,
    });
  });
  context.mocks.api(introVideoPresenterContract.avatars, ({ respond }) => {
    return respond(200, {
      avatars: [
        AVATAR,
        { ...AVATAR, id: "daphne-blue", name: "Daphne in Blue shirt" },
      ],
      hasMore: false,
      nextToken: null,
    });
  });
  context.mocks.api(introVideoPresenterContract.voices, ({ respond }) => {
    return respond(200, {
      voices: [VOICE, VOICE_TWIN],
      hasMore: false,
      nextToken: null,
    });
  });
  return capture;
}

function control(
  name: string,
  root: ParentNode = document.body,
  role: "button" | "tab" = "button",
) {
  const items = queryAllByRoleFast(role, root);
  const found =
    items.find((item) => {
      return item.getAttribute("aria-label") === name;
    }) ??
    items.find((item) => {
      return item.textContent?.trim() === name;
    });
  if (!found) {
    throw new Error(`Missing ${role}: ${name}`);
  }
  return found;
}

async function openIntroVideo() {
  const user = userEvent.setup({ delay: null });
  await setupPage({
    context,
    path: `/agents/${AGENT_ID}/chat`,
    featureSwitches: { [FeatureSwitchKey.IntroVideo]: true },
  });
  const dialog = await openTemplatePicker(user);
  expect(control("Creative video", dialog, "tab")).toBeVisible();
  click(control("Intro video", dialog, "tab"));
  await within(dialog).findByText("Minimalism");
  return { user, dialog };
}

test.each([
  `/agents/${AGENT_ID}/chat`,
  `/agents/${AGENT_ID}/chat?templatePicker=intro-video`,
  "/?templatePicker=intro-video",
])(
  "Disabled intro video entry keeps ordinary Video available at %s",
  async (path) => {
    mockTemplateChat();
    await setupPage({
      context,
      path,
      featureSwitches: { [FeatureSwitchKey.IntroVideo]: false },
    });
    expect(screen.queryByRole("dialog")).toBeNull();
    const dialog = await openTemplatePicker(userEvent.setup({ delay: null }));
    expect(control("Video", dialog, "tab")).toBeVisible();
    expect(
      queryAllByRoleFast("tab", dialog).some((tab) => {
        return tab.textContent === "Intro video";
      }),
    ).toBeFalsy();
  },
);

test.each([
  `/agents/${AGENT_ID}/chat?templatePicker=intro-video`,
  "/?templatePicker=intro-video",
])("Intro video deep links wait for feature switches at %s", async (path) => {
  installCatalogs();
  context.mocks.data.onboardingStatus({ defaultAgentId: AGENT_ID });
  const featureResponse = createDeferredPromise<void>(context.signal);
  context.mocks.api(
    featureSwitchesContract.get,
    async ({ respond, withSignal }) => {
      await withSignal(featureResponse.promise);
      return respond(200, {
        switches: { [FeatureSwitchKey.IntroVideo]: true },
        effectiveSwitches: { [FeatureSwitchKey.IntroVideo]: true },
      });
    },
  );

  const page = await startPage({ context, path });
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  featureResponse.resolve(undefined);
  await page.ready;

  const dialog = await screen.findByRole("dialog");
  expect(control("Intro video", dialog, "tab")).toBeVisible();
});

test("Expanded style tags filter the gallery and preserve the selected style", async () => {
  installCatalogs();
  const { dialog } = await openIntroVideo();
  expect(control("Use selection", dialog)).toBeDisabled();
  const tags = within(dialog).getByRole("group", { name: "Browse by style" });
  expect(queryAllByRoleFast("button", tags)).toHaveLength(6);
  click(control("Select style Minimalism", dialog));
  click(control("Handmade and materials", tags));
  expect(control("Handmade and materials", tags)).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  expect(within(dialog).getByText("Watercolor")).toBeVisible();
  expect(within(dialog).queryByLabelText("Select style Minimalism")).toBeNull();
  expect(control("Style", dialog, "tab")).toHaveTextContent("Minimalism");
  click(control("Pop culture", tags));
  expect(within(dialog).getByRole("status")).toHaveTextContent(
    "No matches found",
  );
  click(control("Pop culture", tags));
  expect(control("Handmade and materials", tags)).toHaveAttribute(
    "aria-pressed",
    "false",
  );
  expect(control("Select style Minimalism", dialog)).toHaveAttribute(
    "aria-pressed",
    "true",
  );
});

test("Avatar looks require Use, and explicit voice choices survive removing the avatar", async () => {
  const capture = installCatalogs();
  const { dialog, user } = await openIntroVideo();
  click(control("Select style Minimalism", dialog));
  click(control("Avatar", dialog, "tab"));
  await within(dialog).findByText("Daphne");
  expect(control("Avatar", dialog, "tab")).toHaveTextContent("No avatar");
  click(control("Preview look Daphne in Blue shirt", dialog));
  expect(control("Avatar", dialog, "tab")).toHaveTextContent("No avatar");
  click(control("Choose an avatar: Daphne in Blue shirt", dialog));
  expect(control("Avatar", dialog, "tab")).toHaveTextContent(
    "Daphne in Blue shirt",
  );
  expect(control("Use selection", dialog)).toBeEnabled();
  click(control("Voice", dialog, "tab"));
  click(await within(dialog).findByLabelText("Select voice Annie"));
  click(control("Avatar", dialog, "tab"));
  click(within(dialog).getByText("No avatar"));
  expect(control("Voice", dialog, "tab")).toHaveTextContent("Annie");
  click(control("Use selection", dialog));
  await expectInlineTemplate("Intro video");
  await sendComposerMessage(user, "Explain our product");
  await waitFor(() => {
    return expect(capture.selectedTemplates).toHaveLength(1);
  });
  expect(capture.selectedTemplates[0]).toStrictEqual({
    type: "intro-video",
    selection: {
      options: {
        style: { kind: "catalog", style: STYLES[0] },
        avatar: { kind: "none" },
        voice: { kind: "catalog", voice: VOICE },
      },
    },
  });
});

test("A voice the provider repeats under a second id is listed once", async () => {
  installCatalogs();
  const { dialog } = await openIntroVideo();
  click(control("Voice", dialog, "tab"));
  await within(dialog).findByLabelText("Select voice Annie");
  expect(within(dialog).getAllByLabelText("Select voice Annie")).toHaveLength(
    1,
  );
});

test("The chosen avatar's own voice can be auditioned at the voice step", async () => {
  installCatalogs();
  const { dialog } = await openIntroVideo();
  click(control("Avatar", dialog, "tab"));
  await within(dialog).findByText("Daphne");
  click(control("Choose an avatar: Daphne in Grey blazer", dialog));
  click(control("Voice", dialog, "tab"));
  const preview = await within(dialog).findByLabelText(
    "Preview voice Daphne - Warm & Friendly",
  );
  expect(preview).toBeEnabled();
  click(within(dialog).getByText("No voiceover"));
  expect(control("Voice", dialog, "tab")).toHaveTextContent("No voiceover");
  click(within(dialog).getByText("Avatar’s voice"));
  expect(control("Voice", dialog, "tab")).toHaveTextContent("Avatar’s voice");
});

test("Applying and reopening a template restores all settings without creating another chip", async () => {
  installCatalogs();
  const { dialog, user } = await openIntroVideo();
  click(control("Select style Watercolor", dialog));
  click(control("Voice", dialog, "tab"));
  click(within(dialog).getByText("No voiceover"));
  click(control("Use selection", dialog));
  const chip = await expectInlineTemplate("Intro video");
  const edit = chip.querySelector("button");
  if (!edit) {
    throw new Error("Missing template edit button");
  }
  await user.click(edit);
  const reopened = await screen.findByRole("dialog");
  expect(control("Style", reopened, "tab")).toHaveTextContent("Watercolor");
  expect(control("Voice", reopened, "tab")).toHaveTextContent("No voiceover");
  click(control("Select style Minimalism", reopened));
  click(control("Use selection", reopened));
  await expectInlineTemplate("Minimalism");
  expect(
    document.querySelectorAll("[data-composer-inline-template]"),
  ).toHaveLength(1);
});

test("Cancelling does not apply the selection", async () => {
  installCatalogs();
  const { dialog } = await openIntroVideo();
  click(control("Select style Minimalism", dialog));
  click(control("Cancel", dialog));
  const message = await screen.findByRole("textbox", { name: "Message" });
  expect(message).toBeVisible();
  expect(
    document.querySelectorAll("[data-composer-inline-template]"),
  ).toHaveLength(0);
});

test("Style loading retries a failed later page and excludes portrait-only references", async () => {
  installCatalogs();
  let failLaterPage = true;
  context.mocks.api(
    introVideoPresenterContract.styles,
    ({ query, respond }) => {
      if (!query.token) {
        return respond(200, {
          styles: [STYLES[0]!],
          hasMore: true,
          nextToken: "next",
        });
      }
      return failLaterPage
        ? respond(502, {
            error: { code: "BAD_GATEWAY", message: "Temporarily unavailable" },
          })
        : respond(200, {
            styles: [
              STYLES[1]!,
              {
                id: "portrait",
                name: "Portrait only",
                aspectRatio: "9:16",
                tags: ["handmade"],
              },
            ],
            hasMore: false,
            nextToken: null,
          });
    },
  );
  const user = userEvent.setup({ delay: null });
  await setupPage({
    context,
    path: `/agents/${AGENT_ID}/chat?templatePicker=intro-video`,
    featureSwitches: { [FeatureSwitchKey.IntroVideo]: true },
  });
  const dialog = await screen.findByRole("dialog");
  await within(dialog).findByText("The catalog could not be loaded.");
  failLaterPage = false;
  click(control("Try again", dialog));
  await within(dialog).findByText("Watercolor");
  expect(within(dialog).queryByText("Portrait only")).toBeNull();
  await user.click(control("Handmade and materials", dialog));
  expect(within(dialog).queryByLabelText("Select style Minimalism")).toBeNull();
});

test("Hovering a style plays its preview and leaving restores the thumbnail", async () => {
  installCatalogs();
  const media = mockPlayableMedia();
  const { dialog, user } = await openIntroVideo();
  const previewControl = control("Preview Minimalism", dialog);
  const preview = previewControl.parentElement?.querySelector("video");
  if (!preview) {
    throw new Error("Style preview video not found");
  }
  await user.hover(previewControl);
  expect(media.play).toHaveBeenCalledTimes(1);
  fireEvent.playing(preview);
  expect(preview).toHaveAttribute("data-preview-playing", "true");
  expect(control("Select style Minimalism", dialog)).toHaveAttribute(
    "aria-pressed",
    "false",
  );
  await user.unhover(previewControl);
  expect(media.pause).toHaveBeenCalledTimes(1);
  expect(preview).toHaveAttribute("data-preview-playing", "false");
});

test("A failed style preview keeps its thumbnail and stays selectable", async () => {
  installCatalogs();
  const media = mockPlayableMedia();
  const { dialog, user } = await openIntroVideo();
  const previewControl = control("Preview Minimalism", dialog);
  const preview = previewControl.parentElement?.querySelector("video");
  if (!preview) {
    throw new Error("Style preview video not found");
  }
  await user.click(previewControl);
  expect(media.play).toHaveBeenCalledTimes(1);
  fireEvent.error(preview);
  expect(preview).toHaveAttribute("data-preview-playing", "false");
  expect(previewControl).toBeVisible();
  click(control("Select style Minimalism", dialog));
  expect(control("Style", dialog, "tab")).toHaveTextContent("Minimalism");
  click(control("Voice", dialog, "tab"));
  await within(dialog).findByLabelText("Select voice Annie");
  click(control("Style", dialog, "tab"));
  await expect(
    within(dialog).findByLabelText("Preview Minimalism"),
  ).resolves.toBeVisible();
});

test("Switching settings with the keyboard preserves the selection", async () => {
  installCatalogs();
  const { dialog, user } = await openIntroVideo();
  click(control("Select style Minimalism", dialog));
  const tab = control("Style", dialog, "tab");
  tab.focus();
  await user.keyboard("{ArrowRight}");
  expect(control("Avatar", dialog, "tab")).toHaveFocus();
  expect(control("Avatar", dialog, "tab")).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await user.keyboard("{Home}");
  expect(control("Style", dialog, "tab")).toHaveFocus();
  expect(control("Select style Minimalism", dialog)).toHaveAttribute(
    "aria-pressed",
    "true",
  );
});

test("Desktop recording handoff keeps both uploaded files without opening the template picker", async () => {
  const capture = installCatalogs();
  context.mocks.api(webFilesContract.fileUrl, ({ query, respond }) => {
    return respond(200, {
      url: `https://resolved.example.test/${query.file_id}`,
      expiresAt: "2099-01-01T00:00:00.000Z",
      publicUrl: `https://cdn.example.test/${query.file_id}`,
    });
  });
  const params = new URLSearchParams({
    "intro-video-recording": "video-upload-id",
    "intro-video-recording-name": "demo.mp4",
    "intro-video-recording-size": "1024",
    "intro-video-clicks": "clicks-upload-id",
    "intro-video-clicks-name": "demo.clicks.json",
    "intro-video-clicks-size": "512",
    "intro-video-user": "test-user-123",
  });
  await setupPage({
    context,
    path: `/agents/${AGENT_ID}/chat?${params.toString()}`,
    featureSwitches: { [FeatureSwitchKey.IntroVideo]: true },
  });
  const message = await screen.findByRole("textbox", { name: "Message" });
  await waitFor(() => {
    expect(message).toHaveTextContent("desktop screen recording");
  });
  // The recording arrives as a plain attachment, so the composer stays in the
  // user's hands instead of forcing the intro video template picker open.
  expect(screen.queryByRole("dialog")).toBeNull();
  await waitFor(() => {
    expect(control("Send")).toBeEnabled();
  });
  const user = userEvent.setup({ delay: null });
  await user.click(message);
  await user.keyboard("{Enter}");
  await waitFor(() => {
    return expect(capture.sentMessages).toHaveLength(1);
  });
  expect(
    capture.sentMessages[0]?.parts
      .filter((part) => {
        return part.type === "file";
      })
      .map((part) => {
        return part.fileId;
      }),
  ).toStrictEqual(
    expect.arrayContaining(["video-upload-id", "clicks-upload-id"]),
  );
  expect(
    capture.sentMessages[0]?.parts.filter((part) => {
      return part.type === "file";
    }),
  ).toHaveLength(2);
  expect(capture.selectedTemplates).toStrictEqual([]);
});

test("A saved intro video draft cannot send outside the rollout and remains editable", async () => {
  const capture = mockTemplateChat();
  context.mocks.api(agentDraftContract.get, ({ respond }) => {
    return respond(200, {
      draftUserMessage: {
        version: 1,
        parts: [
          { type: "text", text: "Explain this product " },
          {
            type: "template",
            titleSnapshot: "Intro video",
            template: {
              type: "intro-video",
              selection: {
                options: {
                  style: { kind: "catalog", style: STYLES[0]! },
                  avatar: { kind: "none" },
                  voice: { kind: "none" },
                },
              },
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
    featureSwitches: { [FeatureSwitchKey.IntroVideo]: false },
  });
  await expectInlineTemplate("Intro video");
  await waitFor(() => {
    expect(control("Send")).toBeEnabled();
  });
  const message = await screen.findByRole("textbox", { name: "Message" });
  const user = userEvent.setup({ delay: null });
  await user.click(message);
  await user.keyboard("{Enter}");
  await screen.findByText(
    "This video template is no longer available. Remove it to send your message.",
  );
  expect(capture.sentMessages).toHaveLength(0);
  expect(message).toHaveTextContent("Explain this product");
  await expectInlineTemplate("Intro video");
  await user.keyboard(
    "{Control>}a{/Control}{Backspace}A regular message{Enter}",
  );
  await waitFor(() => {
    expect(capture.sentMessages).toHaveLength(1);
  });
  expect(capture.selectedTemplates).toHaveLength(0);
});

test("Intro Video never displays or submits the preceding Creative Video settings", async () => {
  const capture = installCatalogs();
  await setupPage({
    context,
    path: `/agents/${AGENT_ID}/chat`,
    featureSwitches: {
      [FeatureSwitchKey.IntroVideo]: true,
      [FeatureSwitchKey.ComposerTaskChips]: true,
    },
  });
  const user = userEvent.setup({ delay: null });
  const editor = await screen.findByRole("textbox", { name: "Message" });
  const tasks = screen.getByRole("group", { name: "Choose a task" });
  click(control("Video", tasks));
  click(
    await waitFor(() => {
      return control("Video options 16:9 · 8s · 720p");
    }),
  );
  const ratios = await screen.findByRole("radiogroup", { name: "Ratio" });
  const portrait = queryAllByRoleFast("radio", ratios).find((radio) => {
    return radio.textContent?.trim() === "9:16";
  });
  if (!portrait) {
    throw new Error("Portrait ratio missing");
  }
  click(portrait);
  await user.keyboard("{Escape}");
  click(control("Remove Video"));
  const dialog = await openTemplatePicker(user);
  click(control("Intro video", dialog, "tab"));
  click(await within(dialog).findByLabelText("Select style Minimalism"));
  click(control("Voice", dialog, "tab"));
  click(within(dialog).getByText("No voiceover"));
  await waitFor(() => {
    expect(control("Use selection", dialog)).toBeEnabled();
  });
  click(control("Use selection", dialog));
  await expectInlineTemplate("Intro video");
  expect(screen.queryByLabelText("Video options")).not.toBeInTheDocument();
  expect(
    queryAllByRoleFast("button").some((button) => {
      return button.getAttribute("aria-label")?.startsWith("Video options ");
    }),
  ).toBeFalsy();
  expect(
    screen.queryByRole("combobox", { name: "Video models" }),
  ).not.toBeInTheDocument();
  await user.click(editor);
  await user.keyboard(" Explain our product{Enter}");
  await waitFor(() => {
    expect(capture.sentMessages).toHaveLength(1);
  });
  expect(capture.selectedTemplates[0]?.type).toBe("intro-video");
  expect(
    capture.sentMessages[0]?.parts.some((part) => {
      return part.type === "additional_info";
    }),
  ).toBeFalsy();
});
