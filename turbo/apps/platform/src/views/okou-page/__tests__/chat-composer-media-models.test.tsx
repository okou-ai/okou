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
  mockAgent,
  mockBillingCapabilities,
  mockComposerThreadSnapshot,
  mockOrgModelRoutes,
  mockThread,
  THREAD_ID,
} from "./chat-composer-test-helpers.ts";

const SPLIT_THREAD_ID = "b1000000-0000-4000-a000-000000000106";
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

function composerFor(threadId?: string): HTMLElement {
  const root = threadId
    ? document.querySelector(`[data-chat-thread-container-id="${threadId}"]`)
    : document;
  const composer = root?.querySelector("[data-slot='chat-composer-card']");
  if (!(composer instanceof HTMLElement)) {
    throw new Error(`Composer${threadId ? ` for ${threadId}` : ""} not found`);
  }
  return composer;
}

async function findComposerFor(threadId: string): Promise<HTMLElement> {
  return await waitFor(() => {
    return composerFor(threadId);
  });
}

function pickerTrigger(container: ParentNode = document): HTMLElement {
  const trigger = container.querySelector('[role="combobox"]');
  if (!(trigger instanceof HTMLElement)) {
    throw new Error("Composer model picker not found");
  }
  return trigger;
}

async function openPicker(
  container: ParentNode = document,
): Promise<HTMLElement> {
  await waitFor(() => {
    expect(pickerTrigger(container)).toBeInTheDocument();
  });
  click(pickerTrigger(container));
  return await screen.findByRole("radiogroup", { name: "Models" });
}

function category(name: "Chat" | "Image" | "Video"): HTMLElement {
  const control = queryAllByRoleFast("radio").find((candidate) => {
    return candidate.getAttribute("aria-label") === name;
  });
  if (!control) {
    throw new Error(`${name} model category not found`);
  }
  return control;
}

function mediaModelRow(label: string): HTMLElement {
  const row = queryAllByRoleFast("button").find((candidate) => {
    return candidate.getAttribute("aria-label") === label;
  });
  if (!row) {
    throw new Error(`${label} media model row not found`);
  }
  return row;
}

function expectSelected(label: string): void {
  expect(mediaModelRow(label)).toHaveAttribute("aria-pressed", "true");
  expect(mediaModelRow(label)).toHaveAttribute("aria-current", "true");
}

async function chooseMediaModel(
  categoryName: "Image" | "Video",
  label: string,
  container: ParentNode = document,
): Promise<void> {
  await openPicker(container);
  click(category(categoryName));
  await waitFor(() => {
    expect(mediaModelRow(label)).toBeInTheDocument();
  });
  click(mediaModelRow(label));
  await waitFor(() => {
    expect(screen.queryByRole("radiogroup", { name: "Models" })).toBeNull();
  });
}

