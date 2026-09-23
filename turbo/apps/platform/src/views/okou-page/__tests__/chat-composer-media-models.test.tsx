import {
  findModelMenuOption,
  queryModelMenuOption,
} from "./chat-model-menu-test-helpers.ts";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  chatThreadImageModelContract,
  chatThreadVideoModelContract,
} from "@okouai/api-contracts/contracts/chat-threads";
import {
  type UpdateUserModelPreferenceRequest,
  userModelPreferenceContract,
  type UserModelPreferenceResponse,
} from "@okouai/api-contracts/contracts/user-model-preference";
import {
  IMAGE_MODEL_CONFIGS,
  PUBLIC_IMAGE_MODELS,
  type ImageModel,
} from "@okouai/core/image-model-catalog";
import {
  PUBLIC_VIDEO_MODELS,
  VIDEO_MODEL_CONFIGS,
  type VideoModel,
} from "@okouai/core/video-model-catalog";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { paidToolsContract } from "@okouai/api-contracts/contracts/paid-tools";
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
  findComposerEditor,
  composerModelTriggerIn,
  mockAgent,
  mockBillingCapabilities,
  mockOrgModelRoutes,
  mockThread,
  THREAD_ID,
} from "./chat-composer-test-helpers.ts";

const DEFAULT_RUN_MODEL = "claude-fable-5-1";
const DEFAULT_IMAGE_MODEL = "fal-ai/nano-banana-2";
const DEFAULT_VIDEO_MODEL = "MiniMax-H3";

function preference(
  overrides: Partial<UserModelPreferenceResponse> = {},
): UserModelPreferenceResponse {
  return {
    selectedModel: DEFAULT_RUN_MODEL,
    serviceTier: "priority",
    modelSettings: {},
    selectedImageModel: DEFAULT_IMAGE_MODEL,
    selectedVideoModel: DEFAULT_VIDEO_MODEL,
    updatedAt: "2026-06-12T00:00:00.000Z",
    ...overrides,
  };
}

function installModelEnvironment(
  modelPreference: UserModelPreferenceResponse = preference(),
): void {
  mockAgent();
  mockOrgModelRoutes(modelPreference.selectedModel ?? DEFAULT_RUN_MODEL);
  mockBillingCapabilities({
    supportByok: true,
    restrictedBuiltInModels: false,
  });
  context.mocks.data.userModelPreference(modelPreference);
}

function setDesktopViewport(): void {
  context.mocks.browser.matchMedia((query) => {
    return query === "(min-width: 640px)";
  });
}

function setMobileViewport(): void {
  context.mocks.browser.matchMedia((query) => {
    return query === "(pointer: coarse)";
  });
}

function pickerTrigger(container: ParentNode = document): HTMLElement {
  const trigger = composerModelTriggerIn(container);
  if (!trigger) {
    throw new Error("Composer model picker not found");
  }
  return trigger;
}

/**
 * The flyout's type rail. A desktop has the room for the rail and its panel;
 * the menu's pages are reached through `menuRow` instead.
 */
async function openPicker(
  container: ParentNode = document,
  user = userEvent.setup({ delay: null }),
): Promise<HTMLElement> {
  await waitFor(() => {
    expect(pickerTrigger(container)).toBeInTheDocument();
  });
  await user.click(pickerTrigger(container));
  return await screen.findByRole("menu", { name: "Models" });
}

/** A type row in the rail, which reads as its type over its current model. */
function category(name: "Chat" | "Image" | "Video"): HTMLElement {
  const control = queryAllByRoleFast("menuitem").find((candidate) => {
    return candidate.textContent?.startsWith(name);
  });
  if (!control) {
    throw new Error(`${name} model category not found`);
  }
  return control;
}

/** A row reads as its model followed by a price tier of one or more `$`. */
function mediaModelRowLabel(option: HTMLElement): string {
  return (option.textContent ?? "").replace(/\$+$/u, "");
}

function mediaModelRowOrNull(label: string): HTMLElement | null {
  return (
    queryAllByRoleFast("menuitemradio").find((candidate) => {
      return mediaModelRowLabel(candidate) === label;
    }) ?? null
  );
}

function mediaModelRow(label: string): HTMLElement {
  const row = mediaModelRowOrNull(label);
  if (!row) {
    throw new Error(`${label} media model row not found`);
  }
  return row;
}

function expectSelected(label: string): void {
  expect(mediaModelRow(label)).toHaveAttribute("aria-checked", "true");
}

