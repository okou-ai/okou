import {
  chatEventsContract,
  chatThreadByIdContract,
  chatThreadDraftContract,
  chatThreadsContract,
} from "@okouai/api-contracts/contracts/chat-threads";
import { voiceIoQuotaContract } from "@okouai/api-contracts/contracts/voice-io-quota";
import { cleanup, screen, waitFor } from "@testing-library/react";
import { HttpResponse } from "msw";
import { expect, vi, describe, beforeEach, it } from "vitest";

import {
  click,
  fill,
  queryAllByRoleFast,
  setupPage,
} from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { resetSignal } from "../../../signals/utils.ts";
import { textContinuityDraft } from "./chat-continuity-test-helpers.ts";
import {
  CHAT_LIST_AGENT_ID,
  chatListAuth,
  chatListEvent,
  chatListThread,
  fastButton,
  installActiveChatBoundaries,
  installChatListAgent,
  installChatListModelPolicies,
  installChatListStream,
  seedPersistentChatListCache,
  sidebarThreadTitles,
} from "./chat-list-test-helpers.ts";

const context = testContext();
const refreshedContext = testContext();

async function enabledButton(name: string): Promise<HTMLElement> {
  await waitFor(() => {
    expect(fastButton(name)).toBeEnabled();
  });
  return fastButton(name);
}

function releasePageDom() {
  cleanup();
  vi.mocked(window.history.pushState).mockRestore();
  vi.mocked(window.history.replaceState).mockRestore();
  vi.mocked(window.history.back).mockRestore();
}