async function openCategory(
  categoryName: "Chat" | "Image" | "Video",
  container: ParentNode = document,
): Promise<void> {
  await openPicker(container);
  click(category(categoryName));
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
    const matchingRows = queryAllByRoleFast("button").filter((button) => {
      return button.getAttribute("aria-label") === label;
    });
    expect(matchingRows).toHaveLength(1);
    const row = matchingRows[0];
    if (!row) {
      throw new Error(`${label} catalog row not found`);
    }
    expect(row.querySelector("svg, img")).not.toBeNull();
    expect(row).toHaveTextContent(/\$+/u);
  }
  const availableLabels = queryAllByRoleFast("button").map((button) => {
    return button.getAttribute("aria-label");
  });
  for (const omittedLabel of omittedLabels) {
    expect(availableLabels).not.toContain(omittedLabel);
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
    "aria-pressed",
    "true",
  );
  expect(mediaModelRow("Nano Banana 2")).toHaveAttribute(
    "aria-current",
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

test.each([
  { label: "GPT Image 1", model: "gpt-image-1" },
  { label: "GPT Image 2.5 Flare", model: "gpt-image-2.5-flare" },
  { label: "GPT Image 2.5 Sunburst", model: "gpt-image-2.5-sunburst" },
  { label: "Seedream 5 Pro", model: "dola-seedream-5-0-pro-260628" },
  { label: "FLUX.2 Pro", model: "fal-ai/flux-2-pro" },
])("Choose $label for the current thread", async ({ label, model }) => {
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

  await chooseMediaModel("Image", label);
  await openCategory("Image");
  await waitFor(() => {
    expectSelected(label);
    expect(updates).toStrictEqual([model]);
  });
});

test("Keep image model choices clear on mobile", async () => {
  setMobileViewport();
  installModelEnvironment();
  mockThread({ selectedModel: DEFAULT_RUN_MODEL, selectedImageModel: null });

  await setupPage({ context, path: `/chats/${THREAD_ID}` });

  const models = await openPicker();
  expect(queryAllByRoleFast("radio", models)).toHaveLength(3);
  expect(category("Chat")).toHaveAttribute("aria-checked", "true");
  click(category("Image"));
  expect(category("Image")).toHaveAttribute("aria-checked", "true");
  expect(category("Video")).toBeInTheDocument();
  expectSelected("Nano Banana 2");
});

test("Keep image model pins independent in split chats", async () => {
  setDesktopViewport();
  installModelEnvironment();
  mockThread();
  mockComposerThreadSnapshot([
    {
      id: THREAD_ID,
      agentId: AGENT_ID,
      title: "Main image thread",
      selectedModel: DEFAULT_RUN_MODEL,
      selectedImageModel: "gpt-image-2",
    },
    {
      id: SPLIT_THREAD_ID,
      agentId: AGENT_ID,
      title: "Side image thread",
      selectedModel: DEFAULT_RUN_MODEL,
      selectedImageModel: DEFAULT_IMAGE_MODEL,
    },
  ]);
  const updates: { readonly id: string; readonly model: ImageModel | null }[] =
    [];
  context.mocks.api(
    chatThreadImageModelContract.update,
    ({ params, body, respond }) => {
      updates.push({ id: params.id, model: body.model });
      return respond(204);
    },
  );

  await setupPage({
    context,
    path: `/chats/${THREAD_ID}?sidebar=${SPLIT_THREAD_ID}`,
  });

  const mainComposer = await findComposerFor(THREAD_ID);
  const sideComposer = await findComposerFor(SPLIT_THREAD_ID);

  await chooseMediaModel("Image", "FLUX.2 Pro", mainComposer);
  await openCategory("Image", mainComposer);
  expectSelected("FLUX.2 Pro");
  click(category("Chat"));
  await waitFor(() => {
    expect(screen.queryByText("FLUX.2 Pro")).not.toBeInTheDocument();
  });
  await userEvent.setup().keyboard("{Escape}");

  await openCategory("Image", sideComposer);
  expectSelected("Nano Banana 2");
  expect(updates).toStrictEqual([
    { id: THREAD_ID, model: "fal-ai/flux-2-pro" },
  ]);
});

test("Do not select an available image model for an unavailable pin", async () => {
  installModelEnvironment();
  mockThread({
    selectedModel: DEFAULT_RUN_MODEL,
    selectedImageModel: "fal-ai/flux-pro/v1.1",
  });

  await setupPage({ context, path: `/chats/${THREAD_ID}` });

  await openCategory("Image");
  for (const model of PUBLIC_IMAGE_MODELS) {
    expect(mediaModelRow(IMAGE_MODEL_CONFIGS[model].label)).toHaveAttribute(
      "aria-pressed",
      "false",
    );
  }
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

test("Follow the live video model default in an untouched new chat", async () => {
  let currentPreference = preference();
  const creates: ({ readonly videoModel?: string } | undefined)[] = [];
  installModelEnvironment(currentPreference);
  context.mocks.api(userModelPreferenceContract.get, ({ respond }) => {
    return respond(200, currentPreference);
  });
  mockChatLifecycle(context, {
    threadId: "new-video-default",
    onThreadCreate: (body) => {
      creates.push(body);
    },
  });

  await setupPage({ context, path: `/agents/${AGENT_ID}/chat` });

  await openCategory("Video");
  expectSelected("MiniMax H3");
  await userEvent.setup().keyboard("{Escape}");
  await waitFor(() => {
    expect(
      context.mocks.ably.hasSubscription("userPreferenceChanged"),
    ).toBeTruthy();
  });
  currentPreference = preference({ selectedVideoModel: "fal-ai/veo3.1/fast" });
  context.mocks.ably.trigger("userPreferenceChanged", {
    kinds: ["defaultVideoModel"],
  });

  await openCategory("Video");
  await waitFor(() => {
    expectSelected("Veo 3.1 fast");
  });
  await userEvent.setup().keyboard("{Escape}");
  await sendNewMessage("Use the live video default");

  await waitFor(() => {
    expect(creates).toHaveLength(1);
    expect(creates[0]?.videoModel).toBeUndefined();
  });
});

async function exerciseNewChatThreeModePicker(): Promise<void> {
  await openPicker();
  expect(category("Chat")).toHaveAttribute("aria-checked", "true");
  await expect(
    screen.findByRole("option", { name: /Claude Fable 5/u }),
  ).resolves.toBeInTheDocument();
  click(category("Image"));
  await waitFor(() => {
    expect(mediaModelRow("Nano Banana 2")).toBeInTheDocument();
    expect(
      screen.queryByRole("option", { name: /Claude Fable 5/u }),
    ).toBeNull();
  });
  click(category("Video"));
  await waitFor(() => {
    expect(mediaModelRow("MiniMax H3")).toBeInTheDocument();
    expect(
      queryAllByRoleFast("button").some((button) => {
        return button.getAttribute("aria-label") === "Nano Banana 2";
      }),
    ).toBeFalsy();
  });
  click(mediaModelRow("Veo 3.1 fast"));

  await chooseMediaModel("Image", "GPT Image 2");
  await openPicker();
  click(category("Chat"));
  click(await screen.findByRole("option", { name: /Claude Sonnet 4\.6/u }));

  await waitFor(() => {
    expect(scopeCard("Model for this chat")).not.toBeNull();
    expect(scopeCard("Image model for this chat")).toBeNull();
    expect(scopeCard("Video model for this chat")).toBeNull();
  });
  await openCategory("Image");
  expectSelected("GPT Image 2");
  await userEvent.setup().keyboard("{Escape}");
  await waitFor(() => {
    expect(scopeCard("Image model for this chat")).not.toBeNull();
    expect(scopeCard("Model for this chat")).toBeNull();
    expect(scopeCard("Video model for this chat")).toBeNull();
  });
  await openCategory("Video");
  expectSelected("Veo 3.1 fast");
  await userEvent.setup().keyboard("{Escape}");
  expect(scopeCard("Video model for this chat")).not.toBeNull();
  expect(scopeCard("Image model for this chat")).toBeNull();
}

test("Switch Chat, Image, and Video from one model picker in a desktop new chat", async () => {
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

  await exerciseNewChatThreeModePicker();
  expect(scopeCard("Video model for this chat")).not.toBeNull();
});

test("Switch Chat, Image, and Video from one model picker in a mobile new chat", async () => {
  setMobileViewport();
  installModelEnvironment();
  mockChatLifecycle(context, { threadId: "mobile-new-model-modes" });

  await setupPage({
    context,
    path: `/agents/${AGENT_ID}/chat`,
    featureSwitches: {
      [FeatureSwitchKey.ChatPreference]: true,
    },
  });

  await exerciseNewChatThreeModePicker();
  expect(scopeCard("Video model for this chat")).not.toBeNull();
});

async function exerciseExistingChatThreeModePicker(): Promise<void> {
  await openPicker();
  expect(category("Chat")).toHaveAttribute("aria-checked", "true");
  await expect(
    screen.findByRole("option", { name: /Claude Sonnet 4\.6/u }),
  ).resolves.toHaveAttribute("aria-selected", "true");
  click(category("Image"));
  await waitFor(() => {
    expectSelected("GPT Image 2");
  });
  click(category("Video"));
  await waitFor(() => {
    expectSelected("MiniMax H3");
  });
  click(category("Chat"));
  await expect(
    screen.findByRole("option", { name: /Claude Sonnet 4\.6/u }),
  ).resolves.toHaveAttribute("aria-selected", "true");
  expect(scopeCard("Model for this chat")).toBeNull();
  expect(scopeCard("Image model for this chat")).toBeNull();
  expect(scopeCard("Video model for this chat")).toBeNull();
}

test("Switch Chat, Image, and Video from one model picker in a desktop existing chat", async () => {
  setDesktopViewport();
  installModelEnvironment();
  mockThread({
    selectedModel: "claude-sonnet-4-6",
    selectedImageModel: "gpt-image-2",
    selectedVideoModel: DEFAULT_VIDEO_MODEL,
  });

  await setupPage({ context, path: `/chats/${THREAD_ID}` });

  await exerciseExistingChatThreeModePicker();
  expect(category("Chat")).toHaveAttribute("aria-checked", "true");
});

test("Switch Chat, Image, and Video from one model picker in a mobile existing chat", async () => {
  setMobileViewport();
  installModelEnvironment();
  mockThread({
    selectedModel: "claude-sonnet-4-6",
    selectedImageModel: "gpt-image-2",
    selectedVideoModel: DEFAULT_VIDEO_MODEL,
  });

  await setupPage({ context, path: `/chats/${THREAD_ID}` });

  await exerciseExistingChatThreeModePicker();
  expect(category("Chat")).toHaveAttribute("aria-checked", "true");
});

async function openTemporaryImageModelChat() {
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
    },
  });

  return { creates, preferenceUpdates };
}

