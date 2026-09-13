import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type {
  AvatarVideoAvatar,
  AvatarVideoVoice,
} from "@okouai/api-contracts/contracts/avatar-video";
import { expect, test } from "vitest";

import {
  holdElementAnimations,
  queryAllByRoleFast,
  setupPage,
} from "../../../__tests__/page-helper.ts";
import { VIDEO_TEMPLATE_ITEMS } from "@okouai/core/video-template-items";
import { WEBSITE_TEMPLATE_ITEMS } from "@okouai/core/website-template-items";
import {
  AGENT_ID,
  context,
  expectInlineTemplate,
  mockAvatarCatalog,
  mockPlayableMedia,
  mockTemplateChat,
  openTemplatePicker,
  sendComposerMessage,
  templatePart,
} from "./chat-composer-template-gallery-test-helpers.ts";

function buttonNamed(name: string, container: ParentNode = document.body) {
  const button = queryAllByRoleFast("button", container).find((candidate) => {
    return (
      candidate.getAttribute("aria-label") === name ||
      candidate.textContent?.replace(/\s+/gu, " ").trim() === name
    );
  });
  if (!button) {
    throw new Error(`${name} button not found`);
  }
  return button;
}

function controlledSurface(control: HTMLElement): HTMLElement {
  const controlledId = control.getAttribute("aria-controls");
  if (!controlledId) {
    throw new Error("Control does not identify its active surface");
  }
  const surface = document.getElementById(controlledId);
  if (!surface) {
    throw new Error(`Controlled surface ${controlledId} not found`);
  }
  return surface;
}

function avatar(options: {
  readonly id: number;
  readonly name: string;
  readonly style?: "professional" | "social";
  readonly motion?: boolean;
}): AvatarVideoAvatar {
  return {
    id: options.id,
    name: options.name,
    aspectRatio: 1,
    style: options.style ?? "professional",
    gender: "female",
    age: "adult",
    coverUrl: `https://cdn.example.test/avatar-${options.id}.jpg`,
    ...(options.motion
      ? { videoUrl: `https://cdn.example.test/avatar-${options.id}.mp4` }
      : {}),
  };
}

function voice(options: {
  readonly id: string;
  readonly name: string;
  readonly sample?: boolean;
  readonly gender?: AvatarVideoVoice["gender"];
}): AvatarVideoVoice {
  return {
    id: options.id,
    name: options.name,
    ...(options.sample
      ? { sampleUrl: `https://cdn.example.test/${options.id}.mp3` }
      : {}),
    language: "english",
    gender: options.gender ?? "female",
    age: "middle_aged",
    useCase: "informative_educational",
  };
}

async function openAvatarCatalog() {
  mockTemplateChat();
  const media = mockPlayableMedia();
  const firstPage = [
    avatar({ id: 1, name: "Motion Maya", motion: true }),
    avatar({ id: 2, name: "Still Sara" }),
    ...Array.from({ length: 21 }, (_, index) => {
      return avatar({ id: index + 3, name: `Professional ${index + 3}` });
    }),
    avatar({ id: 24, name: "Social Sam", style: "social" }),
  ];
  const additionalAvatar = avatar({ id: 25, name: "Additional Ada" });
  mockAvatarCatalog({
    avatars: firstPage,
    additionalAvatars: [additionalAvatar],
    voices: [voice({ id: "voice-ada", name: "Ada Voice", sample: true })],
  });
  const user = userEvent.setup();

  await setupPage({
    context,
    path: `/agents/${AGENT_ID}/chat`,
    host: "app.okou.ai",
  });

  const dialog = await openTemplatePicker(user, "Avatar");
  await waitFor(() => {
    expect(
      within(dialog).getByLabelText("Select template Motion Maya"),
    ).toBeVisible();
    expect(
      within(dialog).getByLabelText("Select template Social Sam"),
    ).toBeVisible();
  });
  return { user, dialog, media };
}

async function filterProfessionalAvatars(
  user: ReturnType<typeof userEvent.setup>,
  dialog: HTMLElement,
): Promise<HTMLElement> {
  const filterControl = buttonNamed("Filters", dialog);
  await user.click(filterControl);
  const filters = await waitFor(() => {
    expect(filterControl).toHaveAttribute("aria-expanded", "true");
    const surface = controlledSurface(filterControl);
    expect(surface).toBeVisible();
    return surface;
  });
  await user.click(
    within(filters).getByRole("combobox", { name: "Style: All" }),
  );
  await user.click(screen.getByRole("option", { name: "Professional" }));
  await waitFor(() => {
    expect(
      within(dialog).getByLabelText("Select template Motion Maya"),
    ).toBeVisible();
    expect(
      within(dialog).queryByLabelText("Select template Social Sam"),
    ).not.toBeInTheDocument();
  });
  return filters;
}

test("Hovering a video avatar plays its preview within the selected style", async () => {
  const { user, dialog, media } = await openAvatarCatalog();
  await filterProfessionalAvatars(user, dialog);
  await user.hover(
    within(dialog).getByLabelText("Select template Motion Maya"),
  );
  expect(media.play).toHaveBeenCalledWith();
});

test("A still avatar preview remains visible within the selected style", async () => {
  const { user, dialog } = await openAvatarCatalog();
  await filterProfessionalAvatars(user, dialog);
  expect(within(dialog).getByAltText("Still Sara")).toBeVisible();
});

