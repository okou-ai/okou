import { agentDraftContract } from "@okouai/api-contracts/contracts/agent-draft";
import { chatThreadDraftContract } from "@okouai/api-contracts/contracts/chat-threads";
import { voiceIoQuotaContract } from "@okouai/api-contracts/contracts/voice-io-quota";
import { act, screen, waitFor } from "@testing-library/react";
import * as idb from "idb";
import { HttpResponse } from "msw";
import { expect, test, vi } from "vitest";

import {
  click,
  fill,
  setupPage,
  startPage,
} from "../../../__tests__/page-helper.ts";
import { decodeVoiceDraftPcmWav } from "../../../signals/voice-io/voice-draft-pcm.ts";
import { textContinuityDraft } from "./chat-continuity-test-helpers.ts";
import { AGENT_ID } from "./chat-lifecycle-test-helpers.ts";
import {
  context,
  findEnabledButton,
  findLink,
  installRunChat,
  NEW_CHAT_PATH,
  queryButton,
  RUN_PATH,
  RUN_THREAD_ID,
} from "./chat-run-test-fixtures.ts";

const OTHER_AGENT_ID = "c0000000-0000-4000-a000-000000000802";
const OTHER_THREAD_ID = "b0000000-0000-4000-a000-000000000803";

vi.mock("idb", async () => {
  return { ...(await vi.importActual<typeof import("idb")>("idb")) };
});

function installVoiceInput(): void {
  installRunChat();
  context.mocks.browser.voiceInput({ rms: 0.12 });
  context.mocks.api(voiceIoQuotaContract.get, ({ respond }) => {
    return respond(200, { allowed: true, count: 0, limit: 60 });
  });
  context.mocks.http.post("*/api/voice-io/transcribe/segment", () => {
    return HttpResponse.json({
      transcript: "voice note",
      polishedText: "Voice note.",
      language: "en-US",
    });
  });
}

test("Wait for nonempty PCM before showing the waveform and preserve the opening audio", async () => {
  installVoiceInput();
  const connected = context.mocks.deferred<(samples: Float32Array) => void>();
  const uploaded = context.mocks.deferred<ArrayBuffer>();
  context.mocks.browser.voiceInput({
    rms: 0,
    onPcmCapture: connected.resolve,
    finalPcmSamples: new Float32Array(0),
  });
  context.mocks.http.post(
    "*/api/voice-io/transcribe/segment",
    async ({ request }) => {
      const form = await request.formData();
      const file = form.get("file");
      if (!(file instanceof File)) {
        throw new Error("Expected recorded audio");
      }
      uploaded.resolve(await file.arrayBuffer());
      return HttpResponse.json({
        transcript: "opening words",
        polishedText: "Opening words.",
        language: "en-US",
      });
    },
  );
  await setupPage({ context, path: RUN_PATH });
  click(await findEnabledButton("Voice input"));
  const emit = await connected.promise;
  // Flush startup work while the connected worklet supplies no real samples.
  await act(() => {
    emit(new Float32Array(0));
  });
  expect(queryButton("Starting voice input")).toBeDisabled();
  expect(queryButton("Stop recording")).toBeNull();
  expect(document.querySelector("[data-voice-level-waveform]")).toBeNull();

  const firstBatch = new Float32Array(4096);
  emit(firstBatch);
  const stop = await findEnabledButton("Stop recording");
  expect(document.querySelector("[data-voice-level-waveform]")).toBeVisible();
  const openingAudio = new Float32Array(4096).fill(-0.5);
  emit(openingAudio);
  click(stop);
  const samples = decodeVoiceDraftPcmWav(await uploaded.promise);
  expect(samples).toHaveLength(8192);
  expect(samples?.slice(0, 4096)).toStrictEqual(firstBatch);
  expect(samples?.slice(4096)).toStrictEqual(openingAudio);
  await findEnabledButton("Voice input");
});

