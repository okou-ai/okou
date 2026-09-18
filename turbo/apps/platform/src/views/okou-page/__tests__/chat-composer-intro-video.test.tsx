import { agentDraftContract } from "@okouai/api-contracts/contracts/agent-draft";
import { paidToolsContract } from "@okouai/api-contracts/contracts/paid-tools";
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

/** The advanced options layer, or null while it is closed. */
function optionsPanel(dialog: HTMLElement) {
  return dialog.querySelector<HTMLElement>("[data-intro-video-options]");
}

/** Opens the options layer and walks it back to its first screen. */
function optionsRoot(dialog: HTMLElement) {
  if (!optionsPanel(dialog)) {
    click(control("More options", dialog));
  }
  if (optionsPanel(dialog)?.dataset.introVideoOptions !== "root") {
    click(control("Back", dialog));
  }
  const panel = optionsPanel(dialog);
  if (!panel) {
    throw new Error("The options layer did not open");
  }
  return panel;
}

/** Opens one of the layer's two full libraries; the entry states its count. */
function openLibrary(
  dialog: HTMLElement,
  label: "All voices" | "All presenters",
) {
  const root = optionsRoot(dialog);
  const entry = queryAllByRoleFast("button", root).find((button) => {
    return button.textContent?.trim().startsWith(label);
  });
  if (!entry) {
    throw new Error(`Missing ${label} entry`);
  }
  click(entry);
}

/** The footer's statement of what the template will produce. */
function summary(dialog: HTMLElement) {
  const node = dialog.querySelector("[data-intro-video-summary]");
  if (!node) {
    throw new Error("Missing intro video selection summary");
  }
  return node;
}

