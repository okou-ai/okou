import { browserContract } from "@okouai/api-contracts/contracts/browser";
import type { UserMessageDocument } from "@okouai/api-contracts/contracts/chat-threads";
import { screen, waitFor, within } from "@testing-library/react";
import { expect, test } from "vitest";
import {
  click,
  fill,
  queryAllByRoleFast,
  setupPage,
} from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  AGENT_ID,
  CLAUDE_SUBSCRIPTION_PROVIDER_ID,
  createChatComposerHelpers,
  findComposerEditor,
} from "./chat-composer-test-helpers.ts";
import { buildRunModel } from "./chat-model-builders.ts";
import { mockChatLifecycle } from "./chat-test-helpers.ts";

const context = testContext();
const { mockAgent, mockBillingCapabilities, mockPersonalModelRoutes } =
  createChatComposerHelpers(context);

interface SubmittedMessage {
  readonly userMessage?: UserMessageDocument;
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
  mockBillingCapabilities({ restrictedBuiltInModels: false });
}

function recordSubmissions(): SubmittedMessage[] {
  const submissions: SubmittedMessage[] = [];
  mockChatLifecycle(context, {
    onRunCreate: (body) => {
      submissions.push(body);
    },
  });
  return submissions;
}

async function enterPresentation(): Promise<{
  editor: HTMLElement;
  picker: HTMLElement;
}> {
  await setupPage({ context, path: `/agents/${AGENT_ID}/chat` });
  const editor = await findComposerEditor();
  await fill(editor, "Our launch");
  const cards = await screen.findByRole("group", {
    name: "Explore Okou capabilities",
  });
  click(
    button(
      "Presentation",
      within(cards).getByRole("region", { name: "Create" }),
    ),
  );
  const picker = await screen.findByRole("combobox", { name: "Slide count" });
  return { editor, picker };
}

async function chooseSlideCount(
  picker: HTMLElement,
  label: string,
): Promise<void> {
  click(picker);
  click(await screen.findByRole("option", { name: label }));
  await waitFor(() => {
    expect(picker).toHaveTextContent(label);
  });
}

async function sendAndReadSubmission(
  submissions: SubmittedMessage[],
): Promise<SubmittedMessage | undefined> {
  click(button("Send"));
  await waitFor(() => {
    expect(submissions).toHaveLength(1);
  });
  return submissions[0];
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

test("Create opens presentation templates and keeps the draft", async () => {
  setupModels();
  mockChatLifecycle(context);

  const { editor } = await enterPresentation();

  await expect(
    screen.findByRole("group", { name: "Presentation templates" }),
  ).resolves.toBeInTheDocument();
  expect(editor).toHaveTextContent(/^Our launch$/);
});

test("Presentation sends the chosen slide count in additional info", async () => {
  setupModels();
  const submissions = recordSubmissions();
  const { picker } = await enterPresentation();
  await chooseSlideCount(picker, "20–24 slides");

  const submitted = await sendAndReadSubmission(submissions);

  expect(visibleText(submitted)).toBe("Our launch");
  expect(submitted?.userMessage?.parts).toContainEqual({
    type: "additional_info",
    text: expect.stringContaining("- Slide count: 20-24"),
  });
  expect(submitted?.userMessage?.parts).toContainEqual({
    type: "additional_info",
    text: expect.stringContaining(
      "Where this run's message asks for a different slide count, the message wins.",
    ),
  });
});

test("Leaving presentation hides its picker and drops its settings", async () => {
  setupModels();
  const submissions = recordSubmissions();
  const { picker } = await enterPresentation();
  await chooseSlideCount(picker, "Auto");

  click(button("Remove Presentation"));
  await waitFor(() => {
    expect(screen.queryByLabelText("Remove Presentation")).toBeNull();
  });
  expect(screen.queryByRole("combobox", { name: "Slide count" })).toBeNull();
  const submitted = await sendAndReadSubmission(submissions);

  expect(submitted?.userMessage?.parts).not.toContainEqual(
    expect.objectContaining({ type: "additional_info" }),
  );
  expect(visibleText(submitted)).toBe("Our launch");
});
