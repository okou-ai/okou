import { screen, waitFor } from "@testing-library/react";
import { expect, test } from "vitest";
import {
  queryAllByRoleFast,
  setupPage,
} from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  createChatRunFixtures,
  RUN_PATH,
  sendText,
} from "./chat-run-test-fixtures.ts";

const context = testContext();
const { installRunChat } = createChatRunFixtures(context);

test("chat-message-plain-text-links-001 preserves the typed prompt and offers separate safe destinations in the prompt and note", async () => {
  const guide = "https://guides.example.org/approvals";
  const revision = "https://review.example.org/changes/27";
  const prompt = "Read **before signing** at " + guide;
  installRunChat({
    chatEvents: [
      {
        role: "user",
        content: null,
        createdAt: "2026-09-18T16:00:00Z",
        userMessage: {
          version: 1,
          parts: [
            { type: "text", text: prompt },
            {
              type: "feedback",
              quote: "Use the revised totals.",
              note: [{ type: "text", text: "Revisions: " + revision }],
            },
          ],
        },
      },
    ],
  });
  await setupPage({ context, path: RUN_PATH });
  const quote = await screen.findByText("Use the revised totals.");
  const turn = quote.closest<HTMLElement>('[data-role="user"]')!;
  const [promptLink, noteLink] = queryAllByRoleFast("link", turn);
  expect(
    (promptLink?.previousSibling?.textContent ?? "") + promptLink?.textContent,
  ).toBe(prompt);
  expect(noteLink?.parentElement?.textContent).toBe("Revisions: " + revision);
  for (const [link, url] of [
    [promptLink, guide],
    [noteLink, revision],
  ] as const) {
    expect(link).toHaveTextContent(url);
    expect(link).toHaveAttribute("href", url);
    expect(link).toHaveAttribute("target", "_blank");
    expect((link as HTMLAnchorElement).rel.split(/\s+/)).toStrictEqual(
      expect.arrayContaining(["noopener", "noreferrer"]),
    );
  }
});

test.each([
  {
    id: "004",
    text: "Stored tokens: xhttps://guide.example.org/terms and 7https://files.example.org/notes",
  },
  {
    id: "005",
    text: "Examples: lab.example.org, ops@lab.example.org, javascript:void(0), data:text/plain,test and ftp://lab.example.org/export",
  },
])(
  "chat-message-plain-text-links-$id keeps the submitted examples as literal unlinked text",
  async ({ text }) => {
    installRunChat();
    await setupPage({ context, path: RUN_PATH });
    await sendText(text);
    const submitted = await screen.findByText(text);
    const message = submitted.closest<HTMLElement>('[data-role="user"]')!;
    expect(submitted.textContent).toBe(text);
    expect(queryAllByRoleFast("link", message)).toHaveLength(0);
  },
);

test("A long URL typed into chat keeps its full link target", async () => {
  const destination = "https://example.com/search?q=" + "x".repeat(100);
  installRunChat();
  await setupPage({ context, path: RUN_PATH });
  await sendText(destination);
  await waitFor(() => {
    const link = queryAllByRoleFast("link").find((candidate) => {
      return (
        candidate.closest('[data-role="user"]') &&
        candidate.getAttribute("href") === destination
      );
    });
    expect(link).toBeVisible();
    expect(link?.textContent).toBe(destination.slice(0, 77) + "...");
  });
});