async function openIntroVideo(paidTools = false) {
  const user = userEvent.setup({ delay: null });
  await setupPage({
    context,
    path: `/agents/${AGENT_ID}/chat`,
    featureSwitches: {
      [FeatureSwitchKey.IntroVideo]: true,
      [FeatureSwitchKey.PaidToolControls]: paidTools,
    },
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

test("Intro video notices distinguish native generation from no-voice rendering", async () => {
  installCatalogs();
  context.mocks.api(paidToolsContract.get, ({ respond }) => {
    return respond(200, {
      disabledTools: [
        "video-generation",
        "video-rendering",
        "voice-generation",
        "avatar-video-generation",
      ],
    });
  });
  const { dialog } = await openIntroVideo(true);
  await within(dialog).findByText(
    "Video generation is disabled in your paid tool settings.",
  );
  expect(
    within(dialog).queryByText(
      "Voice generation is disabled in your paid tool settings.",
    ),
  ).not.toBeInTheDocument();
  expect(
    within(dialog).queryByText(
      "Avatar video generation is disabled in your paid tool settings.",
    ),
  ).not.toBeInTheDocument();
  optionsRoot(dialog);
  click(within(dialog).getByText("No voiceover"));
  await within(dialog).findByText(
    "Video rendering is disabled in your paid tool settings.",
  );
  expect(
    within(dialog).queryByText(
      "Video generation is disabled in your paid tool settings.",
    ),
  ).not.toBeInTheDocument();
});

test("Style filters and search narrow the gallery and preserve the selected style", async () => {
  installCatalogs();
  const { dialog, user } = await openIntroVideo();
  expect(control("Pick a style", dialog)).toBeDisabled();
  const tags = within(dialog).getByRole("group", { name: "Browse by style" });
  expect(queryAllByRoleFast("button", tags)).toHaveLength(7);
  click(control("Select style Minimalism", dialog));
  click(control("Handmade and materials", tags));
  expect(control("Handmade and materials", tags)).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  expect(within(dialog).getByText("Watercolor")).toBeVisible();
  expect(within(dialog).queryByLabelText("Select style Minimalism")).toBeNull();
  // Filtering the selected style out of view must not drop the selection: the
  // filter row says so, and offers the way back.
  expect(control("Use Minimalism", dialog)).toBeEnabled();
  click(control("Selected: Minimalism", dialog));
  expect(control("All", tags)).toHaveAttribute("aria-pressed", "true");
  click(control("Pop culture", tags));
  expect(within(dialog).getByRole("status")).toHaveTextContent(
    "No matches found",
  );
  click(control("All", tags));
  expect(control("Handmade and materials", tags)).toHaveAttribute(
    "aria-pressed",
    "false",
  );
  expect(control("Select style Minimalism", dialog)).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await user.type(within(dialog).getByLabelText("Search styles"), "water");
  expect(within(dialog).getByText("Watercolor")).toBeVisible();
  expect(within(dialog).queryByLabelText("Select style Minimalism")).toBeNull();
});

test("Avatar looks require Use, and explicit voice choices survive removing the avatar", async () => {
  const capture = installCatalogs();
  const { dialog, user } = await openIntroVideo();
  click(control("Select style Minimalism", dialog));
  expect(summary(dialog)).toHaveTextContent("No avatar");
  openLibrary(dialog, "All presenters");
  await within(dialog).findByText("Daphne");
  click(control("Preview look Daphne in Blue shirt", dialog));
  click(control("Done", dialog));
  // Previewing a look is not choosing it.
  expect(summary(dialog)).toHaveTextContent("No avatar");
  openLibrary(dialog, "All presenters");
  click(
    await within(dialog).findByLabelText(
      "Choose an avatar: Daphne in Blue shirt",
    ),
  );
  click(control("Done", dialog));
  expect(summary(dialog)).toHaveTextContent("Daphne in Blue shirt");
  expect(control("Use Minimalism", dialog)).toBeEnabled();
  openLibrary(dialog, "All voices");
  click(await within(dialog).findByLabelText("Select voice Annie"));
  openLibrary(dialog, "All presenters");
  click(within(dialog).getByText("No avatar"));
  click(control("Done", dialog));
  expect(summary(dialog)).toHaveTextContent("Annie");
  expect(summary(dialog)).toHaveTextContent("No avatar");
  click(control("Use Minimalism", dialog));
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
  openLibrary(dialog, "All voices");
  await within(dialog).findByLabelText("Select voice Annie");
  expect(within(dialog).getAllByLabelText("Select voice Annie")).toHaveLength(
    1,
  );
});

test("The chosen avatar's own voice can be auditioned at the voice step", async () => {
  installCatalogs();
  const { dialog } = await openIntroVideo();
  openLibrary(dialog, "All presenters");
  await within(dialog).findByText("Daphne");
  click(control("Choose an avatar: Daphne in Grey blazer", dialog));
  openLibrary(dialog, "All voices");
  const preview = await within(dialog).findByLabelText(
    "Preview voice Daphne - Warm & Friendly",
  );
  expect(preview).toBeEnabled();
  click(within(dialog).getByText("No voiceover"));
  click(control("Done", dialog));
  expect(summary(dialog)).toHaveTextContent("No voiceover");
  openLibrary(dialog, "All voices");
  click(within(dialog).getByText("Avatar’s voice"));
  click(control("Done", dialog));
  expect(summary(dialog)).toHaveTextContent("Avatar’s voice");
});

test("Applying and reopening a template restores all settings without creating another chip", async () => {
  installCatalogs();
  const { dialog, user } = await openIntroVideo();
  click(control("Select style Watercolor", dialog));
  openLibrary(dialog, "All voices");
  click(within(dialog).getByText("No voiceover"));
  click(control("Done", dialog));
  click(control("Use Watercolor", dialog));
  const chip = await expectInlineTemplate("Intro video");
  const edit = chip.querySelector("button");
  if (!edit) {
    throw new Error("Missing template edit button");
  }
  await user.click(edit);
  const reopened = await screen.findByRole("dialog");
  // Reopening lands on the gallery, so the restored settings have to be
  // readable without opening the options layer again.
  expect(optionsPanel(reopened)).toBeNull();
  await expect(
    within(reopened).findByLabelText("Select style Watercolor"),
  ).resolves.toHaveAttribute("aria-pressed", "true");
  expect(summary(reopened)).toHaveTextContent("No voiceover");
  click(control("Select style Minimalism", reopened));
  click(control("Use Minimalism", reopened));
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
  expect(summary(dialog)).toHaveTextContent("Let Okou choose");
  openLibrary(dialog, "All voices");
  await within(dialog).findByLabelText("Select voice Annie");
  click(control("Close options", dialog));
  await expect(
    within(dialog).findByLabelText("Preview Minimalism"),
  ).resolves.toBeVisible();
});

test("The options layer opens from the keyboard and leaves the gallery selection alone", async () => {
  installCatalogs();
  const { dialog, user } = await openIntroVideo();
  click(control("Select style Minimalism", dialog));
  control("More options", dialog).focus();
  await user.keyboard("{Enter}");
  const options = optionsPanel(dialog);
  if (!options) {
    throw new Error("The options layer did not open");
  }
  expect(within(options).getByText("Let Okou choose")).toBeInTheDocument();
  expect(within(options).getByText("No avatar")).toBeInTheDocument();
  openLibrary(dialog, "All voices");
  expect(within(options).getByLabelText("Search voices")).toBeInTheDocument();
  click(control("Back", dialog));
  expect(within(options).getByText("No avatar")).toBeInTheDocument();
  click(control("Close options", dialog));
  expect(optionsPanel(dialog)).toBeNull();
  // The gallery stays mounted behind the layer, so its selection survives.
  expect(control("Select style Minimalism", dialog)).toHaveAttribute(
    "aria-pressed",
    "true",
  );
});

async function prepareDesktopRecordingHandoff() {
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
  return { capture, message };
}

test("Desktop recording handoff leaves the composer ready without opening the template picker", async () => {
  await prepareDesktopRecordingHandoff();
  // The recording arrives as a plain attachment, so the composer stays in the
  // user's hands instead of forcing the intro video template picker open.
  expect(screen.queryByRole("dialog")).toBeNull();
  await waitFor(() => {
    expect(control("Send")).toBeEnabled();
  });
});

test("Desktop recording handoff submits both uploaded files without selecting a template", async () => {
  const { capture, message } = await prepareDesktopRecordingHandoff();
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

async function rejectUnavailableIntroDraft() {
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
  return { capture, message, user };
}

test("An unavailable saved intro video draft rejects sending and preserves its text and template", async () => {
  const { capture, message } = await rejectUnavailableIntroDraft();
  expect(capture.sentMessages).toHaveLength(0);
  expect(message).toHaveTextContent("Explain this product");
  await expectInlineTemplate("Intro video");
});

test("An unavailable saved intro video draft can send ordinary text after its rejected template is removed", async () => {
  const { capture, user } = await rejectUnavailableIntroDraft();
  expect(capture.sentMessages).toHaveLength(0);
  await user.keyboard(
    "{Control>}a{/Control}{Backspace}A regular message{Enter}",
  );
  await waitFor(() => {
    expect(capture.sentMessages).toHaveLength(1);
  });
  expect(capture.selectedTemplates).toHaveLength(0);
});

async function replaceCreativeVideoWithIntroVideo() {
  const capture = installCatalogs();
  await setupPage({
    context,
    path: `/agents/${AGENT_ID}/chat`,
    featureSwitches: {
      [FeatureSwitchKey.IntroVideo]: true,
      [FeatureSwitchKey.ComposerSlashTemplatePanel]: true,
    },
  });
  const user = userEvent.setup({ delay: null });
  const editor = await screen.findByRole("textbox", { name: "Message" });
  // Video has no Make row of its own, so the composer enters the row below
  // Presentation and switches the type from there.
  await user.click(editor);
  await user.paste("/");
  await screen.findByTestId("slash-workflow-menu");
  await user.keyboard("{ArrowDown}{Enter}");
  click(control("Close", await screen.findByRole("dialog")));
  await waitFor(() => {
    expect(screen.queryByRole("dialog")).toBeNull();
  });
  click(await screen.findByRole("combobox", { name: "Choose a type" }));
  click(await screen.findByRole("option", { name: "Video" }));
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
  click(control("Exit create mode"));
  const dialog = await openTemplatePicker(user);
  click(control("Intro video", dialog, "tab"));
  click(await within(dialog).findByLabelText("Select style Minimalism"));
  openLibrary(dialog, "All voices");
  click(within(dialog).getByText("No voiceover"));
  click(control("Done", dialog));
  await waitFor(() => {
    expect(control("Use Minimalism", dialog)).toBeEnabled();
  });
  click(control("Use Minimalism", dialog));
  await expectInlineTemplate("Intro video");
  return { capture, editor, user };
}

test("Intro Video hides the preceding Creative Video controls", async () => {
  await replaceCreativeVideoWithIntroVideo();
  expect(screen.queryByLabelText("Video options")).not.toBeInTheDocument();
  expect(
    queryAllByRoleFast("button").some((button) => {
      return button.getAttribute("aria-label")?.startsWith("Video options ");
    }),
  ).toBeFalsy();
  expect(
    screen.queryByRole("combobox", { name: "Video models" }),
  ).not.toBeInTheDocument();
});

test("Intro Video submits its template without the preceding Creative Video settings", async () => {
  const { capture, editor, user } = await replaceCreativeVideoWithIntroVideo();
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