/**
 * The compact overview updates the active media category when entering a
 * category, before a model is selected.
 */
async function openMenu(
  container: ParentNode = document,
): Promise<HTMLElement> {
  await waitFor(() => {
    expect(pickerTrigger(container)).toBeInTheDocument();
  });
  click(pickerTrigger(container));
  return await screen.findByRole("region", { name: "Models" });
}

async function openMenuCategory(
  name: "Chat" | "Image" | "Video",
): Promise<HTMLElement> {
  if (!screen.queryByRole("region", { name: `${name} models` })) {
    const overview =
      screen.queryByRole("region", { name: "Models" }) ?? (await openMenu());
    const row = queryAllByRoleFast("menuitem", overview).find((candidate) => {
      return candidate
        .getAttribute("aria-label")
        ?.startsWith(`Change ${name} model,`);
    });
    if (!row) {
      throw new Error(`${name} models are not on the menu's overview`);
    }
    click(row);
  }
  return await screen.findByRole("region", { name: `${name} models` });
}

async function chooseMenuMediaModel(
  name: "Image" | "Video",
  label: string,
): Promise<void> {
  await openMenuCategory(name);
  await userEvent.setup({ delay: null }).click(menuRow(label));
  await waitFor(() => {
    expect(screen.queryByRole("region", { name: `${name} models` })).toBeNull();
  });
  await expect(
    screen.findByRole("region", { name: "Models" }),
  ).resolves.toBeVisible();
  expect(pickerTrigger()).toHaveAttribute("aria-expanded", "true");
}

/** The menu's rows, which name themselves for a narrow viewport's pages. */
function menuRow(label: string): HTMLElement {
  const row = [
    ...queryAllByRoleFast("button"),
    ...queryAllByRoleFast("menuitem"),
    ...queryAllByRoleFast("menuitemradio"),
  ].find((candidate) => {
    return candidate.getAttribute("aria-label") === label;
  });
  if (!row) {
    throw new Error(`${label} menu row not found`);
  }
  return row;
}

function expectMenuSelected(label: string): void {
  expect(menuRow(label)).toHaveAttribute("aria-checked", "true");
}

async function chooseMediaModel(
  categoryName: "Image" | "Video",
  label: string,
  container: ParentNode = document,
): Promise<void> {
  await openCategory(categoryName, container);
  const option = await waitFor(() => {
    const row = mediaModelRow(label);
    expect(row).toBeInTheDocument();
    return row;
  });
  // happy-dom has no geometry for the native submenu's hover corridor. The
  // category interactions above exercise hover; activate the ready row here.
  click(option);
  await waitFor(() => {
    expect(screen.queryByRole("menu", { name: "Models" })).toBeNull();
  });
}

async function openCategory(
  categoryName: "Chat" | "Image" | "Video",
  container: ParentNode = document,
) {
  const user = userEvent.setup({ delay: null });
  await openPicker(container, user);
  await user.click(category(categoryName));
  await screen.findByRole("menu", { name: `${categoryName} models` });
  return user;
}

function scopeCard(label: string): HTMLElement | null {
  return document.querySelector(`[role="group"][aria-label="${label}"]`);
}

function scopeCardButton(label: string, text: string): HTMLElement {
  const card = scopeCard(label);
  if (!card) {
    throw new Error(`${label} scope card not found`);
  }
  const button = queryAllByRoleFast("button", card).find((candidate) => {
    return candidate.textContent?.includes(text);
  });
  if (!button) {
    throw new Error(`${text} button not found in ${label} scope card`);
  }
  return button;
}

async function sendNewMessage(text: string): Promise<void> {
  const editor = await findComposerEditor();
  await fill(editor, text);
  const send = queryAllByRoleFast("button").find((candidate) => {
    return candidate.getAttribute("aria-label") === "Send";
  });
  if (!send) {
    throw new Error("Send button not found");
  }
  click(send);
}

function assertCatalogRows(
  labels: readonly string[],
  omittedLabels: readonly string[],
): void {
  for (const label of labels) {
    const row = mediaModelRow(label);
    expect(row.querySelector("svg, img")).not.toBeNull();
    expect(row).toHaveTextContent(/\$+/u);
  }
  const available = queryAllByRoleFast("menuitemradio").map(mediaModelRowLabel);
  for (const omittedLabel of omittedLabels) {
    expect(available).not.toContain(omittedLabel);
  }
}

