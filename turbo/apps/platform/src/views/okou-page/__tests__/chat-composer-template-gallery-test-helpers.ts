import type { TestContext } from "../../../signals/__tests__/test-helpers.ts";
import type {
  GenerationTemplateRequest,
  UserMessageDocument,
} from "@okouai/api-contracts/contracts/chat-threads";
import { browserContract } from "@okouai/api-contracts/contracts/browser";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { HttpResponse } from "msw";
import { expect } from "vitest";

import {
  AGENT_ID,
  THREAD_ID,
  tabByText,
  createChatComposerHelpers,
} from "./chat-composer-test-helpers.ts";
import { mockChatLifecycle } from "./chat-test-helpers.ts";
import { clickComposerAddMenuItem } from "./chat-composer-add-menu-test-helpers.ts";
import { click } from "../../../__tests__/page-helper.ts";

export { AGENT_ID, THREAD_ID };

interface TemplateChatCapture {
  readonly sentMessages: UserMessageDocument[];
  readonly selectedTemplates: GenerationTemplateRequest[];
  readonly runPrompts: string[];
  readonly runClientThreadIds: (string | undefined)[];
  readonly threadCreates: string[];
  readonly lifecycle: ReturnType<typeof mockChatLifecycle>;
}

export async function openTemplatePicker(
  _user: ReturnType<typeof userEvent.setup>,
  category?: "Presentation" | "Website" | "Image",
): Promise<HTMLElement> {
  await clickComposerAddMenuItem("Template");
  const dialog = await waitFor(() => {
    return screen.getByRole("dialog");
  });
  if (category) {
    const tab = tabByText(category);
    if (tab.getAttribute("aria-selected") !== "true") {
      click(tab);
    }
  }
  return dialog;
}

function presentationHtml(slideTitles: readonly string[]): string {
  return `<!doctype html><html><body>${slideTitles
    .map((title, index) => {
      return `<section data-okou-slide data-slide-id="slide-${index + 1}"><h1 data-okou-editable="text">${title}</h1></section>`;
    })
    .join("")}</body></html>`;
}

export function templatePart(
  message: UserMessageDocument,
): Extract<UserMessageDocument["parts"][number], { type: "template" }> {
  const part = message.parts.find((candidate) => {
    return candidate.type === "template";
  });
  if (!part || part.type !== "template") {
    throw new Error("Sent message has no template part");
  }
  return part;
}

export async function sendComposerMessage(
  user: ReturnType<typeof userEvent.setup>,
  text: string,
): Promise<void> {
  const editor = await waitFor(() => {
    const candidate = document.querySelector<HTMLElement>(
      '[data-slot="chat-composer-card"] [contenteditable="true"]',
    );
    if (!candidate) {
      throw new Error("Composer editor not found");
    }
    return candidate;
  });
  // Append text without selecting the existing inline template nodes.
  await user.click(editor);
  await user.paste(text);
  await user.keyboard("{Enter}");
}

export async function expectInlineTemplate(
  title: string,
): Promise<HTMLElement> {
  return await waitFor(() => {
    const node = Array.from(
      document.querySelectorAll<HTMLElement>("[data-composer-inline-template]"),
    ).find((candidate) => {
      return candidate.textContent?.includes(title);
    });
    expect(node).toBeInTheDocument();
    if (!node) {
      throw new Error(`Inline template ${title} not found`);
    }
    return node;
  });
}

export function createTemplateGalleryHelpers(context: TestContext) {
  const { mockAgent, mockBillingCapabilities, mockPersonalModelRoutes } =
    createChatComposerHelpers(context);
  function mockTemplateChat(options?: {
    readonly threadId?: string;
    readonly tier?: string;
  }): TemplateChatCapture {
    const sentMessages: UserMessageDocument[] = [];
    const selectedTemplates: GenerationTemplateRequest[] = [];
    const runPrompts: string[] = [];
    const runClientThreadIds: (string | undefined)[] = [];
    const threadCreates: string[] = [];

    mockAgent();
    mockPersonalModelRoutes();
    context.mocks.api(browserContract.get, ({ respond }) => {
      return respond(404, {
        error: {
          code: "BROWSER_NOT_FOUND",
          message: "Managed browser not found",
        },
      });
    });
    mockBillingCapabilities(
      { restrictedBuiltInModels: false },
      options?.tier ?? "pro",
    );
    const lifecycle = mockChatLifecycle(context, {
      threadId: options?.threadId ?? THREAD_ID,
      selectedModel: "claude-sonnet-5",
      onThreadCreate(body) {
        threadCreates.push(body.clientThreadId ?? "server-selected");
      },
      onRunCreate(body) {
        runPrompts.push(body.prompt ?? "");
        runClientThreadIds.push(body.clientThreadId);
        if (body.userMessage) {
          sentMessages.push(body.userMessage);
          selectedTemplates.push(
            ...body.userMessage.parts.flatMap((part) => {
              return part.type === "template" ? [part.template] : [];
            }),
          );
        }
      },
    });

    return {
      sentMessages,
      selectedTemplates,
      runPrompts,
      runClientThreadIds,
      threadCreates,
      lifecycle,
    };
  }

  function mockPresentationHtml(
    embedUrl: string,
    slideTitles: readonly string[],
  ): void {
    context.mocks.http.get(embedUrl, () => {
      return new HttpResponse(presentationHtml(slideTitles), {
        headers: { "Content-Type": "text/html" },
      });
    });
  }

  return {
    mockTemplateChat,
    mockPresentationHtml,
  };
}
