import { logsByIdContract } from "@okouai/api-contracts/contracts/logs";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";

import {
  click,
  queryAllByRoleFast,
  setupPage,
} from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import type { MockChatEventInput } from "./chat-event-test-helpers.ts";
import {
  createChatRunFixtures,
  promptEvent,
  readyChat,
  RUN_PATH,
} from "./chat-run-test-fixtures.ts";

const context = testContext();
const { installRunChat } = createChatRunFixtures(context);
const LAUNCH_RUN_ID = "d0000000-0000-4000-a000-000000000c01";
const DIGEST_RUN_ID = "d0000000-0000-4000-a000-000000000c02";
const LEGACY_RUN_ID = "d0000000-0000-4000-a000-000000000c03";

/** Run details the activity page reads for each run. */
function mockRunDetails(names: Readonly<Record<string, string>>): void {
  context.mocks.api(logsByIdContract.getById, ({ params, respond }) => {
    const displayName = names[params.id];
    if (!displayName) {
      return respond(404, {
        error: { code: "NOT_FOUND", message: "Run not found" },
      });
    }
    return respond(200, {
      id: params.id,
      sessionId: `session-${params.id}`,
      agentId: "c0000000-0000-4000-a000-000000000001",
      displayName,
      framework: "claude-code",
      modelProvider: null,
      selectedModel: null,
      triggerSource: "web",
      status: "running",
      prompt: displayName,
      appendSystemPrompt: null,
      createdAt: "2026-11-20T07:00:00.000Z",
      startedAt: "2026-11-20T07:00:01.000Z",
      completedAt: null,
    });
  });
}

async function openDebugChat(
  chatEvents: MockChatEventInput[],
  activeRunIds: string[] = [],
  debug = true,
): Promise<void> {
  installRunChat({ chatEvents, activeRunIds });
  await setupPage({
    context,
    path: RUN_PATH,
    featureSwitches: { [FeatureSwitchKey.OkouDebug]: debug },
  });
  await readyChat();
}

/** The action row under the user message that shows `text`. */
async function messageActions(text: string): Promise<HTMLElement> {
  return await waitFor(() => {
    const rows = document.querySelectorAll<HTMLElement>(
      "[data-chat-user-message-actions]",
    );
    const row = [...rows].find((candidate) => {
      return candidate.parentElement?.textContent?.includes(text);
    });
    if (!row) {
      throw new Error(`Expected actions for "${text}"`);
    }
    return row;
  });
}

function control(
  role: "button" | "link",
  name: string,
  container: HTMLElement,
): HTMLElement | undefined {
  return queryAllByRoleFast(role, container).find((candidate) => {
    return candidate.getAttribute("aria-label") === name;
  });
}

test("Keep Copy to the right of an active run's logs before any assistant output", async () => {
  await openDebugChat(
    [
      promptEvent({
        id: "launch-prompt",
        runId: LAUNCH_RUN_ID,
        seqId: 1,
        text: "Review the launch checklist",
      }),
    ],
    [LAUNCH_RUN_ID],
  );
  // Registered after the chat fixture so these run details answer.
  mockRunDetails({ [LAUNCH_RUN_ID]: "Launch review" });
  const actions = await messageActions("Review the launch checklist");
  const logs = control("link", "View run logs", actions);
  const copy = control("button", "Copy message", actions);

  expect(copy).toBeDefined();
  expect(logs).toHaveAttribute("href", `/activities/${LAUNCH_RUN_ID}`);
  // Logs come first, so Copy stays on their right.
  expect(logs?.compareDocumentPosition(copy as HTMLElement) ?? 0).toBe(
    Node.DOCUMENT_POSITION_FOLLOWING,
  );

  await userEvent.setup({ delay: null }).click(logs as HTMLElement);

  await expect(
    screen.findByRole("heading", { name: "Launch review" }),
  ).resolves.toBeInTheDocument();
  expect(window.location.pathname).toBe(`/activities/${LAUNCH_RUN_ID}`);
});

test("Do not show user run logs before a run ID is assigned", async () => {
  await openDebugChat([
    {
      ...promptEvent({
        id: "unassigned-prompt",
        seqId: 1,
        text: "Draft the release notes",
      }),
      runId: undefined,
    },
  ]);

  const actions = await messageActions("Draft the release notes");

  expect(control("button", "Copy message", actions)).toBeDefined();
  expect(control("link", "View run logs", actions)).toBeUndefined();
  expect(
    queryAllByRoleFast("link").find((link) => {
      return link.getAttribute("aria-label") === "View run logs";
    }),
  ).toBeUndefined();
});

/** The text the latest Copy put on the clipboard, plain or rich. */
async function copiedText(clipboard: {
  readonly plain: { readonly writes: readonly string[] };
  readonly rich: { readonly writes: readonly ClipboardItem[][] };
}): Promise<string | undefined> {
  const item = clipboard.rich.writes.at(-1)?.[0];
  if (item) {
    return await (await item.getType("text/plain")).text();
  }
  return clipboard.plain.writes.at(-1);
}