test("Show the curated image model catalog", async () => {
  installModelEnvironment();
  mockThread({
    selectedModel: DEFAULT_RUN_MODEL,
    selectedImageModel: null,
  });

  await setupPage({
    context,
    path: `/chats/${THREAD_ID}`,
  });

  await openCategory("Image");
  expect(mediaModelRow("Nano Banana 2")).toHaveAttribute(
    "aria-checked",
    "true",
  );
  assertCatalogRows(
    PUBLIC_IMAGE_MODELS.map((model) => {
      return IMAGE_MODEL_CONFIGS[model].label;
    }),
    [
      "Flux Pro v1.1",
      "Flux Pro v1.1 Ultra",
      "Seedream 4",
      "Seedream 5 Lite",
      "Qwen Image",
    ],
  );
});

test("Choose an image model for the current thread", async () => {
  const updates: (ImageModel | null)[] = [];
  installModelEnvironment();
  mockThread({
    selectedModel: DEFAULT_RUN_MODEL,
    selectedImageModel: null,
  });
  context.mocks.api(
    chatThreadImageModelContract.update,
    ({ body, respond }) => {
      updates.push(body.model);
      return respond(204);
    },
  );

  await setupPage({ context, path: `/chats/${THREAD_ID}` });

  await chooseMediaModel("Image", "FLUX.2 Pro");
  await openCategory("Image");
  await waitFor(() => {
    expectSelected("FLUX.2 Pro");
    expect(updates).toStrictEqual(["fal-ai/flux-2-pro"]);
  });
});

test("Follow the live image model default in an untouched new chat", async () => {
  let currentPreference = preference();
  const creates: ({ readonly imageModel?: string } | undefined)[] = [];
  installModelEnvironment(currentPreference);
  context.mocks.api(userModelPreferenceContract.get, ({ respond }) => {
    return respond(200, currentPreference);
  });
  mockChatLifecycle(context, {
    threadId: "new-image-default",
    onThreadCreate: (body) => {
      creates.push(body);
    },
  });

  await setupPage({ context, path: `/agents/${AGENT_ID}/chat` });

  await openCategory("Image");
  expectSelected("Nano Banana 2");
  await userEvent.setup().keyboard("{Escape}");
  await waitFor(() => {
    expect(
      context.mocks.ably.hasSubscription("userPreferenceChanged"),
    ).toBeTruthy();
  });
  currentPreference = preference({ selectedImageModel: "gpt-image-2" });
  context.mocks.ably.trigger("userPreferenceChanged", {
    kinds: ["defaultImageModel"],
  });

  await openCategory("Image");
  await waitFor(() => {
    expectSelected("GPT Image 2");
  });
  await userEvent.setup().keyboard("{Escape}");
  await sendNewMessage("Use the live image default");

  await waitFor(() => {
    expect(creates).toHaveLength(1);
    expect(creates[0]?.imageModel).toBeUndefined();
  });
});

async function browseNewChatModelCategories(): Promise<void> {
  const user = userEvent.setup({ delay: null });
  await openPicker(document, user);
  expect(category("Chat")).toHaveAttribute("aria-expanded", "true");
  await expect(
    findModelMenuOption(/Claude Fable 5/u),
  ).resolves.toBeInTheDocument();
  await user.click(category("Image"));
  await waitFor(() => {
    expect(mediaModelRow("Nano Banana 2")).toBeInTheDocument();
    expect(queryModelMenuOption(/Claude Fable 5/u)).toBeNull();
  });
  await user.click(category("Video"));
  await waitFor(() => {
    expect(mediaModelRow("MiniMax H3")).toBeInTheDocument();
    expect(
      queryAllByRoleFast("button").some((button) => {
        return button.getAttribute("aria-label") === "Nano Banana 2";
      }),
    ).toBeFalsy();
  });
}