test("Release a connected capture when switching away before its first PCM batch", async () => {
  installVoiceInput();
  context.mocks.api(agentDraftContract.get, ({ params, respond }) => {
    return respond(
      200,
      textContinuityDraft(
        params.id === AGENT_ID ? "First agent." : "Second agent.",
      ),
    );
  });
  context.mocks.data.agents([
    { agentId: AGENT_ID, displayName: "Run Agent" },
    { agentId: OTHER_AGENT_ID, displayName: "Other Agent" },
  ]);
  context.mocks.data.userPreferences({
    pinnedAgentIds: [AGENT_ID, OTHER_AGENT_ID],
  });
  const connected = context.mocks.deferred<(samples: Float32Array) => void>();
  const trackStopped = context.mocks.deferred<void>();
  const contextClosed = context.mocks.deferred<void>();
  const disconnected = context.mocks.deferred<void>();
  const portClosed = context.mocks.deferred<void>();
  context.mocks.browser.voiceInput({
    rms: 0.12,
    onPcmCapture: connected.resolve,
    onTrackStop: trackStopped.resolve,
    onAudioContextClose: contextClosed.resolve,
    onPcmDisconnect: disconnected.resolve,
    onPcmPortClose: portClosed.resolve,
  });
  await setupPage({ context, path: NEW_CHAT_PATH });
  click(await findEnabledButton("Voice input"));
  const emit = await connected.promise;
  await act(() => {
    emit(new Float32Array(0));
  });
  expect(queryButton("Starting voice input")).toBeDisabled();
  click(await findLink("Other Agent"));
  await Promise.all([
    trackStopped.promise,
    contextClosed.promise,
    disconnected.promise,
    portClosed.promise,
  ]);
  await findEnabledButton("Voice input");
  // A late message from the cancelled worklet cannot resurrect its session.
  emit(new Float32Array(4096).fill(0.25));
  expect(queryButton("Stop recording")).toBeNull();
  expect(document.querySelector("[data-voice-level-waveform]")).toBeNull();
  click(await findLink("Run Agent"));
  await waitFor(() => {
    expect(screen.getByRole("textbox", { name: "Message" })).toHaveTextContent(
      "First agent.",
    );
  });
  await findEnabledButton("Voice input");
  expect(queryButton("Retry")).toBeNull();
});

test("Keep composer controls visible while checking the local voice draft", async () => {
  installVoiceInput();
  const requested = context.mocks.deferred<void>();
  const ready = context.mocks.deferred<void>();
  const openDatabase = idb.openDB;
  vi.spyOn(idb, "openDB").mockImplementation(
    async (name, version, callbacks) => {
      if (name === "okou-voice-drafts") {
        if (!requested.settled()) {
          requested.resolve();
        }
        await ready.promise;
      }
      return await openDatabase(name, version, callbacks);
    },
  );

  await setupPage({ context, path: RUN_PATH });
  await requested.promise;
  await fill(screen.getByRole("textbox", { name: "Message" }), "Typed notes.");
  expect(queryButton("Attach")).toBeVisible();
  expect(queryButton("Voice input")).toBeDisabled();
  expect(queryButton("Send")).toBeDisabled();

  ready.resolve();
  await findEnabledButton("Send");
  expect(queryButton("Voice input")).toBeEnabled();
  expect(screen.getByRole("textbox", { name: "Message" })).toHaveTextContent(
    "Typed notes.",
  );
});

test("Keep voice input available when switching between agent chat pages", async () => {
  installVoiceInput();
  context.mocks.data.agents([
    { agentId: AGENT_ID, displayName: "Run Agent" },
    { agentId: OTHER_AGENT_ID, displayName: "Other Agent" },
  ]);
  context.mocks.data.userPreferences({
    pinnedAgentIds: [AGENT_ID, OTHER_AGENT_ID],
  });
  context.mocks.api(agentDraftContract.get, ({ params, respond }) => {
    return respond(
      200,
      textContinuityDraft(
        params.id === AGENT_ID ? "First agent." : "Second agent.",
      ),
    );
  });

  await setupPage({ context, path: NEW_CHAT_PATH });
  await findEnabledButton("Voice input");
  click(await findLink("Other Agent"));
  await waitFor(() => {
    expect(screen.getByRole("textbox", { name: "Message" })).toHaveTextContent(
      "Second agent.",
    );
  });
  click(await findEnabledButton("Voice input"));
  click(await findEnabledButton("Stop recording"));
  await waitFor(() => {
    expect(screen.getByRole("textbox", { name: "Message" })).toHaveTextContent(
      "Voice note.",
    );
  });
  click(await findLink("Run Agent"));
  await waitFor(() => {
    expect(screen.getByRole("textbox", { name: "Message" })).toHaveTextContent(
      "First agent.",
    );
  });
  await findEnabledButton("Voice input");
  expect(queryButton("Retry")).toBeNull();
});

