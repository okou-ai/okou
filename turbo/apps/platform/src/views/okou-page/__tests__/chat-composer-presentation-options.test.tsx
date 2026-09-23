import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { browserContract } from "@okouai/api-contracts/contracts/browser";
import type {
  ChatRunOptionsRequest,
  UserMessageDocument,
} from "@okouai/api-contracts/contracts/chat-threads";
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
  mockOrgModelRoutes,
} from "./chat-composer-test-helpers.ts";

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
  mockOrgModelRoutes("claude-fable-5-1");
  mockBillingCapabilities({
    supportByok: true,
    restrictedBuiltInModels: false,
  });
}

async function setupComposer(): Promise<HTMLElement> {
  await setupPage({
    context,
    path: `/agents/${AGENT_ID}/chat`,
    featureSwitches: {
      [FeatureSwitchKey.ComposerSlashTemplatePanel]: true,
      [FeatureSwitchKey.ComposerTaskChips]: true,
    },
  });
  return await findComposerEditor();
}

async function enterPresentation(editor: HTMLElement): Promise<HTMLElement> {
  await fill(editor, "Our launch /");
  const menu = await screen.findByTestId("slash-workflow-menu");
  const user = userEvent.setup({ delay: null });
  // The panel's rows act on mousedown, which only a full pointer sequence fires.
  await user.click(button("Presentation", menu));
  // The row opens the template picker as well, and it covers the composer.
  await user.click(button("Close", await screen.findByRole("dialog")));
  await waitFor(() => {
    expect(screen.queryByRole("dialog")).toBeNull();
  });
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

test("Presentation sends Auto as hidden additional info while keeping the message unchanged", async () => {
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
  expect(submissions[0]?.runOptions).toBeUndefined();
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
  const text = await screen.findByText("Our launch");
  const message = text.closest<HTMLElement>('[data-role="user"]');
  expect(message).toBeVisible();
  expect(message).not.toHaveTextContent("Slide count");
  expect(message).not.toHaveTextContent("Create a presentation.");
});

test.each([
  ["8–12 slides", "8-12"],
  ["20–24 slides", "20-24"],
])("Presentation sends %s in additional info", async (label, range) => {
  setupModels();
  const submissions: SubmittedMessage[] = [];
  mockChatLifecycle(context, {
    onRunCreate: (body) => {
      submissions.push(body);
    },
  });
  const editor = await setupComposer();
  const picker = await enterPresentation(editor);
  if (range !== "8-12") {
    click(picker);
    click(await screen.findByRole("option", { name: label }));
  }
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

test("Leaving presentation hides its picker and resets its length", async () => {
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
  // Coming back starts the length over rather than restoring the last one.
  click(
    button(
      "Presentation",
      await screen.findByRole("group", {
        name: "Choose a task",
      }),
    ),
  );
  await expect(
    screen.findByRole("combobox", { name: "Slide count" }),
  ).resolves.toHaveTextContent("8–12 slides");
  click(button("Remove Presentation"));
  await waitFor(() => {
    expect(screen.queryByRole("combobox", { name: "Slide count" })).toBeNull();
  });
  click(button("Send"));
  await waitFor(() => {
    expect(submissions).toHaveLength(1);
  });
  expect(submissions[0]?.runOptions).toBeUndefined();
  expect(submissions[0]?.userMessage?.parts).not.toContainEqual(
    expect.objectContaining({ type: "additional_info" }),
  );
  expect(visibleText(submissions[0])).toBe("Our launch");
});
