import { screen, waitFor } from "@testing-library/react";
import { expect, test } from "vitest";
import { click, setupPage, startPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { accountModels } from "./chat-account-model-fixture.ts";
import { promptEvent, sendText } from "./chat-run-test-fixtures.ts";
import { composerModelTrigger } from "./chat-composer-test-helpers.ts";
import { mockChatLifecycle } from "./chat-test-helpers.ts";
import {
  openModelPanel,
  findModelOption,
  closeModelPanel,
} from "./chat-model-panel-test-helpers.ts";
import { findFastControl } from "./chat-message-experience-test-helpers.ts";
import { sol, luna } from "./model-recovery-account-fixtures.ts";
const context = testContext();
const order = [
  { id: "chat-run-models-033", late: false },
  { id: "chat-run-models-034", late: true },
] as const;
test.each(order)(
  "$id The scheduled next model outlives steering and first appears as a model change on the next task",
  async ({ late }) => {
    const thread = crypto.randomUUID(),
      run = crypto.randomUUID(),
      receipt = context.mocks.deferred<void>(),
      release = context.mocks.deferred<void>(),
      sent = context.mocks.deferred<string | null | undefined>();
    accountModels(context, [luna, sol], sol);
    let steeringId: string | undefined;
    const persisted = context.mocks.deferred<void>();
    const life = mockChatLifecycle(context, {
      threadId: thread,
      activeRunIds: [run],
      selectedModel: luna,
      chatEvents: [
        promptEvent({
          id: crypto.randomUUID(),
          runId: run,
          seqId: 1,
          text: "Initial research",
          model: sol,
        }),
      ],
      beforeEventRowsResponse: async (rows) => {
        if (
          rows.some((row) => {
            return row.id === steeringId;
          })
        ) {
          if (!persisted.settled()) {
            persisted.resolve();
          }
          await release.promise;
        }
      },
      onQueuedEventAppend: (b) => {
        expect(b.modelSelection).toBeUndefined();
        steeringId = b.clientEventId;
        receipt.resolve();
      },
      onRunCreate: (b) => {
        return sent.resolve(
          b.userMessage?.parts.find((p) => {
            return p.type === "model";
          })?.selectedModel ?? b.model,
        );
      },
    });
    await setupPage({ context, path: "/chats/" + thread });
    await screen.findByText("Initial research");
    await composerModelTrigger("GPT 5.6 Luna");
    const text = "Include the original invoices";
    await sendText(text);
    await receipt.promise;
    expect(screen.queryByText(/^Model changed/)).toBeNull();
    const settled = async () => {
      life.completeRun("Original research completed");
      await screen.findByText("Original research completed");
    };
    await persisted.promise;
    if (late) {
      life.completeRun("Original research completed");
    }
    const spinner = () => {
      return screen
        .getByText(text)
        .closest('[data-role="user"]')
        ?.querySelector("[data-optimistic-user-message]");
    };
    const painted = context.mocks.deferred<void>();
    const observePending = () => {
      if (spinner() && !painted.settled()) {
        painted.resolve();
      }
    };
    const observer = new MutationObserver(observePending);
    observer.observe(document.body, { childList: true, subtree: true });
    context.signal.addEventListener(
      "abort",
      () => {
        observer.disconnect();
      },
      { once: true },
    );
    observePending();
    await painted.promise;
    observer.disconnect();
    expect(spinner()).toBeVisible();
    release.resolve();
    await waitFor(() => {
      expect(screen.getByText(text)).toBeVisible();
      expect(spinner()).toBeNull();
    });
    if (!late) {
      await settled();
    } else {
      await screen.findByText("Original research completed");
    }
    await composerModelTrigger("GPT 5.6 Luna");
    expect(screen.queryByText(/^Model changed/)).toBeNull();
    await sendText("Prepare the next report");
    await expect(sent.promise).resolves.toBe(luna);
    await screen.findByText("Prepare the next report");
    await expect(
      screen.findByText("Model changed to GPT 5.6 Luna"),
    ).resolves.toBeVisible();
  },
);
test("prompt-link-008 A separate composer retains Claude Sonnet 5.5 after the linked GPT 6 Astra submission completes", async () => {
  const link = "Launch original research",
    next = "Send my next task with this model.",
    model = "gpt-6-astra";
  accountModels(context, [model, "claude-sonnet-5-5"], model);
  const received = context.mocks.deferred<void>(),
    release = context.mocks.deferred<void>(),
    confirmed = context.mocks.deferred<string | null | undefined>();
  const completed: string[] = [];
  mockChatLifecycle(context, {
    sendGate: ({ prompt }) => {
      return prompt === link ? release.promise : Promise.resolve();
    },
    onSendRequest: (b) => {
      if (b.prompt === link) {
        received.resolve();
      } else if (b.prompt === next) {
        confirmed.resolve(b.prompt);
      }
    },
    onThreadCreate: (b) => {
      completed.push(b.model ?? "none");
    },
  });
  const app = await startPage({
    context,
    path: "/prompt?" + new URLSearchParams({ model, prompt: link }).toString(),
  });
  await received.promise;
  click(await findFastControl("link", "Chat"));
  await waitFor(() => {
    return expect(location.pathname).toBe("/");
  });
  const panel = await openModelPanel("GPT 6 Astra");
  click(await findModelOption(/Claude Sonnet 5.5/, panel));
  await closeModelPanel();
  await composerModelTrigger("Claude Sonnet 5.5");
  let linkedStartupFinished = false;
  const linkedStartup = (async () => {
    await app.ready;
    linkedStartupFinished = true;
  })();
  release.resolve();
  await waitFor(() => {
    return expect(linkedStartupFinished).toBeTruthy();
  });
  await linkedStartup;
  await composerModelTrigger("Claude Sonnet 5.5");
  await sendText(next);
  await expect(confirmed.promise).resolves.toBe(next);
  expect(completed).toStrictEqual([model, "claude-sonnet-5-5"]);
  await expect(screen.findByText(next)).resolves.toBeVisible();
});
