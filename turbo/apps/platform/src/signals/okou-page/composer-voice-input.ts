import { command, computed, state, type Command } from "ccstate";
import type { VoiceIoEditorContext } from "@okouai/api-contracts/contracts/voice-io-transcribe";
import { toast } from "@okouai/ui/components/ui/sonner";
import { i18n } from "../../i18n/index.ts";
import { authenticatedIdentity$ } from "../auth.ts";
import { logger } from "../log.ts";
import { onRef, resetSignal, settle } from "../utils.ts";
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
  "idle" | "recording" | "transcribing" | "failed" | "discarding";
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
      const recording =
        owned?.key === key ? owned.recording : await get(storedRecording$);
      return recording?.sampleCount ? recording : null;
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
  const providerUnavailable$ = state<{
    readonly recordingId: string;
    readonly message: string;
  } | null>(null);
  const state$ = computed(async (get): Promise<ComposerVoiceInputState> => {
    const active = get(capture.capture$);
    const unavailable = get(providerUnavailable$);
    const restored = await get(recording$);
    return {
      status: active ? "recording" : restored ? "failed" : "idle",
      recording: restored,
      message:
        unavailable && unavailable.recordingId === restored?.id
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
) {
  const { recording$, storageKey$, ownedRecording$, providerUnavailable$ } =
    data;
  const incremental = createVoiceDraftTranscriptionSignals({
    storageKey$,
    readContext$: command(({ set }) => {
      return { editorContext: set(readEditorContext$) };
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
    } else {
      toast.info(
        i18n.t(($) => {
          return $.chat.voice.noSpeechDetected;
        }),
      );
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
  const { recording$, storageKey$, ownedRecording$, capture } = data;
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
    await withVoiceDraftFailureToast(
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
        },
        signal,
      ),
      signal,
    );
    signal.throwIfAborted();
  });
  const finish$ = command(async ({ set }, signal: AbortSignal) => {
    const finished = await withVoiceDraftFailureToast(
      set(capture.finish$, signal),
      signal,
    );
    signal.throwIfAborted();
    if (finished) {
      await set(transcribe$, signal);
    }
  });
  return { start$, finish$, discard$, transcribe$ };
}

function createVoiceActionBindings(
  data: VoiceDraftData,
  mutations: ReturnType<typeof createVoiceDraftMutations>,
) {
  const { state$, capture, restoreRecording$ } = data;
  const { start$, finish$, discard$, transcribe$ } = mutations;
  const internalOwner$ = state<ComposerVoiceInputOwner | null>(null);
  const resetOwner$ = resetSignal();
  const owner$ = computed((get) => {
    return get(internalOwner$);
  });
  // The page or forward-target command owns cancellation, independently of
  // whether React currently mounts this composer's controls.
  const setup$ = command(({ get, set }, parentSignal: AbortSignal) => {
    parentSignal.throwIfAborted();
    const signal = set(resetOwner$, parentSignal);
    const owner = { signal };
    set(internalOwner$, owner);
    signal.addEventListener(
      "abort",
      () => {
        if (get(internalOwner$) === owner) {
          set(capture.cancel$);
          set(internalOwner$, null);
        }
      },
      { once: true },
    );
  });
  const invocation$ = state<{
    readonly action: "start" | "finish" | "retry" | "discard";
    readonly owner: ComposerVoiceInputOwner;
  } | null>(null);
  const execution$ = state<{
    readonly owner: ComposerVoiceInputOwner | null;
    readonly promise: Promise<void>;
  } | null>(null);
  const result$ = computed(async (get) => {
    const execution = get(execution$);
    if (execution && execution.owner === get(owner$)) {
      await execution.promise;
    }
  });
  const action$ = computed((get) => {
    const invocation = get(invocation$);
    return invocation?.owner === get(owner$)
      ? (invocation?.action ?? null)
      : null;
  });
  const execute$ = command(
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
      const resolvedAction =
        action === "toggle"
          ? get(capture.capture$)
            ? "finish"
            : (await get(state$)).status === "failed"
              ? "retry"
              : "start"
          : action;
      signal.throwIfAborted();
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
  const run$ = command(
    ({ get, set }, action: ComposerVoiceAction, signal: AbortSignal) => {
      const owner = get(owner$);
      const promise = set(execute$, action, signal);
      set(execution$, { owner, promise });
      return promise;
    },
  );
  const root$ = state<{ readonly element: HTMLElement } | null>(null);
  const setRootRef$ = onRef(
    command(({ get, set }, element: HTMLElement, signal: AbortSignal) => {
      const root = { element };
      set(root$, root);
      signal.addEventListener(
        "abort",
        () => {
          if (get(root$) === root) {
            set(root$, null);
          }
        },
        { once: true },
      );
    }),
  );
  // The global shortcut activates the same enabled control as a click, so it
  // shares the command's loadable state and cannot bypass disabled UI.
  const toggle$ = command(({ get }) => {
    get(root$)
      ?.element.querySelector<HTMLButtonElement>("[data-composer-voice-toggle]")
      ?.click();
  });
  return { owner$, action$, result$, setup$, run$, setRootRef$, toggle$ };
}

export function createComposerVoiceInputSignals(
  deliverText$: DeliverVoiceTextCommand,
  readEditorContext$: Command<VoiceIoEditorContext, []>,
  draftTarget: string,
) {
  const data = createVoiceDraftData(draftTarget);
  const transcription = createVoiceDraftTranscription(
    data,
    deliverText$,
    readEditorContext$,
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
  );
  return {
    ...actions,
    state$: data.state$,
    capture$: data.capture.capture$,
    voiceLevelSamples$: data.capture.voiceLevelSamples$,
  };
}
