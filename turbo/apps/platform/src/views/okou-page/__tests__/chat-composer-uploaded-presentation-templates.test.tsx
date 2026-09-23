import { MessagePort } from "node:worker_threads";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { formatUserPresentationTemplateId } from "@okouai/core/presentation-template-selection";
import { expect, test, vi } from "vitest";
import { presentationTemplatesContract } from "@okouai/api-contracts/contracts/presentation-templates";
import {
  sharedDatabaseClientMessageSchema,
  sharedDatabaseWorkerMessageSchema,
} from "../../../shared-database/protocol.ts";

import {
  click,
  fill,
  queryAllByRoleFast,
  setupPage,
} from "../../../__tests__/page-helper.ts";
import { mockNow } from "../../../__tests__/time.ts";
import { PRESENTATION_TEMPLATE_PICKER_ITEMS } from "@okouai/core/presentation-template-items";
import {
  buttonContainingText,
  expectTextBefore,
  trackTemplatePreviewImagePreloads,
} from "./chat-composer-test-helpers.ts";
import {
  AGENT_ID,
  THREAD_ID,
  context,
  createUploadedTemplate,
  mockPresentationTemplateLibrary,
  mockTemplateChat,
  openTemplatePicker,
  sendComposerMessage,
  templatePart,
} from "./chat-composer-template-gallery-test-helpers.ts";

const UPLOADED_TEMPLATE_ID = "82000000-0000-4000-a000-000000000001";
const UPDATED_TEMPLATE_ID = "82000000-0000-4000-a000-000000000002";
const OTHER_THREAD_ID = "82000000-0000-4000-a000-000000000004";
const UPLOADED_TEMPLATE_NOW_MS = 1_785_542_400_000;

// Infrastructure-only synchronization: the page has no partial-ACK state for
// one scope while its sibling is still pending. Observe the real transport only
// to order provider events; assert loading and recovery through the page below.
function observeTemplateSubscriptions() {
  const messages = vi.spyOn(MessagePort.prototype, "postMessage");
  const subscriptions = () => {
    return messages.mock.calls.flatMap(([message]) => {
      const parsed = sharedDatabaseClientMessageSchema.safeParse(message);
      return parsed.success &&
        parsed.data.type === "realtime-subscribe" &&
        parsed.data.topic === "presentationTemplatesChanged"
        ? [parsed.data]
        : [];
    });
  };
  const releasedScopes = () => {
    const released = new Set(
      messages.mock.calls.flatMap(([message]) => {
        const parsed = sharedDatabaseClientMessageSchema.safeParse(message);
        return parsed.success && parsed.data.type === "realtime-unsubscribe"
          ? [parsed.data.subscriptionId]
          : [];
      }),
    );
    return new Set(
      subscriptions()
        .filter((subscription) => {
          return released.has(subscription.subscriptionId);
        })
        .map((subscription) => {
          return subscription.scope;
        }),
    );
  };
  return {
    waitForSubscribed: async (scope: "user" | "org") => {
      await waitFor(() => {
        const request = subscriptions().find((subscription) => {
          return subscription.scope === scope;
        });
        expect(request).toBeDefined();
        expect(
          messages.mock.calls.some(([message]) => {
            const parsed = sharedDatabaseWorkerMessageSchema.safeParse(message);
            return (
              parsed.success &&
              parsed.data.type === "realtime-subscribed" &&
              parsed.data.subscriptionId === request?.subscriptionId
            );
          }),
        ).toBeTruthy();
      });
    },
    waitForReleased: async (scope: "user" | "org") => {
      await waitFor(() => {
        expect([...releasedScopes()]).toStrictEqual([scope]);
      });
    },
  };
}