test("A temporary image model applies to one new chat and resets for the next", async () => {
  const { creates, preferenceUpdates } = await openTemporaryImageModelChat();
  await chooseMediaModel("Image", "GPT Image 2");
  await waitFor(() => {
    expect(scopeCard("Image model for this chat")).toHaveTextContent(
      "GPT Image 2",
    );
  });
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

test("Save a temporary image model as the default for future chats", async () => {
  const { preferenceUpdates } = await openTemporaryImageModelChat();
  await chooseMediaModel("Image", "GPT Image 2");
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

test("Temporarily choose a video model for a new chat", async () => {
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
      selectedImageModel: currentPreference.selectedImageModel,
      selectedVideoModel:
        body.selectedVideoModel ?? currentPreference.selectedVideoModel,
    });
    return respond(200, currentPreference);
  });
  mockChatLifecycle(context, { threadId: "temporary-video-choice" });

  await setupPage({
    context,
    path: `/agents/${AGENT_ID}/chat`,
    featureSwitches: {
      [FeatureSwitchKey.ChatPreference]: true,
    },
  });

  await chooseMediaModel("Video", "Veo 3.1 fast");
  await waitFor(() => {
    expect(scopeCard("Video model for this chat")).toHaveTextContent(
      /Veo 3\.1 fast/iu,
    );
  });
  expect(preferenceUpdates).toStrictEqual([]);
  const card = scopeCard("Video model for this chat");
  if (!card) {
    throw new Error("Video scope card not found");
  }
  const useFuture = queryAllByRoleFast("button", card).find((button) => {
    return button.textContent?.includes("Use this for future chats");
  });
  if (!useFuture) {
    throw new Error("Use this for future chats button not found");
  }
  click(useFuture);
  await waitFor(() => {
    expect(preferenceUpdates).toStrictEqual([
      {
        selectedModel: DEFAULT_RUN_MODEL,
        serviceTier: "priority",
        selectedVideoModel: "fal-ai/veo3.1/fast",
      },
    ]);
  });
  currentPreference = preference({ selectedVideoModel: "fal-ai/veo3.1/fast" });
  await waitFor(() => {
    expect(
      context.mocks.ably.hasSubscription("userPreferenceChanged"),
    ).toBeTruthy();
  });
  context.mocks.ably.trigger("userPreferenceChanged", {
    kinds: ["defaultVideoModel"],
  });
  await waitFor(() => {
    expect(scopeCard("Video model for this chat")).toBeNull();
  });
});

