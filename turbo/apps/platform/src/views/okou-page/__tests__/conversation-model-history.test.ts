import { screen, waitFor, fireEvent } from "@testing-library/react";
import { expect, test } from "vitest";
import { setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { mockChatLifecycle } from "./chat-test-helpers.ts";
import {
  completedEvent,
  promptEvent,
  sendText,
} from "./chat-run-test-fixtures.ts";
import { accountModels } from "./chat-account-model-fixture.ts";
import { composerModelTrigger } from "./chat-composer-test-helpers.ts";
import { luna, sol } from "./model-recovery-account-fixtures.ts";
const context = testContext();
test("chat-run-models-036 A new conversation sends its visible message with Claude Sonnet 5 attribution", async () => {
  const selected = "claude-sonnet-5",
    text = "Preserve this model attribution.";
  accountModels(context, [selected], selected);
  const sent = context.mocks.deferred<unknown>();
  mockChatLifecycle(context, {
    onSendRequest: (b) => {
      return sent.resolve(b.userMessage?.parts);
    },
  });
  await setupPage({ context, path: "/" });
  await composerModelTrigger("Claude Sonnet 5");
  await sendText(text);
  await expect(sent.promise).resolves.toStrictEqual(
    expect.arrayContaining([
      expect.objectContaining({ type: "text", text }),
      expect.objectContaining({ type: "model", selectedModel: selected }),
    ]),
  );
  await waitFor(() => {
    return expect(location.pathname).toMatch(/^\/chats\//);
  });
  await expect(screen.findByText(text)).resolves.toBeVisible();
});
test("chat-run-models-039 Four completed runs show one model transition followed by Fast on and Fast off", async () => {
  const thread = crypto.randomUUID();
  accountModels(context, [sol, luna], luna);
  const selections = [
    { model: sol, fast: false },
    { model: luna, fast: false },
    { model: luna, fast: true },
    { model: luna, fast: false },
  ];
  const rows = selections.flatMap(({ model, fast }, index) => {
    const runId = crypto.randomUUID(),
      seqId = 2 * index + 1;
    return [
      promptEvent({
        id: crypto.randomUUID(),
        runId,
        seqId,
        text: "Research step " + (index + 1),
        model,
        serviceTier: fast ? "priority" : null,
      }),
      completedEvent({ id: crypto.randomUUID(), runId, seqId: seqId + 1 }),
    ];
  });
  mockChatLifecycle(context, {
    threadId: thread,
    selectedModel: luna,
    chatEvents: rows,
  });
  await setupPage({ context, path: "/chats/" + thread });
  await screen.findByText("Research step 4");
  const viewport = screen
    .getByText("Research step 4")
    .closest<HTMLElement>("[data-scroll-container]")!;
  Object.defineProperty(viewport, "clientHeight", {
    configurable: true,
    value: 600,
  });
  Object.defineProperty(viewport, "scrollHeight", {
    configurable: true,
    value: 1600,
  });
  viewport.scrollTop = 180;
  fireEvent.scroll(viewport);
  fireEvent.wheel(viewport, { deltaY: -200 });
  viewport.scrollTop = 0;
  fireEvent.scroll(viewport);
  await screen.findByText("Research step 1");
  await screen.findByText("Model changed to GPT 5.6 Luna");
  const transitions = screen.getAllByText(
    /^(Model changed to |Fast mode (on|off)$)/,
  );
  expect(
    transitions.map((line) => {
      return line.textContent;
    }),
  ).toStrictEqual([
    "Model changed to GPT 5.6 Luna",
    "Fast mode on",
    "Fast mode off",
  ]);
});
test("chat-run-models-035 A follow-up to an active Fast run retains its speed without setting a separate model", async () => {
  const thread = crypto.randomUUID(),
    runId = crypto.randomUUID(),
    queued = context.mocks.deferred<{
      selection: unknown;
      parts: unknown;
      options: unknown;
    }>();
  accountModels(context, [sol], sol, {}, "priority");
  mockChatLifecycle(context, {
    threadId: thread,
    activeRunIds: [runId],
    selectedModel: sol,
    codexServiceTier: "fast",
    chatEvents: [
      promptEvent({
        id: crypto.randomUUID(),
        runId,
        seqId: 1,
        text: "Start the investigation",
        model: sol,
        serviceTier: "priority",
      }),
    ],
    onQueuedEventAppend: (b) => {
      return queued.resolve({
        selection: b.modelSelection,
        parts: b.userMessage?.parts,
        options: b.runOptions,
      });
    },
  });
  await setupPage({ context, path: "/chats/" + thread });
  await screen.findByText("Start the investigation");
  await sendText("Also inspect the July report");
  const delivery = await queued.promise;
  expect(delivery.selection).toBeUndefined();
  expect(delivery.parts).toStrictEqual(
    expect.arrayContaining([
      expect.objectContaining({
        type: "text",
        text: "Also inspect the July report",
      }),
    ]),
  );
  expect(delivery.parts).not.toStrictEqual(
    expect.arrayContaining([expect.objectContaining({ type: "model" })]),
  );
  await expect(
    screen.findByText("Also inspect the July report"),
  ).resolves.toBeVisible();
  expect(delivery.options).toMatchObject({ codexServiceTier: "fast" });
  expect(screen.queryByText(/^Model changed to/)).toBeNull();
});