test("Uploaded templates wait for both subscriptions", async () => {
  mockNow(UPLOADED_TEMPLATE_NOW_MS, context.signal);
  mockTemplateChat();
  const uploaded = createUploadedTemplate({
    id: UPLOADED_TEMPLATE_ID,
    title: "Both subscriptions are ready",
  });
  mockPresentationTemplateLibrary([uploaded]);
  const gates = {
    user: context.mocks.ably.deferSubscribeOnChannel(
      "user:test-user-123",
      "presentationTemplatesChanged",
    ),
    org: context.mocks.ably.deferSubscribeOnChannel(
      "org:org_default",
      "presentationTemplatesChanged",
    ),
  };
  const observed = observeTemplateSubscriptions();
  const user = userEvent.setup();
  await setupPage({
    context,
    path: `/agents/${AGENT_ID}/chat`,
    host: "app.okou.ai",
    sharedWorkerTestTransport: "message-port",
  });
  await Promise.all([gates.user.started, gates.org.started]);
  const picker = await openTemplatePicker(user, "Presentation");

  gates.user.attach();
  await observed.waitForSubscribed("user");
  expect(
    within(picker).getByText("Loading uploaded templates…"),
  ).toBeInTheDocument();
  gates.org.attach();
  await expect(
    within(picker).findByLabelText(`Select template ${uploaded.title}`),
  ).resolves.toBeInTheDocument();
});

test("A template subscription failure releases both scopes and leaves built-ins usable", async () => {
  mockNow(UPLOADED_TEMPLATE_NOW_MS, context.signal);
  mockTemplateChat();
  mockPresentationTemplateLibrary([]);
  const org = context.mocks.ably.deferSubscribeOnChannel(
    "org:org_default",
    "presentationTemplatesChanged",
  );
  const observed = observeTemplateSubscriptions();
  const user = userEvent.setup();
  await setupPage({
    context,
    path: `/agents/${AGENT_ID}/chat`,
    host: "app.okou.ai",
    sharedWorkerTestTransport: "message-port",
  });
  await org.started;
  const picker = await openTemplatePicker(user, "Presentation");
  await observed.waitForSubscribed("user");
  org.fail(new Error("Template subscription unavailable"));
  await expect(
    within(picker).findByText(
      "Uploaded templates are temporarily unavailable.",
    ),
  ).resolves.toBeInTheDocument();
  expect(within(picker).getByText(firstBuiltInTitle())).toBeInTheDocument();
  expect(
    within(picker).getByLabelText(`Select template ${firstBuiltInTitle()}`),
  ).toBeEnabled();
  expect(within(picker).queryByText("Retry")).not.toBeInTheDocument();
  // Worker-side listener release has no separate page-visible surface, and the
  // channels themselves no longer answer for this catalog: the custom template
  // catalog listens to the same topic and keeps its own subscriptions through
  // this failure. Follow the subscriptions this catalog created instead. Only
  // the scope that attached has a listener to release — the one that failed to
  // subscribe never held one.
  await observed.waitForReleased("user");
});

test("A resolved empty catalog leaves the import card as the only prompt", async () => {
  mockNow(UPLOADED_TEMPLATE_NOW_MS, context.signal);
  mockTemplateChat();
  mockPresentationTemplateLibrary([]);
  const gates = {
    user: context.mocks.ably.deferSubscribeOnChannel(
      "user:test-user-123",
      "presentationTemplatesChanged",
    ),
    org: context.mocks.ably.deferSubscribeOnChannel(
      "org:org_default",
      "presentationTemplatesChanged",
    ),
  };
  const user = userEvent.setup();
  await setupPage({
    context,
    path: `/agents/${AGENT_ID}/chat`,
    host: "app.okou.ai",
    sharedWorkerTestTransport: "message-port",
  });
  await Promise.all([gates.user.started, gates.org.started]);
  const picker = await openTemplatePicker(user, "Presentation");
  expect(
    within(picker).getByText("Loading uploaded templates…"),
  ).toBeInTheDocument();
  gates.user.attach();
  gates.org.attach();
  await waitFor(() => {
    expect(
      within(picker).queryByText("Loading uploaded templates…"),
    ).not.toBeInTheDocument();
  });
  // An empty library is the default state, not a condition worth reporting: the
  // import card already carries both the affordance and the absence.
  expect(
    within(presentationGrid()).queryByRole("status"),
  ).not.toBeInTheDocument();
  expect(
    within(picker).getByLabelText("Import your own deck"),
  ).toBeInTheDocument();
  expect(
    within(picker).getByLabelText(`Select template ${firstBuiltInTitle()}`),
  ).toBeEnabled();
});

