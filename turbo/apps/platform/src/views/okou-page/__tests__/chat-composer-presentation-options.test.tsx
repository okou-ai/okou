import { browserContract } from "@okouai/api-contracts/contracts/browser";
import type {
  ChatRunOptionsRequest,
  UserMessageDocument,
} from "@okouai/api-contracts/contracts/chat-threads";
import { screen, waitFor, within } from "@testing-library/react";
import { expect, test } from "vitest";
import {
  click,
  fill,
  queryAllByRoleFast,
  setupPage,
} from "../../../__tests__/page-helper.ts";
import {
  AGENT_ID,
  buildRunModel,
  CLAUDE_SUBSCRIPTION_PROVIDER_ID,
  context,
  findComposerEditor,
  mockAgent,
  mockBillingCapabilities,
  mockPersonalModelRoutes,
} from "./chat-composer-test-helpers.ts";
import { mockChatLifecycle } from "./chat-test-helpers.ts";

interface SubmittedMessage {
  readonly userMessage?: UserMessageDocument;
  readonly runOptions?: ChatRunOptionsRequest;
}

function button(label: string, container: ParentNode = document): HTMLElement {
  const result = queryAllByRoleFast("button", container).find((item) => {
    return (
      (item.getAttribute("aria-label") ?? item.textContent?.trim()) === label
    );
  });
  if (!result) {
    throw new Error(`Expected button ${label}`);
  }
  return result;
}

function setupModels(): void {
  context.mocks.api(browserContract.get, ({ respond }) => {
    return respond(404, {
      error: {
        code: "BROWSER_NOT_FOUND",
        message: "Managed browser not found",
      },
    });
  });
  mockAgent();
  mockPersonalModelRoutes();
  context.mocks.data.availableRunModels([
    buildRunModel({
      model: "claude-fable-5-1",
      modelProviderId: CLAUDE_SUBSCRIPTION_PROVIDER_ID,
    }),
  ]);
  context.mocks.data.userModelPreference({
    selectedModel: "claude-fable-5-1",
    serviceTier: null,
    modelSettings: {},
    selectedImageModel: null,
    updatedAt: null,
  });
  mockBillingCapabilities({
    restrictedBuiltInModels: false,
  });
}

async function setupComposer(): Promise<HTMLElement> {
  await setupPage({
    context,
    path: `/agents/${AGENT_ID}/chat`,
  });
  return await findComposerEditor();
}

async function enterPresentation(editor: HTMLElement): Promise<HTMLElement> {
  await fill(editor, "Our launch");
  click(
    button(
      "Presentation",
      await screen.findByRole("group", { name: "Choose a task" }),
    ),
  );
  return await screen.findByRole("combobox", { name: "Slide count" });
}

function visibleText(message: SubmittedMessage | undefined): string {
  return (
    message?.userMessage?.parts
      .flatMap((part) => {
        return part.type === "text" ? [part.text] : [];
      })
      .join("")
      .replace(/\s+/g, " ")
      .trim() ?? ""
  );
}

test("Presentation from the slash menu opens templates and keeps the draft", async () => {
  setupModels();
  mockChatLifecycle(context);
  const editor = await setupComposer();
  await fill(editor, "Our launch /");
  const menu = await screen.findByTestId("slash-workflow-menu");
  click(button("Presentation", menu));
  const dialog = await screen.findByRole("dialog");
  expect(dialog).toBeInTheDocument();
  expect(editor).toHaveTextContent(/^Our launch$/);
});

test("Presentation sends Auto as additional info without changing the message", async () => {
  setupModels();
  const submissions: SubmittedMessage[] = [];
  mockChatLifecycle(context, {
    onRunCreate: (body) => {
      submissions.push(body);
    },
  });
  const editor = await setupComposer();
  const picker = await enterPresentation(editor);
  click(picker);
  const menu = await screen.findByRole("listbox");
  click(within(menu).getByRole("option", { name: "Auto" }));
  await waitFor(() => {
    expect(picker).toHaveTextContent("Auto");
  });
  click(button("Send"));
  await waitFor(() => {
    expect(submissions).toHaveLength(1);
  });
  expect(submissions[0]?.userMessage?.parts).toContainEqual({
    type: "additional_info",
    text: expect.stringContaining("Create a presentation."),
  });
  expect(submissions[0]?.userMessage?.parts).toContainEqual({
    type: "additional_info",
    text: expect.stringContaining(
      "- Slide count: Auto (choose the number of slides based on the content)",
    ),
  });
  expect(visibleText(submissions[0])).toBe("Our launch");
});

test("Presentation instructions stay out of the sent message bubble", async () => {
  setupModels();
  mockChatLifecycle(context);
  const editor = await setupComposer();
  await enterPresentation(editor);
  click(button("Send"));
  await waitFor(() => {
    const message = document.querySelector<HTMLElement>('[data-role="user"]');
    expect(message).toBeVisible();
    expect(message).toHaveTextContent("Our launch");
    expect(message).not.toHaveTextContent("Slide count");
    expect(message).not.toHaveTextContent("Create a presentation.");
  });
});

test("Presentation sends the chosen slide count in additional info", async () => {
  const label = "20–24 slides";
  const range = "20-24";
  setupModels();
  const submissions: SubmittedMessage[] = [];
  mockChatLifecycle(context, {
    onRunCreate: (body) => {
      submissions.push(body);
    },
  });
  const editor = await setupComposer();
  const picker = await enterPresentation(editor);
  click(picker);
  click(await screen.findByRole("option", { name: label }));
  await waitFor(() => {
    expect(picker).toHaveTextContent(label);
  });
  click(button("Send"));
  await waitFor(() => {
    expect(submissions).toHaveLength(1);
  });
  expect(submissions[0]?.userMessage?.parts).toContainEqual({
    type: "additional_info",
    text: expect.stringContaining(`- Slide count: ${range}`),
  });
  expect(submissions[0]?.userMessage?.parts).toContainEqual({
    type: "additional_info",
    text: expect.stringContaining(
      "Where this run's message asks for a different slide count, the message wins.",
    ),
  });
  expect(visibleText(submissions[0])).toBe("Our launch");
});

test("Leaving presentation hides its picker and drops its settings", async () => {
  setupModels();
  const submissions: SubmittedMessage[] = [];
  mockChatLifecycle(context, {
    onRunCreate: (body) => {
      submissions.push(body);
    },
  });
  const editor = await setupComposer();
  const picker = await enterPresentation(editor);
  click(picker);
  click(await screen.findByRole("option", { name: "Auto" }));
  await waitFor(() => {
    expect(picker).toHaveTextContent("Auto");
  });
  click(button("Remove Presentation"));
  await waitFor(() => {
    expect(screen.queryByLabelText("Remove Presentation")).toBeNull();
  });
  expect(screen.queryByRole("combobox", { name: "Slide count" })).toBeNull();
  click(button("Send"));
  await waitFor(() => {
    expect(submissions).toHaveLength(1);
  });
  expect(submissions[0]?.userMessage?.parts).not.toContainEqual(
    expect.objectContaining({ type: "additional_info" }),
  );
  expect(visibleText(submissions[0])).toBe("Our launch");
});
