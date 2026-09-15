import { command, computed, state, type Command, type Computed } from "ccstate";
import {
  VOICE_IO_TRANSCRIBE_MAX_CONTEXT_CHARS,
  type VoiceIoEditorContext,
} from "@okouai/api-contracts/contracts/voice-io-transcribe";
import { toast } from "@okouai/ui/components/ui/sonner";
import { i18n } from "../../i18n/index.ts";
import { authenticatedIdentity$ } from "../auth.ts";
import { logger } from "../log.ts";
import { onRef, onRejection, settle } from "../utils.ts";
import {
  readVoiceDraftRecording,
  createVoiceDraftRecording,
  appendVoiceDraftSamples,
  deleteVoiceDraftRecording,
  type VoiceDraftRecordingRecord,
} from "../external/voice-draft-store.ts";
import { createVoiceDraftTranscriptionSignals } from "../voice-io/voice-draft-transcription.ts";
import { createVoiceDraftCaptureSignals } from "../voice-io/voice-draft-capture.ts";
import {
  audioInputAvailable$,
  audioInputQuota$,
  openAudioInputQuotaRecovery$,
} from "../voice-io/voice-io-stt.ts";

const L = logger("Composer:VoiceDraft");
export type ComposerVoiceInputStatus =
  | "idle"
  | "recording"
  | "transcribing"
  | "failed"
  | "discarding";
type ComposerVoiceAction = "toggle" | "retry" | "discard";
type DeliverVoiceTextCommand = Command<Promise<void>, [string, AbortSignal]>;
interface ComposerVoiceInputState {
  readonly status: "idle" | "recording" | "failed";
  readonly recording: VoiceDraftRecordingRecord | null;
  readonly message?: string;
}
// The recording this composer last created, appended to, or removed under a
// storage key. Storage is only read for a key this composer has not changed.
interface OwnedVoiceDraftRecording {
  readonly key: string;
  readonly recording: VoiceDraftRecordingRecord | null;
}
export type ComposerVoiceInputSignals = ReturnType<
  typeof createComposerVoiceInputSignals
>;
export interface ComposerVoiceInputOwner {
  readonly element: HTMLElement;
  readonly signal: AbortSignal;
}

// Local audio/storage failures need a recovery message. API errors belong to
// accept and must propagate directly to the action's loadable.
async function withVoiceDraftFailureToast<T>(
  operation: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  const result = await settle(operation, signal);
  if (result.ok) {
    return result.value;
  }
  L.error("Voice draft transcription failed", result.error);
  toast.error(
    i18n.t(($) => {
      return $.chat.voice.transcriptionFailed;
    }),
  );
  throw result.error;
}
function voiceDraftStorageFailedMessage(): string {
  return i18n.t(($) => {
    return $.chat.voice.storageFailed;
  });
}

function createVoiceDraftData(draftTarget: string) {
  const storageKey$ = computed(async (get): Promise<string> => {
    const identity = await get(authenticatedIdentity$);
    return JSON.stringify([identity.userId, identity.orgId, draftTarget]);
  });
  const storedRecording$ = computed(
    async (get): Promise<VoiceDraftRecordingRecord | null> => {
      const key = await get(storageKey$);
      return await readVoiceDraftRecording(key);
    },
  );
  const ownedRecording$ = state<OwnedVoiceDraftRecording | null>(null);
  // Mutations record their own outcome, so the recording never waits for a
  // second storage read after this composer has changed it.
  const recording$ = computed(
    async (get): Promise<VoiceDraftRecordingRecord | null> => {
      const owned = get(ownedRecording$);
      const key = await get(storageKey$);
      return owned?.key === key ? owned.recording : await get(storedRecording$);
    },
  );
  // Retry reads storage again so a failed restore can recover and a recording
  // saved by another composer for the same target can be transcribed.
  const restoreRecording$ = command(
    async ({ get, set }, signal: AbortSignal) => {
      const key = await get(storageKey$);
      signal.throwIfAborted();
      const recording = await readVoiceDraftRecording(key);
      signal.throwIfAborted();
      set(ownedRecording$, { key, recording });
    },
  );
  const capture = createVoiceDraftCaptureSignals();
  const captureError$ = state<unknown>(null);
  const providerUnavailable$ = state<{
    readonly recordingId: string;
    readonly message: string;
  } | null>(null);
  const state$ = computed(async (get): Promise<ComposerVoiceInputState> => {
    const active = get(capture.capture$);
    const captureError = get(captureError$);
    const unavailable = get(providerUnavailable$);
    const restored = await settle(get(recording$));
    if (!restored.ok) {
      return {
        status: "failed",
        recording: null,
        message: voiceDraftStorageFailedMessage(),
      };
    }
    return {
      status: active ? "recording" : restored.value ? "failed" : "idle",
      recording: restored.value,
      message:
        captureError || restored.value?.sampleCount === 0
          ? voiceDraftStorageFailedMessage()
          : unavailable && unavailable.recordingId === restored.value?.id
            ? `${unavailable.message} ${i18n.t(($) => {
                return $.chat.voice.retryReady;
              })}`
            : undefined,
    };
  });
  return {
    storageKey$,
    ownedRecording$,
    recording$,
    restoreRecording$,
    capture,
    captureError$,
    providerUnavailable$,
    state$,
  };
}