test("Persist a new-chat video choice when temporary choices are unavailable", async () => {
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

  await chooseMediaModel("Video", "Veo 3.1 fast");
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

test.each(["desktop", "mobile"])(
  "Choose image and video models from the compact overview on %s",
  async (viewport) => {
    if (viewport === "desktop") {
      setDesktopViewport();
    } else {
      setMobileViewport();
    }
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
      featureSwitches: { [FeatureSwitchKey.ModelPickerMenu]: true },
    });
    await findComposerEditor();
    await waitFor(() => {
      expect(mediaModelRow("Claude Fable 5.1")).toBeVisible();
    });
    click(mediaModelRow("Claude Fable 5.1"));
    await screen.findByRole("region", { name: "Models" });
    click(mediaModelRow("Change Image model, Nano Banana 2"));
    await screen.findByRole("region", { name: "Image models" });
    expectSelected("Nano Banana 2");
    click(mediaModelRow("GPT Image 1"));
    await waitFor(() => {
      expect(images).toStrictEqual(["gpt-image-1"]);
    });
    await waitFor(() => {
      expect(
        screen.queryByRole("region", { name: "Image models" }),
      ).not.toBeInTheDocument();
    });
    click(mediaModelRow("Claude Fable 5.1"));
    await screen.findByRole("region", { name: "Models" });
    expect(mediaModelRow("Change Image model, GPT Image 1")).toBeVisible();
    click(
      mediaModelRow(
        `Change Video model, ${VIDEO_MODEL_CONFIGS[DEFAULT_VIDEO_MODEL].label}`,
      ),
    );
    await screen.findByRole("region", { name: "Video models" });
    click(mediaModelRow("Seedance 2.0"));
    await waitFor(() => {
      expect(videos).toStrictEqual(["dreamina-seedance-2-0-260128"]);
    });
    await waitFor(() => {
      expect(
        screen.queryByRole("region", { name: "Video models" }),
      ).not.toBeInTheDocument();
    });
    click(mediaModelRow("Claude Fable 5.1"));
    await screen.findByRole("region", { name: "Models" });
    expect(mediaModelRow("Change Video model, Seedance 2.0")).toBeVisible();
    expect(mediaModelRow("Change Chat model, Claude Fable 5.1")).toBeVisible();
  },
);