function importedTemplateCard(templateId: string): HTMLElement {
  const card = document.querySelector<HTMLElement>(
    `[data-imported-presentation-template="${templateId}"]`,
  );
  if (!card) {
    throw new Error(`Imported template card ${templateId} not found`);
  }
  return card;
}

function importedTemplateMedia(templateId: string): HTMLElement {
  const media = importedTemplateCard(templateId).querySelector<HTMLElement>(
    "[data-imported-presentation-template-media]",
  );
  if (!media) {
    throw new Error(`Imported template media ${templateId} not found`);
  }
  return media;
}

function buttonNamed(
  name: string,
  container: ParentNode = document.body,
): HTMLElement {
  const button = queryAllByRoleFast("button", container).find((candidate) => {
    return (
      candidate.getAttribute("aria-label") === name ||
      candidate.textContent?.replace(/\s+/gu, " ").trim() === name
    );
  });
  if (!button) {
    throw new Error(`Button named "${name}" not found`);
  }
  return button;
}

function presentationGrid(): HTMLElement {
  const grid = document.querySelector<HTMLElement>(
    "[data-presentation-template-grid-scroll]",
  );
  if (!grid) {
    throw new Error("Presentation template grid not found");
  }
  return grid;
}

function firstBuiltInTitle(): string {
  const template = PRESENTATION_TEMPLATE_PICKER_ITEMS[0];
  if (!template) {
    throw new Error("Built-in presentation template not found");
  }
  return template.title;
}

function sentTemplate(capture: ReturnType<typeof mockTemplateChat>) {
  const message = capture.sentMessages[0];
  if (!message) {
    throw new Error("No presentation message was sent");
  }
  return templatePart(message).template;
}

test("A closed composer does not load uploaded template covers", async () => {
  mockNow(UPLOADED_TEMPLATE_NOW_MS, context.signal);
  mockTemplateChat();
  const uploaded = createUploadedTemplate({
    id: UPLOADED_TEMPLATE_ID,
    title: "Quarterly Board Review",
  });
  const library = mockPresentationTemplateLibrary([uploaded]);
  const user = userEvent.setup();

  await setupPage({
    context,
    path: `/agents/${AGENT_ID}/chat`,
    host: "app.okou.ai",
  });

  await waitFor(() => {
    expect(library.requests.listCount).toBeGreaterThan(0);
  });
  expect(
    document.querySelector(`img[src*="${uploaded.id}"]`),
  ).not.toBeInTheDocument();

  await openTemplatePicker(user, "Presentation");
  await waitFor(() => {
    expect(
      importedTemplateMedia(uploaded.id).querySelector("img"),
    ).toHaveAttribute("src", expect.stringContaining(uploaded.id));
  });
});

async function openUploadedPresentationPicker() {
  mockNow(UPLOADED_TEMPLATE_NOW_MS, context.signal);
  const capture = mockTemplateChat();
  const uploaded = createUploadedTemplate({
    id: UPLOADED_TEMPLATE_ID,
    title: "Quarterly Board Review",
    pageCount: 3,
  });
  mockPresentationTemplateLibrary([uploaded]);
  trackTemplatePreviewImagePreloads();
  const user = userEvent.setup();

  await setupPage({
    context,
    path: `/agents/${AGENT_ID}/chat`,
    host: "app.okou.ai",
  });

  const picker = await openTemplatePicker(user, "Presentation");
  await waitFor(() => {
    expect(screen.getByText(uploaded.title)).toBeVisible();
  });
  expectTextBefore(uploaded.title, firstBuiltInTitle());
  return { capture, uploaded, user, picker };
}