describe.each([false, true])(
  "finish voice without waiting for conversation creation confirmation (reload: %s)",
  (reloadBeforeRetry) => {
    async function prepareScenario() {
      const auth = chatListAuth(49);
      const resetInitialPage$ = resetSignal();
      const initialPageSignal = context.store.set(
        resetInitialPage$,
        context.signal,
      );
      const resetRefreshedPage$ = resetSignal();
      const refreshedPageSignal = refreshedContext.store.set(
        resetRefreshedPage$,
        refreshedContext.signal,
      );
      await seedPersistentChatListCache(49, auth, []);
      let createdThreadId: string | undefined;
      let createdEventId: string | undefined;
      let persistedDraft = textContinuityDraft("");
      installChatListAgent(context);
      installChatListModelPolicies(context);
      context.mocks.data.userModelPreference({
        selectedModel: "gpt-5.6-luna",
        serviceTier: null,
        modelSettings: {},
        selectedVideoModel: null,
        selectedImageModel: null,
        updatedAt: "2026-08-01T00:00:00.000Z",
      });
      installActiveChatBoundaries(context);
      const stream = installChatListStream(context, {
        caseId: 49,
        snapshot: [],
      });
      context.mocks.api(chatThreadsContract.create, ({ body, respond }) => {
        createdThreadId = body.clientThreadId;
        createdEventId = body.eventId;
        return respond(201, {
          id: body.clientThreadId!,
          title: null,
          createdAt: "2026-08-01T03:00:00.000Z",
          selectedModel: body.model ?? "gpt-5.6-luna",
          serviceTier: body.serviceTier ?? null,
        });
      });
      context.mocks.api(chatEventsContract.send, ({ body, respond }) => {
        return respond(201, {
          runId: "a7000000-0000-4000-a000-000000000049",
          threadId: body.threadId!,
          status: "pending",
          createdAt: "2026-08-01T03:00:01.000Z",
        });
      });
      context.mocks.api(chatThreadDraftContract.get, ({ respond }) => {
        return respond(200, persistedDraft);
      });
      context.mocks.api(chatThreadByIdContract.patch, ({ body, respond }) => {
        if (body.draftUserMessage !== undefined) {
          persistedDraft = {
            draftUserMessage: body.draftUserMessage,
            draftAttachments: body.draftAttachments ?? null,
          };
        }
        return respond(204);
      });
      context.mocks.browser.voiceInput({ rms: 0.12 });
      context.mocks.api(voiceIoQuotaContract.get, ({ respond }) => {
        return respond(200, { allowed: true, count: 0, limit: 60 });
      });
      let transcriptionRequests = 0;
      context.mocks.http.post("*/api/voice-io/transcribe/segment", () => {
        transcriptionRequests += 1;
        if (transcriptionRequests === 1) {
          return HttpResponse.json(
            { error: "Temporary transcription outage" },
            { status: 503 },
          );
        }
        return HttpResponse.json({
          transcript: "voice follow up",
          polishedText: "Voice follow-up.",
          language: "en-US",
        });
      });
      function publishThreadConfirmation(): void {
        if (!createdThreadId || !createdEventId) {
          throw new Error("Expected thread creation identifiers");
        }
        stream.setEvents([
          chatListEvent(49, 2, "created", createdThreadId, {
            id: createdEventId,
            title: "Confirmed conversation",
            selectedModel: "gpt-5.6-luna",
          }),
        ]);
        installActiveChatBoundaries(context, {
          metadata: chatListThread(49, "Confirmed conversation", {
            id: createdThreadId,
            selectedModel: "gpt-5.6-luna",
          }),
        });
      }

      await setupPage({
        locale: "en-US",
        context: { ...context, signal: initialPageSignal },
        path: `/agents/${CHAT_LIST_AGENT_ID}/chat`,
        auth,
      });
      await fill(
        await screen.findByRole("textbox", { name: "Message" }),
        "Start the conversation",
      );
      click(await enabledButton("Send"));
      await waitFor(() => {
        expect(sidebarThreadTitles()).toStrictEqual(["New chat"]);
        expect(createdThreadId).toBeDefined();
        expect(createdEventId).toBeDefined();
      });
      click(await enabledButton("Voice input"));
      click(await enabledButton("Stop recording"));
      await enabledButton("Retry");
      return {
        get createdThreadId() {
          return createdThreadId;
        },
        set createdThreadId(next: typeof createdThreadId) {
          createdThreadId = next;
        },
        get createdEventId() {
          return createdEventId;
        },
        set createdEventId(next: typeof createdEventId) {
          createdEventId = next;
        },
        resetInitialPage$,
        publishThreadConfirmation,
        refreshedPageSignal,
        auth,
      };
    }
    let preparedScenario: Awaited<ReturnType<typeof prepareScenario>>;
    beforeEach(async () => {
      preparedScenario = await prepareScenario();
    });
    it("finishes voice recovery before conversation confirmation", async () => {
      const {
        resetInitialPage$,
        publishThreadConfirmation,
        refreshedPageSignal,
        auth,
      } = preparedScenario;
      click(await enabledButton("Retry"));
      await waitFor(() => {
        expect(
          screen.getByRole("textbox", { name: "Message" }),
        ).toHaveTextContent("Voice follow-up.");
      });
      // Text handoff completes voice recovery even while the optimistic thread
      // cannot save a text draft. Refreshing before text persistence is outside
      // the recording module's recovery boundary.
      await enabledButton("Voice input");

      if (
        !preparedScenario.createdThreadId ||
        !preparedScenario.createdEventId
      ) {
        throw new Error("Expected thread creation identifiers");
      }
      if (reloadBeforeRetry) {
        context.store.set(resetInitialPage$);
        releasePageDom();
        publishThreadConfirmation();
        await setupPage({
          locale: "en-US",
          context: { ...refreshedContext, signal: refreshedPageSignal },
          path: `/chats/${preparedScenario.createdThreadId}`,
          auth,
        });
      } else {
        publishThreadConfirmation();
        context.mocks.ably.trigger("threadListChanged");
      }
      await waitFor(() => {
        expect(sidebarThreadTitles()).toStrictEqual(["Confirmed conversation"]);
      });
      await enabledButton("Voice input");
      const expectedText = reloadBeforeRetry ? "" : "Voice follow-up.";
      await waitFor(() => {
        expect(
          screen.getByRole("textbox", { name: "Message" }).textContent,
        ).toBe(expectedText);
      });
      expect(
        queryAllByRoleFast("button").find((button) => {
          return button.textContent?.trim() === "Retry";
        }),
      ).toBeUndefined();
    });
  },
);