async function selectModelsAcrossNewChatCategories(): Promise<void> {
  await chooseMenuMediaModel("Video", "Veo 3.1 fast");
  await chooseMenuMediaModel("Image", "GPT Image 2");
  await openMenuCategory("Chat");
  click(menuRow("Claude Sonnet 4.6"));

  await waitFor(() => {
    expect(scopeCard("Model for this chat")).not.toBeNull();
    expect(scopeCard("Image model for this chat")).toBeNull();
    expect(scopeCard("Video model for this chat")).toBeNull();
  });
  await openMenuCategory("Image");
  expectMenuSelected("GPT Image 2");
  await userEvent.setup().keyboard("{Escape}");
  await screen.findByRole("region", { name: "Models" });
  await waitFor(() => {
    expect(scopeCard("Image model for this chat")).not.toBeNull();
    expect(scopeCard("Model for this chat")).toBeNull();
    expect(scopeCard("Video model for this chat")).toBeNull();
  });
  await openMenuCategory("Video");
  expectMenuSelected("Veo 3.1 fast");
  await userEvent.setup().keyboard("{Escape}");
  await screen.findByRole("region", { name: "Models" });
  expect(scopeCard("Video model for this chat")).not.toBeNull();
  expect(scopeCard("Image model for this chat")).toBeNull();
}

async function openDesktopNewChatModelPicker() {
  setDesktopViewport();
  installModelEnvironment();
  mockChatLifecycle(context, { threadId: "desktop-new-model-modes" });

  await setupPage({
    context,
    path: `/agents/${AGENT_ID}/chat`,
    featureSwitches: {
      [FeatureSwitchKey.ChatPreference]: true,
    },
  });
}

test("Browse Chat, Image, and Video catalogs in a desktop new chat", async () => {
  await openDesktopNewChatModelPicker();
  await browseNewChatModelCategories();
  expect(category("Video")).toHaveAttribute("aria-expanded", "true");
});

/**
 * The compact overview switches the active category while preserving each
 * category's independent model selection.
 */
test("Retain independent Chat, Image, and Video selections in a new chat", async () => {
  setMobileViewport();
  installModelEnvironment();
  mockChatLifecycle(context, { threadId: "new-model-modes" });

  await setupPage({
    context,
    path: `/agents/${AGENT_ID}/chat`,
    featureSwitches: {
      [FeatureSwitchKey.ChatPreference]: true,
    },
  });

  await selectModelsAcrossNewChatCategories();
  expect(scopeCard("Video model for this chat")).not.toBeNull();
});

/**
 * Both picker layouts can select a temporary image model for the next chat.
 */
async function openTemporaryImageModelChat(
  layout: "menu" | "flyout",
  extraFeatureSwitches: Partial<Record<FeatureSwitchKey, boolean>> = {},
) {
  if (layout === "menu") {
    setMobileViewport();
  }
  const creates: ({ readonly imageModel?: string } | undefined)[] = [];
  const preferenceUpdates: UpdateUserModelPreferenceRequest[] = [];
  let currentPreference = preference();
  installModelEnvironment(currentPreference);
  context.mocks.api(userModelPreferenceContract.get, ({ respond }) => {
    return respond(200, currentPreference);
  });
  context.mocks.api(userModelPreferenceContract.update, ({ body, respond }) => {
    preferenceUpdates.push(body);
    currentPreference = preference({
      selectedModel: body.selectedModel,
      serviceTier: body.serviceTier,
      selectedImageModel:
        body.selectedImageModel ?? currentPreference.selectedImageModel,
      selectedVideoModel: currentPreference.selectedVideoModel,
    });
    return respond(200, currentPreference);
  });
  mockChatLifecycle(context, {
    threadId: "temporary-image-choice",
    onThreadCreate: (body) => {
      creates.push(body);
    },
  });

  await setupPage({
    context,
    path: `/agents/${AGENT_ID}/chat`,
    featureSwitches: {
      [FeatureSwitchKey.ChatPreference]: true,
      ...extraFeatureSwitches,
    },
  });

  return { creates, preferenceUpdates };
}

test("A temporary image model applies to one new chat and resets for the next", async () => {
  const { creates, preferenceUpdates } =
    await openTemporaryImageModelChat("flyout");
  await chooseMediaModel("Image", "GPT Image 2");
  expect(preferenceUpdates).toStrictEqual([]);
  await sendNewMessage("Create with a temporary image model");
  await waitFor(() => {
    expect(creates[0]?.imageModel).toBe("gpt-image-2");
  });

  const newChat = await waitFor(() => {
    const button = queryAllByRoleFast("button").find((candidate) => {
      return (
        candidate.getAttribute("aria-label") === "New chat" &&
        candidate.querySelector(".lucide-square-pen") !== null
      );
    });
    if (!button) {
      throw new Error("New chat button not found");
    }
    return button;
  });
  click(newChat);
  await waitFor(() => {
    expect(window.location.pathname).toBe(`/agents/${AGENT_ID}/chat`);
  });
  await screen.findByRole("heading", { level: 2 });
  await openCategory("Image");
  expectSelected("Nano Banana 2");
});

