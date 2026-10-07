import { browserContract } from "@okouai/api-contracts/contracts/browser";
import { chatThreadArtifactsContract } from "@okouai/api-contracts/contracts/chat-threads";
import { waitFor } from "@testing-library/react";

import { queryAllByRoleFast } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { mockChatLifecycle } from "./chat-test-helpers.ts";

export const context = testContext();

export const MESSAGE_EXPERIENCE_AGENT_ID =
  "c0000000-0000-4000-a000-000000000051";
export const ADA_AGENT_ID = "c0000000-0000-4000-a000-000000000052";
export const SOURCE_AGENT_ID = "c0000000-0000-4000-a000-000000000053";

type MockChatLifecycleOptions = NonNullable<
  Parameters<typeof mockChatLifecycle>[1]
>;

export function installMessageExperienceChat(
  options: MockChatLifecycleOptions = {},
): ReturnType<typeof mockChatLifecycle> {
  context.mocks.data.agents([
    {
      agentId: MESSAGE_EXPERIENCE_AGENT_ID,
      displayName: "Message Agent",
    },
    {
      agentId: ADA_AGENT_ID,
      displayName: "Ada",
      avatarUrl: "https://cdn.vm7.io/avatars/ada.png",
    },
    {
      agentId: SOURCE_AGENT_ID,
      displayName: "Source Agent",
      avatarUrl: "https://cdn.vm7.io/avatars/source-agent.png",
    },
  ]);
  context.mocks.api(browserContract.get, ({ respond }) => {
    return respond(404, {
      error: {
        code: "BROWSER_NOT_FOUND",
        message: "Managed browser not found",
      },
    });
  });
  context.mocks.api(chatThreadArtifactsContract.list, ({ respond }) => {
    return respond(200, { runs: [] });
  });
  return mockChatLifecycle(context, options);
}

function normalizedText(element: Element): string {
  return element.textContent?.replace(/\s+/gu, " ").trim() ?? "";
}

export function findFastControl(
  role: "button" | "link" | "radio" | "tab",
  name: string,
  container: ParentNode = document.body,
): Promise<HTMLElement> {
  return waitFor(() => {
    const control = queryAllByRoleFast(role, container).find((candidate) => {
      return (
        candidate.getAttribute("aria-label") === name ||
        normalizedText(candidate) === name
      );
    });
    if (!control) {
      throw new Error(`${role} ${name} not found`);
    }
    return control;
  });
}

export function queryFastControl(
  role: "button" | "link" | "radio" | "tab",
  name: string,
  container: ParentNode = document.body,
): HTMLElement | null {
  return (
    queryAllByRoleFast(role, container).find((candidate) => {
      return (
        candidate.getAttribute("aria-label") === name ||
        normalizedText(candidate) === name
      );
    }) ?? null
  );
}

export async function findComposer(): Promise<HTMLElement> {
  return await waitFor(() => {
    const editor = document.querySelector<HTMLElement>(
      '[data-slot="chat-composer-card"] [contenteditable="true"]',
    );
    if (!editor) {
      throw new Error("Composer editor not found");
    }
    return editor;
  });
}