test("Hovering an uploaded presentation opens the currently previewed slide", async () => {
  const { uploaded, user, picker } = await openUploadedPresentationPicker();
  const media = importedTemplateMedia(uploaded.id);
  Object.defineProperty(media, "getBoundingClientRect", {
    configurable: true,
    value: () => {
      return new DOMRect(0, 0, 300, 169);
    },
  });
  await user.hover(media);
  await waitFor(() => {
    const image = media.querySelector<HTMLImageElement>("img");
    expect(image).toHaveAttribute("src", expect.stringContaining("slide-1"));
  });
  fireEvent.mouseMove(media, { clientX: 299 });
  await waitFor(() => {
    const image = media.querySelector<HTMLImageElement>("img");
    expect(image).toHaveAttribute("src", expect.stringContaining("slide-3"));
  });

  click(buttonNamed(`Preview ${uploaded.title} at current slide`, media));
  const detail = await screen.findByRole("group", {
    name: `${uploaded.title} slide preview`,
  });
  expect(buttonNamed("Preview slide 3", picker)).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  expect(detail).toBeVisible();
});

test("Select and send an uploaded presentation template from its detail preview", async () => {
  const { capture, uploaded, user } = await openUploadedPresentationPicker();
  click(
    buttonNamed(
      `Preview ${uploaded.title} at current slide`,
      importedTemplateMedia(uploaded.id),
    ),
  );
  await screen.findByRole("group", { name: `${uploaded.title} slide preview` });
  click(buttonNamed(`Select template ${uploaded.title}`));
  await sendComposerMessage(user, "Use this deck for the launch review");
  await waitFor(() => {
    expect(capture.sentMessages).toHaveLength(1);
  });
  expect(sentTemplate(capture)).toMatchObject({
    type: "presentation",
    selection: {
      templateId: formatUserPresentationTemplateId(uploaded.id),
    },
  });
});

test("Keep workspace templates current through withdrawal after preview", async () => {
  mockNow(UPLOADED_TEMPLATE_NOW_MS, context.signal);
  const capture = mockTemplateChat();
  const existing = createUploadedTemplate({
    id: UPLOADED_TEMPLATE_ID,
    title: "Existing Workspace Deck",
    canManage: false,
  });
  const published = createUploadedTemplate({
    id: UPDATED_TEMPLATE_ID,
    title: "New Workspace Deck",
    canManage: false,
  });
  const library = mockPresentationTemplateLibrary([existing]);
  capture.lifecycle.setThreadList([
    {
      id: THREAD_ID,
      title: "First workspace chat",
      agent: { id: AGENT_ID, avatarUrl: null },
      createdAt: "2026-08-01T00:00:00.000Z",
      updatedAt: "2026-08-01T00:01:00.000Z",
    },
    {
      id: OTHER_THREAD_ID,
      title: "Second workspace chat",
      agent: { id: AGENT_ID, avatarUrl: null },
      createdAt: "2026-08-01T00:02:00.000Z",
      updatedAt: "2026-08-01T00:03:00.000Z",
    },
  ]);
  trackTemplatePreviewImagePreloads();
  const user = userEvent.setup();
  await setupPage({
    context,
    path: `/chats/${THREAD_ID}`,
    host: "app.okou.ai",
  });
  await openTemplatePicker(user, "Presentation");
  await waitFor(() => {
    expect(screen.getByText(existing.title)).toBeVisible();
  });
  library.replace([existing, published]);
  context.mocks.ably.triggerOnChannel(
    "org:org_default",
    "presentationTemplatesChanged",
    published.id,
  );
  await waitFor(() => {
    expect(screen.getByText(published.title)).toBeVisible();
    expect(
      screen.getByLabelText(`Select template ${published.title}`),
    ).toBeEnabled();
  });
  click(buttonNamed(`Preview ${published.title} at current slide`));
  await screen.findByRole("group", {
    name: `${published.title} slide preview`,
  });
  click(buttonContainingText("Template", screen.getByRole("dialog")));
  library.replace([existing]);
  context.mocks.ably.triggerOnChannel(
    "org:org_default",
    "presentationTemplatesChanged",
    published.id,
  );
  await waitFor(() => {
    expect(screen.queryByText(published.title)).not.toBeInTheDocument();
    expect(
      screen.queryByLabelText(`Select template ${published.title}`),
    ).not.toBeInTheDocument();
  });
});