test("Selecting an image model in the desktop picker shows the disabled tool notice", async () => {
  context.mocks.api(paidToolsContract.get, ({ respond }) => {
    return respond(200, { disabledTools: ["image-generation"] });
  });
  setDesktopViewport();
  await openTemporaryImageModelChat("flyout", {
    [FeatureSwitchKey.PaidToolControls]: true,
    [FeatureSwitchKey.SettingsToolsTab]: true,
  });

  await chooseMediaModel("Image", "Nano Banana 2");
  await screen.findByText("Image generation is off for you");
  expect(screen.getByText("Open settings")).toBeInTheDocument();
  expect(screen.queryByLabelText("Remove Image")).not.toBeInTheDocument();

  await openCategory("Chat");
  const chatModel = await findModelMenuOption(/Claude Fable 5\.1/u);
  await userEvent.setup({ delay: null }).click(chatModel);
  await waitFor(() => {
    expect(screen.queryByRole("menu", { name: "Models" })).toBeNull();
  });
  expect(
    screen.queryByText("Image generation is off for you"),
  ).not.toBeInTheDocument();
});

test("Discard exits a blocked Image model category without clearing the draft", async () => {
  context.mocks.api(paidToolsContract.get, ({ respond }) => {
    return respond(200, { disabledTools: ["image-generation"] });
  });
  setDesktopViewport();
  await openTemporaryImageModelChat("flyout", {
    [FeatureSwitchKey.PaidToolControls]: true,
    [FeatureSwitchKey.SettingsToolsTab]: true,
  });
  const editor = await findComposerEditor();
  await fill(editor, "Create a launch scene");
  await chooseMediaModel("Image", "GPT Image 2");

  await screen.findByText("Image generation is off for you");
  click(screen.getByText("Discard", { selector: "button" }));

  await waitFor(() => {
    expect(
      screen.queryByText("Image generation is off for you"),
    ).not.toBeInTheDocument();
  });
  expect(editor).toHaveTextContent("Create a launch scene");
  await openPicker();
  expect(category("Chat")).toHaveAttribute("aria-expanded", "true");
});

test("Save a temporary image model as the default for future chats", async () => {
  const { preferenceUpdates } = await openTemporaryImageModelChat("menu");
  await chooseMenuMediaModel("Image", "GPT Image 2");
  await waitFor(() => {
    expect(scopeCard("Image model for this chat")).not.toBeNull();
  });
  click(
    scopeCardButton("Image model for this chat", "Use this for future chats"),
  );
  await waitFor(() => {
    expect(preferenceUpdates).toStrictEqual([
      {
        selectedModel: DEFAULT_RUN_MODEL,
        serviceTier: "priority",
        selectedImageModel: "gpt-image-2",
      },
    ]);
  });
  await waitFor(() => {
    expect(
      context.mocks.ably.hasSubscription("userPreferenceChanged"),
    ).toBeTruthy();
  });
  context.mocks.ably.trigger("userPreferenceChanged", {
    kinds: ["defaultImageModel"],
  });
  await waitFor(() => {
    expect(scopeCard("Image model for this chat")).toBeNull();
  });
});

test("Persist a new-chat video choice when temporary choices are unavailable", async () => {
  setMobileViewport();
  const creates: ({ readonly videoModel?: string } | undefined)[] = [];
  const preferenceUpdates: UpdateUserModelPreferenceRequest[] = [];
  installModelEnvironment();
  context.mocks.api(userModelPreferenceContract.update, ({ body, respond }) => {
    preferenceUpdates.push(body);
    return respond(
      200,
      preference({ selectedVideoModel: body.selectedVideoModel }),
    );
  });
  mockChatLifecycle(context, {
    threadId: "persistent-video-choice",
    onThreadCreate: (body) => {
      creates.push(body);
    },
  });

  await setupPage({
    context,
    path: `/agents/${AGENT_ID}/chat`,
    featureSwitches: {
      [FeatureSwitchKey.ChatPreference]: false,
    },
  });

  await chooseMenuMediaModel("Video", "Veo 3.1 fast");
  await waitFor(() => {
    expect(preferenceUpdates).toStrictEqual([
      {
        selectedModel: DEFAULT_RUN_MODEL,
        serviceTier: "priority",
        selectedVideoModel: "fal-ai/veo3.1/fast",
      },
    ]);
  });
  expect(scopeCard("Video model for this chat")).toBeNull();
  await sendNewMessage("Create a video thread");
  await waitFor(() => {
    expect(creates[0]?.videoModel).toBe("fal-ai/veo3.1/fast");
  });
});

