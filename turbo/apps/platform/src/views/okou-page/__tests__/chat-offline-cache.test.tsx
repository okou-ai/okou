import { screen } from "@testing-library/react";
import { expect, test } from "vitest";
import { startPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { queryBootstrapSkeleton } from "../../../test/bootstrap-skeleton.ts";
import {
  continuityThread,
  installContinuityWorkspace,
} from "./chat-continuity-test-helpers.ts";
import { installChatListStream } from "./chat-list-test-helpers.ts";
import { findComposer } from "./chat-message-experience-test-helpers.ts";

const context = testContext();

test("chat-offline-cache-003 confirmed absence replaces the remembered chat and dismisses loading", async () => {
  const thread = continuityThread(768, 1, "Remembered workspace chat");
  const gate = context.mocks.deferred<void>();
  const w = installContinuityWorkspace(context, {
    caseId: 768,
    threads: [thread],
  });
  installChatListStream(context, {
    caseId: 768,
    snapshot: [],
    remoteGate: gate.promise,
  });
  const started = await startPage({
    context,
    path: "/chats/" + thread.id,
    ...w.pageOptions,
  });
  await screen.findByText("Remembered workspace chat", {
    selector: '[data-testid="chat-thread-header-title"]',
  });
  await expect(findComposer()).resolves.toBeEnabled();
  gate.resolve();
  await started.ready;
  await screen.findByText("Chat thread not found");
  expect(screen.queryByRole("textbox", { name: "Message" })).toBeNull();
  expect(queryBootstrapSkeleton()).toHaveAttribute("aria-hidden", "true");
});