test("Do not show another agent's retryable recording while the current draft is pending", async () => {
  installVoiceInput();
  context.mocks.data.agents([
    { agentId: AGENT_ID, displayName: "Run Agent" },
    { agentId: OTHER_AGENT_ID, displayName: "Other Agent" },
  ]);
  context.mocks.data.userPreferences({
    pinnedAgentIds: [AGENT_ID, OTHER_AGENT_ID],
  });
  context.mocks.api(agentDraftContract.get, ({ params, respond }) => {
    return respond(
      200,
      textContinuityDraft(
        params.id === AGENT_ID ? "First agent." : "Second agent.",
      ),
    );
  });
  context.mocks.http.post("*/api/voice-io/transcribe/segment", () => {
    return HttpResponse.json({ error: "Temporary outage" }, { status: 503 });
  });

  await setupPage({ context, path: NEW_CHAT_PATH });
  click(await findEnabledButton("Voice input"));
  click(await findEnabledButton("Stop recording"));
  await findEnabledButton("Retry");
  expect(queryButton("Remove voice draft")).toBeVisible();

  const requested = context.mocks.deferred<void>();
  const ready = context.mocks.deferred<void>();
  const openDatabase = idb.openDB;
  vi.spyOn(idb, "openDB").mockImplementation(
    async (name, version, callbacks) => {
      if (name === "okou-voice-drafts") {
        if (!requested.settled()) {
          requested.resolve();
        }
        await ready.promise;
      }
      return await openDatabase(name, version, callbacks);
    },
  );

  click(await findLink("Other Agent"));
  await requested.promise;
  await waitFor(() => {
    expect(screen.getByRole("textbox", { name: "Message" })).toHaveTextContent(
      "Second agent.",
    );
  });
  expect(queryButton("Attach")).toBeVisible();
  expect(queryButton("Retry")).toBeNull();
  expect(queryButton("Remove voice draft")).toBeNull();
  expect(queryButton("Voice input")).toBeDisabled();

  ready.resolve();
  await findEnabledButton("Voice input");
  expect(queryButton("Attach")).toBeVisible();
  expect(queryButton("Retry")).toBeNull();
});

test("Keep the toolbar visible throughout microphone startup", async () => {
  installVoiceInput();
  const microphoneReady = context.mocks.deferred<void>();
  context.mocks.browser.voiceInput({
    rms: 0.12,
    getUserMediaReady: microphoneReady.promise,
  });
  await setupPage({ context, path: RUN_PATH });
  click(await findEnabledButton("Voice input"));
  await waitFor(() => {
    expect(queryButton("Starting voice input")).toBeDisabled();
  });
  expect(queryButton("Attach")).toBeVisible();
  expect(queryButton("Retry")).toBeNull();
  expect(queryButton("Remove voice draft")).toBeNull();
  expect(document.querySelector("[data-voice-level-waveform]")).toBeNull();

  microphoneReady.resolve();
  click(await findEnabledButton("Stop recording"));
  await findEnabledButton("Voice input");
  expect(screen.getByRole("textbox", { name: "Message" })).toHaveTextContent(
    "Voice note.",
  );
});

test("Do not carry a pending transcription into another agent's composer", async () => {
  installVoiceInput();
  const requested = context.mocks.deferred<void>();
  const response = context.mocks.deferred<void>();
  context.mocks.data.agents([
    { agentId: AGENT_ID, displayName: "Run Agent" },
    { agentId: OTHER_AGENT_ID, displayName: "Other Agent" },
  ]);
  context.mocks.data.userPreferences({
    pinnedAgentIds: [AGENT_ID, OTHER_AGENT_ID],
  });
  context.mocks.api(agentDraftContract.get, ({ params, respond }) => {
    return respond(
      200,
      textContinuityDraft(
        params.id === AGENT_ID ? "First agent." : "Second agent.",
      ),
    );
  });
  context.mocks.http.post("*/api/voice-io/transcribe/segment", async () => {
    requested.resolve();
    await response.promise;
    return HttpResponse.json({
      transcript: "first agent's recording",
      polishedText: "First agent's recording.",
      language: "en-US",
    });
  });

  await setupPage({ context, path: NEW_CHAT_PATH });
  click(await findEnabledButton("Voice input"));
  click(await findEnabledButton("Stop recording"));
  await requested.promise;
  expect(screen.getByRole("status")).toHaveTextContent("Transcribing");

  click(await findLink("Other Agent"));
  await findEnabledButton("Voice input");
  await findEnabledButton("Send");
  expect(queryButton("Attach")).toBeVisible();
  expect(queryButton("Retry")).toBeNull();
  expect(screen.queryByText("Transcribing")).toBeNull();
  expect(screen.getByRole("textbox", { name: "Message" })).toHaveTextContent(
    "Second agent.",
  );
  response.resolve();
});