test("Switch model type in the flyout without leaving the panel", async () => {
  installModelEnvironment();
  setDesktopViewport();
  mockThread({
    selectedModel: DEFAULT_RUN_MODEL,
    selectedImageModel: null,
  });

  await setupPage({
    context,
    path: `/chats/${THREAD_ID}`,
    featureSwitches: { [FeatureSwitchKey.ModelPickerFlyout]: true },
  });

  // The flyout trigger is a popover button inside the composer, not the
  // Select combobox the menu layout renders.
  const flyoutTrigger = await waitFor(() => {
    const trigger = composerFor()
      .querySelector('[data-slot="select-value"]')
      ?.closest("button");
    if (!(trigger instanceof HTMLElement)) {
      throw new Error("Composer model picker not found");
    }
    return trigger;
  });
  click(flyoutTrigger);

  // Types live in their own panel; the models sit in a second one beside it.
  const types = await screen.findByRole("tablist", { name: "Models" });
  const typeNames = queryAllByRoleFast("tab", types).map((tab) => {
    return tab.textContent;
  });
  expect(typeNames).toHaveLength(3);
  await screen.findByRole("listbox", { name: "Chat models" });

  const imageType = queryAllByRoleFast("tab", types).find((tab) => {
    return tab.textContent?.includes("Image");
  });
  if (!imageType) {
    throw new Error("Image type row not found");
  }
  click(imageType);

  // The panel swapped in place: no page was pushed, so nothing to go back from.
  const imageList = await screen.findByRole("listbox", {
    name: "Image models",
  });
  expect(screen.queryByLabelText("Back to models")).not.toBeInTheDocument();
  expect(imageType).toHaveAttribute("aria-selected", "true");
  const banana = queryAllByRoleFast("option", imageList).find((option) => {
    return option.textContent?.includes("Nano Banana 2");
  });
  if (!banana) {
    throw new Error("Nano Banana 2 option not found");
  }
  expect(banana).toHaveAttribute("aria-selected", "true");
});

test("Hovering a model type opens its panel only once the pointer settles", async () => {
  installModelEnvironment();
  setDesktopViewport();
  mockThread({
    selectedModel: DEFAULT_RUN_MODEL,
    selectedImageModel: null,
  });

  await setupPage({
    context,
    path: `/chats/${THREAD_ID}`,
    featureSwitches: { [FeatureSwitchKey.ModelPickerFlyout]: true },
  });

  const flyoutTrigger = await waitFor(() => {
    const trigger = composerFor()
      .querySelector('[data-slot="select-value"]')
      ?.closest("button");
    if (!(trigger instanceof HTMLElement)) {
      throw new Error("Composer model picker not found");
    }
    return trigger;
  });
  click(flyoutTrigger);

  const types = await screen.findByRole("tablist", { name: "Models" });
  await screen.findByRole("listbox", { name: "Chat models" });
  const imageType = queryAllByRoleFast("tab", types).find((tab) => {
    return tab.textContent?.includes("Image");
  });
  if (!imageType) {
    throw new Error("Image type row not found");
  }

  // A pointer that only crosses the row leaves the panel where it was: the
  // swap is scheduled, not applied, so this frame still shows chat models.
  // `delay: null` keeps the pointer sequence instant, which keeps the
  // assertion below well inside the dwell window.
  await userEvent.setup({ delay: null }).hover(imageType);
  expect(screen.getByRole("listbox", { name: "Chat models" })).toBeVisible();

  // Resting on the row is what opens it.
  await screen.findByRole("listbox", { name: "Image models" });
  expect(imageType).toHaveAttribute("aria-selected", "true");
});
