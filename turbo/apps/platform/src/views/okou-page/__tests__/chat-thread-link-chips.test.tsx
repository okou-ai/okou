import { screen, within } from "@testing-library/react";
import { expect, test } from "vitest";
import {
  setupPage,
  queryAllByRoleFast,
} from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  mockAttachmentChat,
  ATTACHMENT_THREAD_ID,
  ATTACHMENT_RUN_ID,
} from "./chat-attachment-test-helpers.ts";
const context = testContext();
test("chat-thread-link-chips-001 preserves the destination and authored label of chat references in the transcript", async () => {
  const path = "/chats/0cc5555b-52a2-4b68-80f7-b30145551234";
  const chat = `https://app.okou.ai${path}`;
  const deep = path + "?view=notes#decision";
  const deepUrl = `https://app.okou.ai${deep}`;
  const external = "https://studio.example.com/calendar";
  mockAttachmentChat(context, {
    chatEvents: [
      {
        role: "user",
        content: `Read ${chat} and start at ${deepUrl} alongside ${external}`,
        runId: ATTACHMENT_RUN_ID,
        seqId: 1,
        createdAt: "2026-08-02T02:00:00Z",
      },
      {
        role: "assistant",
        content: `See ${chat}, [Decision notes](${deep}) and [Calendar](${external}). Literal: \`${chat}\``,
        runId: ATTACHMENT_RUN_ID,
        seqId: 2,
        createdAt: "2026-08-02T02:10:00Z",
      },
    ],
  });
  await setupPage({ context, path: `/chats/${ATTACHMENT_THREAD_ID}` });
  const label = await screen.findByLabelText("Open chat Decision notes");
  const reply = label.closest<HTMLElement>("[data-role='assistant']")!;
  const message = await screen.findByText(chat, {
    selector: "[data-role='user'] a span",
  });
  const userTurn = message.closest<HTMLElement>("[data-role='user']")!;
  for (const turn of [userTurn, reply]) {
    const scoped = within(turn);
    expect(scoped.getByLabelText(`Open chat ${chat}`)).toHaveAttribute(
      "href",
      path,
    );
    const outbound = queryAllByRoleFast("link", turn).find((link) => {
      return link.getAttribute("href") === external;
    });
    expect(outbound).toHaveAttribute("target", "_blank");
    expect(outbound?.getAttribute("rel")?.split(/\s+/)).toStrictEqual(
      expect.arrayContaining(["noopener", "noreferrer"]),
    );
  }
  expect(
    within(userTurn).getByLabelText(`Open chat ${deepUrl}`),
  ).toHaveAttribute("href", deep);
  expect(label).toHaveTextContent("Decision notes");
  expect(label).toHaveAttribute("href", deep);
  const code = within(reply).getByText(chat, { selector: "code" });
  expect(code.closest("a")).toBeNull();
  expect(queryAllByRoleFast("link", reply)).toHaveLength(3);
});