test("Clearing an avatar style restores the full catalog", async () => {
  const { user, dialog } = await openAvatarCatalog();
  const filters = await filterProfessionalAvatars(user, dialog);
  await user.click(buttonNamed("Clear", filters));
  await expect(
    within(dialog).findByLabelText("Select template Social Sam"),
  ).resolves.toBeVisible();
});

test("Choose a paginated avatar and voice after clearing its style filter", async () => {
  const { user, dialog } = await openAvatarCatalog();
  const filters = await filterProfessionalAvatars(user, dialog);
  await user.click(buttonNamed("Clear", filters));
  await expect(
    within(dialog).findByLabelText("Select template Social Sam"),
  ).resolves.toBeVisible();
  const catalog = dialog.querySelector<HTMLElement>(
    "[data-avatar-template-grid-scroll]",
  );
  if (!catalog) {
    throw new Error("Avatar catalog scroll surface not found");
  }
  Object.defineProperties(catalog, {
    clientHeight: { configurable: true, value: 300 },
    scrollHeight: { configurable: true, value: 900 },
    scrollTop: { configurable: true, writable: true, value: 600 },
  });
  fireEvent.scroll(catalog);
  const additionalAvatarCard = await waitFor(() => {
    return within(dialog).getByLabelText("Select template Additional Ada");
  });
  await user.click(additionalAvatarCard);
  const additionalVoice = await waitFor(() => {
    return buttonNamed("Select voice Ada Voice", dialog);
  });
  await user.click(additionalVoice);

  await expectInlineTemplate("Additional Ada");
});

test("Preview and choose a video template", async () => {
  mockTemplateChat();
  const media = mockPlayableMedia();
  const template = VIDEO_TEMPLATE_ITEMS[0];
  if (!template) {
    throw new Error("Video template fixture not found");
  }
  const user = userEvent.setup();

  await setupPage({
    context,
    path: `/agents/${AGENT_ID}/chat`,
    host: "app.okou.ai",
  });

  const dialog = await openTemplatePicker(user, "Video");
  const previewControl = await waitFor(() => {
    return within(dialog).getByLabelText(
      `Play video template preview ${template.title}`,
    );
  });
  await user.click(previewControl);
  expect(media.play).toHaveBeenCalledTimes(1);
  expect(document.querySelector("[data-composer-inline-template]")).toBeNull();
  await user.unhover(previewControl);
  expect(media.pause).toHaveBeenCalledTimes(1);
  await user.hover(previewControl);
  expect(media.play).toHaveBeenCalledTimes(2);

  await user.click(
    within(dialog).getByLabelText(`Select video template ${template.title}`),
  );
  await expectInlineTemplate(template.title);
});

test("Open plans from a gated video template", async () => {
  mockTemplateChat({ tier: "limited-free-1" });
  const template = VIDEO_TEMPLATE_ITEMS[0];
  if (!template) {
    throw new Error("Video template fixture not found");
  }
  const user = userEvent.setup();

  await setupPage({
    context,
    path: `/agents/${AGENT_ID}/chat`,
    host: "app.okou.ai",
  });

  await openTemplatePicker(user, "Video");
  expect(screen.getAllByText("Need Pro").length).toBeGreaterThan(0);
  await user.click(
    screen.getByLabelText(`View plans for video template ${template.title}`),
  );

  await waitFor(() => {
    expect(screen.queryByText(template.title)).not.toBeInTheDocument();
    expect(screen.getByText("Choose a plan")).toBeVisible();
  });
  expect(document.querySelector("[data-composer-inline-template]")).toBeNull();
});

test("Preview and send a website template", async () => {
  const capture = mockTemplateChat();
  const template = WEBSITE_TEMPLATE_ITEMS[0];
  if (!template) {
    throw new Error("Website template fixture not found");
  }
  const user = userEvent.setup();

  await setupPage({
    context,
    path: `/agents/${AGENT_ID}/chat`,
    host: "app.okou.ai",
  });

  const picker = await openTemplatePicker(user, "Website");
  await user.click(
    within(picker).getByLabelText(`Preview website template ${template.title}`),
  );
  const frame = await screen.findByTitle(
    `${template.title} website full preview`,
  );
  expect(frame).toHaveAttribute("src", template.previewUrl);
  const previewDialog = frame.closest<HTMLElement>('[role="dialog"]');
  if (!previewDialog) {
    throw new Error("Website preview dialog not found");
  }
  const finishCloseTransition = holdElementAnimations(previewDialog);
  await user.click(buttonNamed("Website", previewDialog));
  expect(previewDialog).toBeVisible();
  finishCloseTransition();
  const returnedPicker = await waitFor(() => {
    const currentPicker = screen.getByRole("dialog");
    expect(
      within(currentPicker).getByLabelText(
        `Preview website template ${template.title}`,
      ),
    ).toBeVisible();
    return currentPicker;
  });

  await user.click(
    within(returnedPicker).getByLabelText(
      `Select website template ${template.title}`,
    ),
  );
  await expectInlineTemplate(template.title);
  await sendComposerMessage(user, "Build this launch site");
  await waitFor(() => {
    expect(capture.sentMessages).toHaveLength(1);
  });
  expect(templatePart(capture.sentMessages[0]!).template).toStrictEqual({
    type: "website",
    selection: { websiteTemplateId: template.id },
  });
});