test("Choose a video model for the current thread", async () => {
  const updates: VideoModel[] = [];
  installModelEnvironment(
    preference({ selectedVideoModel: "dreamina-seedance-2-0-260128" }),
  );
  mockThread({ selectedModel: DEFAULT_RUN_MODEL, selectedVideoModel: null });
  context.mocks.api(
    chatThreadVideoModelContract.update,
    ({ body, respond }) => {
      if (body.model) {
        updates.push(body.model);
      }
      return respond(204);
    },
  );

  await setupPage({ context, path: `/chats/${THREAD_ID}` });

  await openCategory("Video");
  expectSelected("Seedance 2.0");
  assertCatalogRows(
    PUBLIC_VIDEO_MODELS.map((model) => {
      return VIDEO_MODEL_CONFIGS[model].label;
    }),
    ["Seedance 2.0 fast", "Seedance 2.0 mini"],
  );
  click(mediaModelRow("Veo 3.1 fast"));
  await waitFor(() => {
    expect(updates).toStrictEqual(["fal-ai/veo3.1/fast"]);
  });
  await chooseMediaModel("Video", "Seedance 2.0");
  await openCategory("Video");
  expectSelected("Seedance 2.0");
  expect(updates).toStrictEqual([
    "fal-ai/veo3.1/fast",
    "dreamina-seedance-2-0-260128",
  ]);
});

// The overview's pages are the narrow viewport's layout; a desktop reaches the
// same media models through the flyout, which the tests below cover.
test("Choose image and video models from the compact overview", async () => {
  setMobileViewport();
  installModelEnvironment();
  mockThread({
    selectedModel: DEFAULT_RUN_MODEL,
    selectedImageModel: null,
    selectedVideoModel: null,
  });
  const images: (ImageModel | null)[] = [];
  const videos: (VideoModel | null)[] = [];
  context.mocks.api(
    chatThreadImageModelContract.update,
    ({ body, respond }) => {
      images.push(body.model);
      return respond(204);
    },
  );
  context.mocks.api(
    chatThreadVideoModelContract.update,
    ({ body, respond }) => {
      videos.push(body.model);
      return respond(204);
    },
  );
  await setupPage({
    context,
    path: `/chats/${THREAD_ID}`,
  });
  await findComposerEditor();
  await waitFor(() => {
    expect(menuRow("Claude Fable 5.1")).toBeVisible();
  });
  click(menuRow("Claude Fable 5.1"));
  await screen.findByRole("region", { name: "Models" });
  click(menuRow("Change Image model, Nano Banana 2"));
  await screen.findByRole("region", { name: "Image models" });
  expectMenuSelected("Nano Banana 2");
  await userEvent.setup({ delay: null }).click(menuRow("GPT Image 1"));
  await waitFor(() => {
    expect(images).toStrictEqual(["gpt-image-1"]);
  });
  await waitFor(() => {
    expect(
      screen.queryByRole("region", { name: "Image models" }),
    ).not.toBeInTheDocument();
  });
  await expect(
    screen.findByRole("region", { name: "Models" }),
  ).resolves.toBeVisible();
  expect(pickerTrigger()).toHaveAttribute("aria-expanded", "true");
  expect(menuRow("Change Image model, GPT Image 1")).toBeVisible();
  click(
    menuRow(
      `Change Video model, ${VIDEO_MODEL_CONFIGS[DEFAULT_VIDEO_MODEL].label}`,
    ),
  );
  await screen.findByRole("region", { name: "Video models" });
  await userEvent.setup({ delay: null }).click(menuRow("Seedance 2.0"));
  await waitFor(() => {
    expect(videos).toStrictEqual(["dreamina-seedance-2-0-260128"]);
  });
  await waitFor(() => {
    expect(
      screen.queryByRole("region", { name: "Video models" }),
    ).not.toBeInTheDocument();
  });
  await expect(
    screen.findByRole("region", { name: "Models" }),
  ).resolves.toBeVisible();
  expect(pickerTrigger()).toHaveAttribute("aria-expanded", "true");
  expect(menuRow("Change Video model, Seedance 2.0")).toBeVisible();
  expect(menuRow("Change Chat model, Claude Fable 5.1")).toBeVisible();
});
