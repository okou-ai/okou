import { screen } from "@testing-library/react";
import { expect, test } from "vitest";
import { setupPage } from "../../../__tests__/page-helper.ts";
import {
  testContext,
  type TestContext,
} from "../../../signals/__tests__/test-helpers.ts";
import { mockChatLifecycle } from "./chat-test-helpers.ts";
import {
  RUN_PATH,
  RUN_THREAD_ID,
  assistantEvent,
} from "./chat-run-test-fixtures.ts";
const context = testContext();
const target = "/chats/1fe33471-7edb-49ae-8cf0-2d566393935c";
async function readTranscript(
  owner: TestContext,
  host: string,
  markdown: string,
) {
  mockChatLifecycle(owner, {
    threadId: RUN_THREAD_ID,
    chatEvents: [
      assistantEvent({
        id: "case-reference",
        seqId: 1,
        runId: "650f553e-6f86-4811-acb4-a2566a46f357",
        text: markdown,
      }),
    ],
  });
  await setupPage({ context: owner, path: RUN_PATH, host });
}
test.each([
  ["staging-app.omby.ai", "https://staging-app.omby.ai"],
  ["localhost", "http://localhost"],
])(
  "chat-thread-link-001 A transcript on %s recognizes production, relative, and current-origin chat destinations",
  async (host, origin) => {
    await readTranscript(
      context,
      host,
      `[Production](https://APP.OKOU.AI:443${target}/) · [Local page](${origin}${target}) · [Same app](${target}/)`,
    );
    for (const label of ["Production", "Local page", "Same app"]) {
      await expect(
        screen.findByLabelText("Open chat " + label),
      ).resolves.toHaveAttribute("href", target);
    }
  },
);
test("chat-thread-link-002 Links in a reply retain both the view query and the chosen fragment", async () => {
  const first = target + "?tab=files#review";
  const second = target + "#notes";
  await readTranscript(
    context,
    "localhost",
    `[Review files](https://app.okou.ai${first}) then [Notes](${second})`,
  );
  await expect(
    screen.findByLabelText("Open chat Review files"),
  ).resolves.toHaveAttribute("href", first);
  await expect(
    screen.findByLabelText("Open chat Notes"),
  ).resolves.toHaveAttribute("href", second);
});