type VoiceDraftData = ReturnType<typeof createVoiceDraftData>;
type VoiceDraftCommand = Command<Promise<void>, [AbortSignal]>;

function createVoiceDraftTranscription(
  data: VoiceDraftData,
  deliverText$: DeliverVoiceTextCommand,
  readEditorContext$: Command<VoiceIoEditorContext, []>,
  lastAssistantMessage$: Computed<string | undefined>,
) {
  const { recording$, storageKey$, ownedRecording$, providerUnavailable$ } =
    data;
  const incremental = createVoiceDraftTranscriptionSignals({
    storageKey$,
    readContext$: command(({ get, set }) => {
      const reference = get(lastAssistantMessage$)
        ?.trim()
        .slice(0, VOICE_IO_TRANSCRIBE_MAX_CONTEXT_CHARS);
      return {
        ...(reference ? { lastAssistantMessage: reference } : {}),
        editorContext: set(readEditorContext$),
      };
    }),
  });
  const transcribe$ = command(async ({ get, set }, signal: AbortSignal) => {
    set(providerUnavailable$, null);
    const recording = await get(recording$);
    signal.throwIfAborted();
    if (!recording) {
      return;
    }
    const key = await get(storageKey$);
    signal.throwIfAborted();
    const result = await set(incremental.transcribe$, signal);
    signal.throwIfAborted();
    if (result === undefined) {
      return;
    }
    if (result.kind === "unavailable") {
      set(providerUnavailable$, {
        recordingId: recording.id,
        message: result.message,
      });
      return;
    }
    const text = result.text;
    if (text === undefined) {
      return;
    }
    if (text.trim()) {
      await set(deliverText$, text, signal);
    }

    signal.throwIfAborted();
    // A successful text handoff consumes this recording even if local deletion
    // fails, so Retry cannot insert the same text twice.
    set(ownedRecording$, { key, recording: null });
    const removed = await settle(
      deleteVoiceDraftRecording(key, recording.id),
      signal,
    );
    signal.throwIfAborted();
    if (!removed.ok) {
      L.error("Voice recording cleanup failed", removed.error);
      toast.error(
        i18n.t(($) => {
          return $.chat.voice.cleanupFailed;
        }),
      );
    }
  });
  return {
    transcribe$,
    initialize$: incremental.initialize$,
    append$: incremental.append$,
    watch$: incremental.watch$,
    cancel$: incremental.cancel$,
  };
}

function createVoiceDraftMutations(
  data: VoiceDraftData,
  transcribe$: VoiceDraftCommand,
  initializeTranscription$: VoiceDraftCommand,
  appendTranscription$: Command<Promise<void>, [boolean, AbortSignal]>,
  cancelTranscription$: VoiceDraftCommand,
) {
  const { recording$, storageKey$, ownedRecording$, capture, captureError$ } =
    data;
  const discard$ = command(async ({ get, set }, signal: AbortSignal) => {
    await set(cancelTranscription$, signal);
    signal.throwIfAborted();
    const recording = await get(recording$);
    signal.throwIfAborted();
    if (!recording) {
      return;
    }
    const key = await get(storageKey$);
    signal.throwIfAborted();
    await withVoiceDraftFailureToast(
      deleteVoiceDraftRecording(key, recording.id),
      signal,
    );
    signal.throwIfAborted();
    set(ownedRecording$, { key, recording: null });
  });
  const start$ = command(async ({ get, set }, signal: AbortSignal) => {
    const quota = await get(audioInputQuota$);
    signal.throwIfAborted();
    if (!quota.allowed) {
      await set(openAudioInputQuotaRecovery$, signal);
      return;
    }
    const key = await get(storageKey$);
    signal.throwIfAborted();
    const id = crypto.randomUUID();
    const recording = await withVoiceDraftFailureToast(
      createVoiceDraftRecording(key, id),
      signal,
    );
    signal.throwIfAborted();
    set(ownedRecording$, { key, recording });
    if (recording.id !== id) {
      return;
    }
    await set(initializeTranscription$, signal);
    const removeEmptyRecording = async () => {
      // Storage orders this read after every committed chunk write, so audio
      // that was still being saved when capture stopped is kept.
      const current = await readVoiceDraftRecording(key);
      if (current?.id === id && current.sampleCount === 0) {
        await deleteVoiceDraftRecording(key, id);
        set(ownedRecording$, { key, recording: null });
      }
    };
    set(captureError$, null);
    const started = await withVoiceDraftFailureToast(
      onRejection(
        set(
          capture.start$,
          {
            append: async (samples, sequence) => {
              const appended = await appendVoiceDraftSamples(
                key,
                id,
                sequence,
                samples,
              );
              set(ownedRecording$, (owned) => {
                return owned?.recording?.id === id
                  ? { key, recording: appended }
                  : owned;
              });
              signal.throwIfAborted();
              await set(appendTranscription$, false, signal);
            },
            fail: (error) => {
              L.error("Voice recording could not be saved", error);
              toast.error(voiceDraftStorageFailedMessage());
              set(captureError$, error);
              set(capture.cancel$);
            },
          },
          signal,
        ),
        removeEmptyRecording,
      ),
      signal,
    );
    signal.throwIfAborted();
    if (!started) {
      await withVoiceDraftFailureToast(removeEmptyRecording(), signal);
      signal.throwIfAborted();
    }
  });
  const finish$ = command(async ({ get, set }, signal: AbortSignal) => {
    const finished = await withVoiceDraftFailureToast(
      set(capture.finish$, signal),
      signal,
    );
    signal.throwIfAborted();
    if (finished && !get(captureError$)) {
      await set(transcribe$, signal);
    }
  });
  return { start$, finish$, discard$, transcribe$ };
}