/**
 * The label belongs to both the field and its confirm control, so the field is
 * the one that is a textarea.
 */
function renameField(): HTMLTextAreaElement {
  const field = screen
    .getAllByLabelText("Rename template")
    .find((candidate): candidate is HTMLTextAreaElement => {
      return candidate instanceof HTMLTextAreaElement;
    });
  if (!field) {
    throw new Error("Expected a rename field");
  }
  return field;
}

test("Rename an uploaded template", async () => {
  mockNow(UPLOADED_TEMPLATE_NOW_MS, context.signal);
  mockTemplateChat();
  const uploaded = createUploadedTemplate({
    id: UPLOADED_TEMPLATE_ID,
    title: "Quarterly Board Review",
    pageCount: 3,
    canManage: true,
  });
  mockPresentationTemplateLibrary([uploaded]);
  const user = userEvent.setup();
  await setupPage({
    context,
    path: `/agents/${AGENT_ID}/chat`,
    host: "app.okou.ai",
  });
  await openTemplatePicker(user, "Presentation");
  await waitFor(() => {
    expect(screen.getByText(uploaded.title)).toBeVisible();
  });
  click(buttonNamed(`Preview ${uploaded.title} at current slide`));
  await screen.findByRole("group", { name: `${uploaded.title} slide preview` });

  const submitted: string[] = [];
  context.mocks.api(
    presentationTemplatesContract.update,
    ({ body, params, respond }) => {
      submitted.push(body.title ?? "");
      return respond(200, {
        ...uploaded,
        ...body,
        id: params.templateId,
        updatedAt: "2026-08-01T00:01:00.000Z",
      });
    },
  );

  await fill(renameField(), "Board Review FY26");
  fireEvent.keyDown(renameField(), { key: "Enter" });
  await waitFor(() => {
    expect(submitted).toStrictEqual(["Board Review FY26"]);
  });
  await waitFor(() => {
    expect(renameField()).toHaveValue("Board Review FY26");
  });
});

test("Imported visibility saves once and closes even on the current value", async () => {
  const key = "{Enter}";
  mockTemplateChat();
  const uploaded = createUploadedTemplate({
    id: UPLOADED_TEMPLATE_ID,
    title: "Visibility keyboard review",
    visibility: "private",
    canManage: true,
  });
  const library = mockPresentationTemplateLibrary([uploaded]);
  trackTemplatePreviewImagePreloads();
  const user = userEvent.setup();
  await setupPage({
    context,
    path: `/chats/${THREAD_ID}`,
    host: "app.okou.ai",
  });
  await openTemplatePicker(user, "Presentation");
  click(
    await waitFor(() => {
      return buttonNamed(`Preview ${uploaded.title} at current slide`);
    }),
  );
  const trigger = await screen.findByLabelText("Change template visibility");
  trigger.focus();
  await user.keyboard("{Enter}");
  const menu = await screen.findByRole("menu");
  const workspace = queryAllByRoleFast("menuitemradio", menu).find((option) => {
    return option.getAttribute("aria-label") === "Workspace";
  })!;
  await user.keyboard("{Home}{ArrowDown}");
  expect(workspace).toHaveFocus();
  expect(workspace).toHaveAttribute("aria-checked", "false");
  expect(library.requests.updates).toHaveLength(0);
  await user.keyboard(key);
  await waitFor(() => {
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });
  await waitFor(() => {
    expect(trigger).toBeEnabled();
  });
  expect(library.requests.updates).toStrictEqual([
    { templateId: uploaded.id, body: { visibility: "public" } },
  ]);
  click(trigger);
  await screen.findByRole("menu");
  await user.keyboard("{Home}{ArrowDown}");
  await user.keyboard(key);
  await waitFor(() => {
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });
  expect(library.requests.updates).toHaveLength(1);
});
