import { webFilesContract } from "@okouai/api-contracts/contracts/web-files";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { expect, test } from "vitest";

import {
  click,
  queryAllByRoleFast,
  setupPage,
} from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import type { MockChatEventInput } from "./chat-event-test-helpers.ts";
import { mockChatGeometry } from "./chat-conversation-locator-test-helpers.ts";
import { createMessageExperienceHelpers } from "./chat-message-experience-test-helpers.ts";

const context = testContext();
const { installMessageExperienceChat } =
  createMessageExperienceHelpers(context);
const THREAD_ID = "b0000000-0000-4000-a000-000000000e01";
const REFERENCE_TURN = 5;
const IMAGES = [
  {
    fileId: "e0000000-0000-4000-a000-000000000e11",
    filename: "storefront-before.png",
    url: "https://files.example.test/resolved/storefront-before.png",
  },
  {
    fileId: "e0000000-0000-4000-a000-000000000e12",
    filename: "storefront-after.png",
    url: "https://files.example.test/resolved/storefront-after.png",
  },
] as const;

function conversation(): MockChatEventInput[] {
  return Array.from({ length: 9 }, (_, turn) => {
    const runId = `d0000000-0000-4000-a000-0000000e10${String(turn).padStart(2, "0")}`;
    const question = `Question ${turn}`;
    return [
      {
        id: `question-${turn}`,
        role: "user" as const,
        content: question,
        runId,
        seqId: turn * 3 + 1,
        createdAt: "2026-11-21T08:00:00.000Z",
        ...(turn === REFERENCE_TURN
          ? {
              userMessage: {
                version: 1 as const,
                parts: [
                  ...IMAGES.map((image) => {
                    return {
                      type: "file" as const,
                      fileId: image.fileId,
                      filenameSnapshot: image.filename,
                      contentType: "image/png",
                    };
                  }),
                  { type: "text" as const, text: question },
                ],
              },
            }
          : {}),
      },
      {
        id: `answer-${turn}`,
        role: "assistant" as const,
        content: `Answer ${turn}`,
        runId,
        seqId: turn * 3 + 2,
        createdAt: "2026-11-21T08:00:01.000Z",
      },
      {
        id: `complete-${turn}`,
        role: "assistant" as const,
        content: null,
        runId,
        runLifecycleEvent: "completed" as const,
        seqId: turn * 3 + 3,
        createdAt: "2026-11-21T08:00:02.000Z",
      },
    ];
  }).flat();
}

test("A restored historical turn opens both saved attachments", async () => {
  installMessageExperienceChat({
    threadId: THREAD_ID,
    chatEvents: conversation(),
  });
  context.mocks.api(webFilesContract.fileUrl, ({ query, respond }) => {
    const image = IMAGES.find((candidate) => {
      return candidate.fileId === query.file_id;
    });
    if (!image) {
      return respond(404, {
        error: { code: "FILE_NOT_FOUND", message: "File not found" },
      });
    }
    return respond(200, {
      url: image.url,
      downloadUrl: `${image.url}?download=1`,
      expiresAt: "2099-01-01T00:00:00.000Z",
      publicUrl: null,
    });
  });
  mockChatGeometry();
  await setupPage({
    context,
    path: `/chats/${THREAD_ID}`,
    host: "app.okou.ai",
  });
  await expect(screen.findByText("Answer 8")).resolves.toBeInTheDocument();
  expect(
    screen.queryByText(`Question ${REFERENCE_TURN}`),
  ).not.toBeInTheDocument();

  const viewport = document.querySelector<HTMLElement>(
    `[data-chat-thread-container-id="${THREAD_ID}"] [data-scroll-container]`,
  );
  if (!viewport) {
    throw new Error("Missing conversation scroll viewport");
  }
  await waitFor(() => {
    expect(viewport.scrollTop).toBeGreaterThan(60);
  });
  fireEvent.scroll(viewport);
  fireEvent.wheel(viewport, { deltaX: 0, deltaY: -240 });
  viewport.scrollTop = 60;
  fireEvent.scroll(viewport);

  const question = await screen.findByText(`Question ${REFERENCE_TURN}`);
  const turn = question.closest<HTMLElement>(
    "[data-role='user']",
  ) as HTMLElement;
  const [before, after] = IMAGES;

  click(
    queryAllByRoleFast("link", turn).find((link) => {
      return link.getAttribute("aria-label") === `Preview ${before.filename}`;
    }) as HTMLElement,
  );

  const preview = await screen.findByRole("dialog");
  await waitFor(() => {
    expect(
      within(preview).getByRole("img", { name: before.filename }),
    ).toHaveAttribute("src", before.url);
  });
  click(
    queryAllByRoleFast("button", preview).find((button) => {
      return button.getAttribute("aria-label") === "Next image artifact";
    }) as HTMLElement,
  );
  await waitFor(() => {
    expect(
      within(preview).getByRole("img", { name: after.filename }),
    ).toHaveAttribute("src", after.url);
  });
});