function createVoiceActionBindings(
  data: VoiceDraftData,
  mutations: ReturnType<typeof createVoiceDraftMutations>,
  watch$: VoiceDraftCommand,
) {
  const { state$, capture, restoreRecording$ } = data;
  const { start$, finish$, discard$, transcribe$ } = mutations;
  const internalOwner$ = state<ComposerVoiceInputOwner | null>(null);
  const owner$ = computed((get) => {
    return get(internalOwner$);
  });
  const invocation$ = state<{
    readonly action: "start" | "finish" | "retry" | "discard";
    readonly owner: ComposerVoiceInputOwner;
  } | null>(null);
  const action$ = computed((get) => {
    const invocation = get(invocation$);
    return invocation?.owner === get(owner$)
      ? (invocation?.action ?? null)
      : null;
  });
  const run$ = command(
    async (
      { get, set },
      action: ComposerVoiceAction,
      parentSignal: AbortSignal,
    ) => {
      const owner = get(owner$);
      if (!owner || !get(audioInputAvailable$)) {
        return;
      }
      const signal = AbortSignal.any([owner.signal, parentSignal]);
      signal.throwIfAborted();
      const current = await get(state$);
      signal.throwIfAborted();
      const resolvedAction =
        action === "toggle"
          ? get(capture.capture$)
            ? "finish"
            : current.status === "failed"
              ? "retry"
              : "start"
          : action;
      set(invocation$, { action: resolvedAction, owner });
      if (resolvedAction === "start") {
        await set(start$, signal);
      } else if (resolvedAction === "finish") {
        await set(finish$, signal);
      } else if (resolvedAction === "discard") {
        await set(discard$, signal);
      } else {
        await set(restoreRecording$, signal);
        await set(transcribe$, signal);
      }
      signal.throwIfAborted();
    },
  );
  const mount$ = onRef(
    command(async ({ get, set }, element: HTMLElement, signal: AbortSignal) => {
      const owner = { element, signal };
      set(internalOwner$, owner);
      signal.addEventListener(
        "abort",
        () => {
          if (get(internalOwner$)?.signal !== signal) {
            return;
          }
          set(capture.cancel$);
          set(internalOwner$, null);
        },
        { once: true },
      );
      await set(watch$, signal);
    }),
  );
  // The global shortcut activates the same enabled control as a click, so it
  // shares the React invocation's loadable state and cannot bypass disabled UI.
  const toggle$ = command(({ get }) => {
    get(owner$)
      ?.element.querySelector<HTMLButtonElement>("[data-composer-voice-toggle]")
      ?.click();
  });
  return { owner$, action$, run$, setRootRef$: mount$, toggle$ };
}

export function createComposerVoiceInputSignals(
  deliverText$: DeliverVoiceTextCommand,
  readEditorContext$: Command<VoiceIoEditorContext, []>,
  lastAssistantMessage$: Computed<string | undefined>,
  draftTarget: string,
) {
  const data = createVoiceDraftData(draftTarget);
  const transcription = createVoiceDraftTranscription(
    data,
    deliverText$,
    readEditorContext$,
    lastAssistantMessage$,
  );
  const actions = createVoiceActionBindings(
    data,
    createVoiceDraftMutations(
      data,
      transcription.transcribe$,
      transcription.initialize$,
      transcription.append$,
      transcription.cancel$,
    ),
    transcription.watch$,
  );
  return {
    ...actions,
    state$: data.state$,
    capture$: data.capture.capture$,
    voiceLevelSamples$: data.capture.voiceLevelSamples$,
  };
}