test("Copy workflow trigger bubbles and inspect their associated runs", async () => {
  await openDebugChat([
    {
      id: "digest-trigger",
      role: "user",
      eventType: "input.automation",
      content: null,
      runId: DIGEST_RUN_ID,
      seqId: 1,
      createdAt: "2026-11-20T07:00:00.000Z",
      userMessage: {
        version: 1,
        parts: [
          { type: "automation", workflowName: "Weekly digest" },
          { type: "text", text: "Summarize this week's launches" },
        ],
      },
    },
    {
      id: "legacy-trigger",
      role: "user",
      eventType: "input.automation",
      content: null,
      runId: LEGACY_RUN_ID,
      seqId: 2,
      createdAt: "2026-11-20T07:05:00.000Z",
      userMessage: {
        version: 1,
        parts: [
          {
            type: "automation",
            workflowName: "CRM sync",
            automationBrief: "Sync the CRM notes",
          },
        ],
      },
    },
  ]);
  mockRunDetails({
    [DIGEST_RUN_ID]: "Weekly digest run",
    [LEGACY_RUN_ID]: "CRM sync run",
  });
  const clipboard = {
    plain: context.mocks.browser.clipboardWriteText(),
    rich: context.mocks.browser.clipboardWrite(),
  };
  const digest = await messageActions("Summarize this week's launches");
  const legacy = await messageActions("Sync the CRM notes");

  click(control("button", "Copy message", digest) as HTMLElement);
  await waitFor(async () => {
    await expect(copiedText(clipboard)).resolves.toBe(
      "Summarize this week's launches",
    );
  });
  click(control("button", "Copy message", legacy) as HTMLElement);
  await waitFor(async () => {
    await expect(copiedText(clipboard)).resolves.toBe("Sync the CRM notes");
  });
  expect(control("link", "View run logs", digest)).toHaveAttribute(
    "href",
    `/activities/${DIGEST_RUN_ID}`,
  );
  expect(control("link", "View run logs", legacy)).toHaveAttribute(
    "href",
    `/activities/${LEGACY_RUN_ID}`,
  );

  await userEvent
    .setup({ delay: null })
    .click(control("link", "View run logs", digest) as HTMLElement);

  await expect(
    screen.findByRole("heading", { name: "Weekly digest run" }),
  ).resolves.toBeInTheDocument();
  expect(window.location.pathname).toBe(`/activities/${DIGEST_RUN_ID}`);
});

test("Copy and paste a structured chat message from the keyboard without flattening it", async () => {
  await openDebugChat(
    [
      {
        id: "structured-prompt",
        role: "user",
        // Older clients stored a flattened copy beside the structured message.
        content: "Legacy flattened launch notes",
        runId: LAUNCH_RUN_ID,
        seqId: 1,
        createdAt: "2026-11-20T07:00:00.000Z",
        userMessage: {
          version: 1,
          parts: [
            { type: "text", text: "Tighten the launch plan" },
            {
              type: "file",
              fileId: "file-launch-plan",
              filenameSnapshot: "launch-plan.pdf",
              contentType: "application/pdf",
            },
            {
              type: "feedback",
              quote: "Q3 revenue target",
              note: [{ type: "text", text: "Use the revised forecast" }],
            },
            {
              type: "template",
              titleSnapshot: "Launch deck",
              template: {
                type: "presentation",
                selection: { templateId: "launch-deck" },
              },
            },
          ],
        },
      },
    ],
    [],
    false,
  );
  // user-event installs its own clipboard, so the boundary mock follows it.
  const user = userEvent.setup({ delay: null });
  const clipboard = context.mocks.browser.clipboardWrite();
  const actions = await messageActions("Tighten the launch plan");

  control("button", "Copy message", actions)?.focus();
  await user.keyboard("{Enter}");

  const item = await waitFor(() => {
    const written = clipboard.writes.at(-1)?.[0];
    if (!written) {
      throw new Error("Expected a rich clipboard write");
    }
    return written;
  });
  const plain = await (await item.getType("text/plain")).text();
  const html = await (await item.getType("text/html")).text();
  expect(plain).toMatch(/^Tighten the launch plan\n/u);
  // One attachment, named and linked by its private file URL.
  expect(plain).toMatch(
    /\n\nAttachments:\n- launch-plan\.pdf: http:\/\/localhost\/api\/web\/file-url\?file_id=file-launch-plan$/u,
  );
  expect(plain).not.toContain("Legacy flattened launch notes");
  expect(html).not.toContain("Legacy flattened launch notes");

  const composer = screen.getByRole("textbox", { name: "Message" });
  await user.click(composer);
  const pasted = new DataTransfer();
  pasted.setData("text/plain", plain);
  pasted.setData("text/html", html);
  await user.paste(pasted);

  const card = composer.closest<HTMLElement>(
    '[data-slot="chat-composer-card"]',
  );
  if (!card) {
    throw new Error("Expected the composer card");
  }
  await waitFor(() => {
    expect(control("button", "Remove launch-plan.pdf", card)).toBeDefined();
  });
  expect(composer).toHaveTextContent("Tighten the launch plan");
  expect(card).toHaveTextContent("Use the revised forecast");
  expect(card).not.toHaveTextContent("Legacy flattened launch notes");
  expect(control("button", "Preview template Launch deck", card)).toBeEnabled();
});
