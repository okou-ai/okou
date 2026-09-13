import { agentDraftContract } from "@okouai/api-contracts/contracts/agent-draft";
import {
  chatThreadByIdContract,
  chatThreadDraftContract,
} from "@okouai/api-contracts/contracts/chat-threads";
import { voiceIoQuotaContract } from "@okouai/api-contracts/contracts/voice-io-quota";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { cleanup, screen, waitFor } from "@testing-library/react";
import { HttpResponse } from "msw";
import { expect, test, vi } from "vitest";

import { click, fill, setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { createChildAbortController } from "../../../signals/utils.ts";
import { textContinuityDraft } from "./chat-continuity-test-helpers.ts";
import {
  context,
  findEnabledButton,
  findLink,
  installRunChat,
  NEW_CHAT_PATH,
  RUN_PATH,
  queryButton,
} from "./chat-run-test-fixtures.ts";

const refreshedContext = testContext();

test.each([
  { path: RUN_PATH, recovery: "same page" },
  { path: NEW_CHAT_PATH, recovery: "same page" },
  { path: RUN_PATH, recovery: "navigation" },
  { path: NEW_CHAT_PATH, recovery: "navigation" },
  { path: RUN_PATH, recovery: "reload" },
  { path: NEW_CHAT_PATH, recovery: "reload" },
])(
  "Finish voice independently of a failed text draft save at $path after $recovery",
  async ({ path, recovery }) => {
    // eslint-disable-next-line ccstate/no-create-child-abort-controller -- migrate this lifetime to the ccstate signal hierarchy
    const initialPage = createChildAbortController(context.signal);
    context.mocks.browser.voiceInput({ rms: 0.12 });
    installRunChat();
    context.mocks.api(voiceIoQuotaContract.get, ({ respond }) => {
      return respond(200, { allowed: true, count: 0, limit: 60 });
    });
    context.mocks.http.post("*/api/voice-io/transcribe/segment", () => {
      return HttpResponse.json({
        transcript: "recorded note",
        polishedText: "Recorded note.",
        language: "en-US",
      });
    });
    const saveFailed = context.mocks.deferred<void>();
    let canSave = false;
    let persistedDraft = textContinuityDraft("");
    context.mocks.api(agentDraftContract.get, ({ respond }) => {
      return respond(200, persistedDraft);
    });
    context.mocks.api(chatThreadDraftContract.get, ({ respond }) => {
      return respond(200, persistedDraft);
    });
    context.mocks.api(agentDraftContract.patch, ({ body, respond }) => {
      if (!canSave) {
        if (!saveFailed.settled()) {
          saveFailed.resolve();
        }
        return respond(403, {
          error: {
            code: "FORBIDDEN",
            message: "Draft save is not permitted",
          },
        });
      }
      persistedDraft = {
        draftUserMessage: body.draftUserMessage,
        draftAttachments: body.draftAttachments ?? null,
      };
      return respond(204);
    });
    context.mocks.api(chatThreadByIdContract.patch, ({ body, respond }) => {
      if (!canSave) {
        if (!saveFailed.settled()) {
          saveFailed.resolve();
        }
        return respond(403, {
          error: {
            code: "FORBIDDEN",
            message: "Draft save is not permitted",
          },
        });
      }
      persistedDraft = {
        draftUserMessage: body.draftUserMessage,
        draftAttachments: body.draftAttachments ?? null,
      };
      return respond(204);
    });
    await setupPage({
      locale: "en-US",
      context: { ...context, signal: initialPage.signal },
      path,
      featureSwitches: { [FeatureSwitchKey.VoiceInputV2]: true },
    });
    click(await findEnabledButton("Voice input"));
    click(await findEnabledButton("Stop recording"));
    await findEnabledButton("Voice input");
    expect(screen.getByRole("textbox", { name: "Message" })).toHaveTextContent(
      /^Recorded note\.$/u,
    );

    await saveFailed.promise;
    expect(queryButton("Retry")).toBeNull();

    if (recovery === "navigation") {
      // User edits belong to the retained draft too, even when saving is down.
      await fill(
        screen.getByRole("textbox", { name: "Message" }),
        "Revised voice note.",
      );
      click(await findLink("Agents"));
      await screen.findByRole("heading", { name: "Agents" });
      window.history.back();
      await findEnabledButton("Voice input");
    }
    if (recovery === "reload") {
      const error = new Error("Page reloaded");
      error.name = "AbortError";
      initialPage.abort(error);
      cleanup();
      // Replace setupPage's history wrappers with the fresh browser runtime.
      vi.mocked(window.history.pushState).mockRestore();
      vi.mocked(window.history.replaceState).mockRestore();
      vi.mocked(window.history.back).mockRestore();
      await setupPage({
        locale: "en-US",
        context: refreshedContext,
        path,
        featureSwitches: { [FeatureSwitchKey.VoiceInputV2]: true },
      });
      await findEnabledButton("Voice input");
    }

    const expected =
      recovery === "navigation" ? "Revised voice note." : "Recorded note.";
    const retainedText = recovery === "reload" ? "" : expected;
    await waitFor(() => {
      expect(screen.getByRole("textbox", { name: "Message" }).textContent).toBe(
        retainedText,
      );
    });

    canSave = true;
    expect(queryButton("Retry")).toBeNull();

    // A different recording still inserts its transcript into the same draft.
    click(await findEnabledButton("Voice input"));
    click(await findEnabledButton("Stop recording"));
    await findEnabledButton("Send");
    expect(screen.getByRole("textbox", { name: "Message" }).textContent).toBe(
      `${retainedText}Recorded note.`,
    );
  },
);
