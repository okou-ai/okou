import { agentDraftContract } from "@okouai/api-contracts/contracts/agent-draft";
import {
  chatThreadByIdContract,
  chatThreadDraftContract,
} from "@okouai/api-contracts/contracts/chat-threads";
import { voiceIoQuotaContract } from "@okouai/api-contracts/contracts/voice-io-quota";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { screen, waitFor } from "@testing-library/react";
import { HttpResponse } from "msw";
import { expect, test } from "vitest";

import { click, setupPage } from "../../../__tests__/page-helper.ts";
import {
  draftPlainText,
  textContinuityDraft,
} from "./chat-continuity-test-helpers.ts";
import {
  context,
  findEnabledButton,
  findLink,
  installRunChat,
  NEW_CHAT_PATH,
  queryButton,
  RUN_PATH,
} from "./chat-run-test-fixtures.ts";

test.each([
  {
    target: "existing conversation",
    path: RUN_PATH,
    interruptHydration: false,
  },
  {
    target: "new conversation",
    path: NEW_CHAT_PATH,
    interruptHydration: false,
  },
  { target: "existing conversation", path: RUN_PATH, interruptHydration: true },
  { target: "new conversation", path: NEW_CHAT_PATH, interruptHydration: true },
])(
  "Preserve saved text and recovered voice while loading a $target draft (interrupted: $interruptHydration)",
  async ({ path, interruptHydration }) => {
    const retryRequested = context.mocks.deferred<void>();
    const hydrationRequested = context.mocks.deferred<void>();
    const hydrationRestarted = context.mocks.deferred<void>();
    const hydrationReady = context.mocks.deferred<void>();
    let hydrationRequests = 0;
    let transcriptionRequests = 0;
    let persistedDraft = textContinuityDraft("Keep these saved notes.");
    context.mocks.browser.voiceInput({ rms: 0.12 });
    installRunChat();
    context.mocks.api(voiceIoQuotaContract.get, ({ respond }) => {
      return respond(200, { allowed: true, count: 0, limit: 60 });
    });
    const readDraft = async () => {
      hydrationRequests += 1;
      if (hydrationRequests === 1) {
        hydrationRequested.resolve();
      } else if (hydrationRequests === 2) {
        hydrationRestarted.resolve();
      }
      await hydrationReady.promise;
      return persistedDraft;
    };
    context.mocks.api(agentDraftContract.get, async ({ respond }) => {
      return respond(200, await readDraft());
    });
    context.mocks.api(chatThreadDraftContract.get, async ({ respond }) => {
      return respond(200, await readDraft());
    });
    context.mocks.api(agentDraftContract.patch, ({ body, respond }) => {
      persistedDraft = {
        draftUserMessage: body.draftUserMessage,
        draftAttachments: body.draftAttachments ?? null,
      };
      return respond(204);
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
    context.mocks.http.post("*/api/voice-io/transcribe/segment", () => {
      transcriptionRequests += 1;
      if (transcriptionRequests === 2) {
        retryRequested.resolve();
      }
      if (transcriptionRequests === 1) {
        return HttpResponse.json(
          {
            error: {
              code: "PROVIDER_UNAVAILABLE",
              message: "Voice transcription is temporarily unavailable",
            },
          },
          { status: 503 },
        );
      }
      return HttpResponse.json({
        transcript: "recovered voice note",
        polishedText: "Recovered voice note.",
        language: "en-US",
      });
    });

    await setupPage({
      locale: "en-US",
      context,
      path,
      featureSwitches: { [FeatureSwitchKey.VoiceInputV2]: true },
    });
    await hydrationRequested.promise;
    // Create retryable audio through the UI while the remote text stays gated.
    // Reload recovery is covered separately in chat-capability-voice-input.
    click(await findEnabledButton("Voice input"));
    click(await findEnabledButton("Stop recording"));
    await screen.findByText("Voice transcription is temporarily unavailable", {
      exact: false,
    });
    click(await findEnabledButton("Retry"));
    await retryRequested.promise;
    const retryStatus = screen.getByRole("status");
    expect(retryStatus).toHaveTextContent("Transcribing");
    expect(retryStatus).toHaveTextContent("Retrying saved audio");
    if (interruptHydration) {
      click(await findLink("Agents"));
      await screen.findByRole("heading", { name: "Agents" });
      window.history.back();
      await hydrationRestarted.promise;
      click(await findEnabledButton("Retry"));
    }
    hydrationReady.resolve();
    await findEnabledButton("Send");
    await waitFor(() => {
      const savedText = draftPlainText(persistedDraft.draftUserMessage);
      expect(savedText).toContain("Keep these saved notes.");
      expect(savedText).toContain("Recovered voice note.");
    });
    expect(hydrationRequests).toBe(interruptHydration ? 2 : 1);
    // The successful retry is checkpointed before waiting for text hydration.
    expect(transcriptionRequests).toBe(2);

    // Assert the recovered composer and persisted text at the handoff boundary.
    // Ordinary saved-draft restoration is covered in chat-continuity-drafts.
    await findEnabledButton("Voice input");
    const composer = screen.getByRole("textbox", { name: "Message" });
    expect(composer).toHaveTextContent("Keep these saved notes.");
    expect(composer).toHaveTextContent("Recovered voice note.");
    expect(queryButton("Retry")).toBeNull();
  },
);