test("Preserve an explicit draft clear while the server baseline is pending", async () => {
  installVoiceInput();
  const requested = context.mocks.deferred<void>();
  const response = context.mocks.deferred<void>();
  context.mocks.api(agentDraftContract.get, async ({ respond }) => {
    requested.resolve();
    await response.promise;
    return respond(200, textContinuityDraft("Old saved notes."));
  });
  const page = await startPage({ context, path: NEW_CHAT_PATH });
  await requested.promise;
  const editor = screen.getByRole("textbox", { name: "Message" });
  await fill(editor, "Temporary notes.");
  await fill(editor, "");
  response.resolve();
  await page.ready;
  click(await findEnabledButton("Voice input"));
  click(await findEnabledButton("Stop recording"));
  await findEnabledButton("Send");
  expect(screen.getByRole("textbox", { name: "Message" })).toHaveTextContent(
    "Voice note.",
  );
  expect(
    screen.getByRole("textbox", { name: "Message" }),
  ).not.toHaveTextContent("Old saved notes.");
});

test("Keep voice input enabled while switching conversations", async () => {
  const lifecycle = installRunChat({ threadTitle: "First conversation" });
  context.mocks.browser.voiceInput({ rms: 0.12 });
  context.mocks.api(voiceIoQuotaContract.get, ({ respond }) => {
    return respond(200, { allowed: true, count: 0, limit: 60 });
  });
  context.mocks.http.post("*/api/voice-io/transcribe/segment", () => {
    return HttpResponse.json({
      transcript: "voice note",
      polishedText: "Voice note.",
      language: "en-US",
    });
  });
  lifecycle.setThreadList([
    {
      id: RUN_THREAD_ID,
      title: "First conversation",
      agent: { id: AGENT_ID, avatarUrl: null },
      createdAt: "2026-08-01T10:00:00.000Z",
      updatedAt: "2026-08-01T10:02:00.000Z",
      pinnedAt: null,
    },
    {
      id: OTHER_THREAD_ID,
      title: "Second conversation",
      agent: { id: AGENT_ID, avatarUrl: null },
      createdAt: "2026-08-01T10:01:00.000Z",
      updatedAt: "2026-08-01T10:01:00.000Z",
      pinnedAt: null,
    },
  ]);
  context.mocks.api(chatThreadDraftContract.get, ({ params, respond }) => {
    return respond(
      200,
      textContinuityDraft(
        params.id === RUN_THREAD_ID
          ? "First conversation."
          : "Second conversation.",
      ),
    );
  });

  await setupPage({ context, path: RUN_PATH });
  await findEnabledButton("Voice input");

  const requested = context.mocks.deferred<void>();
  const ready = context.mocks.deferred<void>();
  const openDatabase = idb.openDB;
  vi.spyOn(idb, "openDB").mockImplementation(
    async (name, version, callbacks) => {
      if (name === "okou-voice-drafts") {
        if (!requested.settled()) {
          requested.resolve();
        }
        await ready.promise;
      }
      return await openDatabase(name, version, callbacks);
    },
  );

  click(await findLink("Second conversation"));
  await requested.promise;
  await waitFor(() => {
    expect(screen.getByRole("textbox", { name: "Message" })).toHaveTextContent(
      "Second conversation.",
    );
  });
  // The stored draft of the new conversation is still being read.
  expect(queryButton("Voice input")).toBeEnabled();
  expect(queryButton("Retry")).toBeNull();

  ready.resolve();
  click(await findEnabledButton("Voice input"));
  click(await findEnabledButton("Stop recording"));
  await waitFor(() => {
    expect(screen.getByRole("textbox", { name: "Message" })).toHaveTextContent(
      "Voice note.",
    );
  });
  expect(screen.getByRole("textbox", { name: "Message" })).toHaveTextContent(
    "Second conversation.",
  );
  await findEnabledButton("Voice input");
});
