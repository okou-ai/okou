import { command, computed, state } from "ccstate";
import { createDraftSignals } from "../okou-page/chat-draft.ts";
import {
  openPendingNewThread$,
  sendNewThreadWithoutNavigation$,
  type SendNewThreadMessageRequest,
} from "../chat-page/optimistic-chat-thread-page.ts";
import { rootSignal$ } from "../root-signal.ts";
import {
  landingFileReturnUrl,
  LandingFilesUnavailableError,
  readLandingFiles,
} from "./landing-file-handoff.ts";

import {
  type LandingFileSelection,
  LandingFileLimitError,
} from "./landing-file-preview.ts";
import { readLandingFileAdditions } from "./landing-file-store.ts";
import type { ModelProviderSelection } from "../../views/okou-page/components/model-provider-picker.tsx";

interface LandingFile {
  id: string;
  file: File;
}

async function restoreLandingFiles(
  { source, id, transferred, selection }: LandingFilesRequest,
  signal: AbortSignal,
): Promise<LandingFile[]> {
  if (!source) {
    throw new Error("Invalid landing file source");
  }
  const needsSource =
    !selection ||
    selection.files.some((_file, index) => {
      return !selection.removed.includes(index);
    });
  // Open the source window before awaiting anything, preserving user activation.
  const original = needsSource
    ? (transferred ?? (await readLandingFiles(source, id, signal)))
    : [];
  signal.throwIfAborted();
  if (
    selection &&
    needsSource &&
    (original.length !== selection.files.length ||
      original.some((file, index) => {
        const expected = selection.files[index];
        return (
          file.name !== expected.name ||
          file.size !== expected.size ||
          file.type !== expected.type
        );
      }))
  ) {
    throw new LandingFilesUnavailableError();
  }
  const added = await readLandingFileAdditions(
    id,
    selection?.added.map((file) => {
      return file.key;
    }) ?? [],
    signal,
  );
  signal.throwIfAborted();
  const restored = [
    ...original.filter((_file, index) => {
      return !selection?.removed.includes(index);
    }),
    ...added,
  ];
  if (
    restored.length > 10 ||
    restored.reduce((total, file) => {
      return total + file.size;
    }, 0) >
      1024 * 1024 * 1024
  ) {
    throw new LandingFileLimitError();
  }
  return restored.map((file) => {
    return { id: crypto.randomUUID(), file };
  });
}

function createLandingFilesSignals(launch: LandingFilesRequest) {
  const { source, id, prompt, request, selection } = launch;
  const draft = createDraftSignals();
  const pendingThread = {
    threadId: crypto.randomUUID(),
    clientEventId: crypto.randomUUID(),
    chatThreadEventId: crypto.randomUUID(),
  };
  const modelSelection$ = state<ModelProviderSelection | null>(null);
  const submitted$ = state(false);
  const input$ = state(prompt);
  const edit$ = command(({ set }, value: string) => {
    set(input$, value);
  });
  const internalFiles$ = state<LandingFile[] | null>(null);
  const files$ = computed((get) => {
    return get(internalFiles$);
  });
  const operation$ = state<Promise<void> | null>(null);
  const run$ = command(async ({ get, set }, operationSignal: AbortSignal) => {
    operationSignal.throwIfAborted();
    if (get(submitted$)) {
      return;
    }
    let modelSelection = get(modelSelection$);
    if (!modelSelection) {
      modelSelection = await set(
        openPendingNewThread$,
        { ...request, pendingThread },
        operationSignal,
      );
      operationSignal.throwIfAborted();
      set(modelSelection$, modelSelection);
    }
    let files = get(files$);
    if (!files) {
      files = await restoreLandingFiles(launch, operationSignal);
      set(internalFiles$, files);
    }
    // Keep successful uploads on retry; a failed file remains in the isolated
    // draft and is retried through the same uploader as the chat composer.
    for (const [index, { file }] of files.entries()) {
      const attachment = get(draft.attachments$)[index];
      if (!attachment) {
        await set(draft.uploadAttachment$, file, operationSignal);
      } else {
        const [result] = await Promise.allSettled([get(attachment.fileInfo$)]);
        operationSignal.throwIfAborted();
        if (result?.status !== "fulfilled" || result.value === null) {
          await set(attachment.upload$, operationSignal);
        }
      }
    }
    operationSignal.throwIfAborted();
    const sent = await set(
      sendNewThreadWithoutNavigation$,
      {
        ...request,
        pendingThread,
        modelSelection,
        prompt: get(input$),
        draft,
        preserveAgentDraft: true,
      },
      operationSignal,
    );
    operationSignal.throwIfAborted();
    if (!sent) {
      throw new Error("The first message could not be sent");
    }
    set(submitted$, true);
    if (get(landingFilesRequest$) === launch) {
      set(landingFilesRequest$, null);
    }
  });
  const start$ = command(({ get, set }) => {
    // The upload belongs to the new chat, so entering it must not cancel work.
    const pending = set(run$, get(rootSignal$));
    set(operation$, pending);
    return pending;
  });
  return {
    threadId: pendingThread.threadId,
    submitted$,
    operation$,
    source,
    back: source ? landingFileReturnUrl(source, id, location.origin) : null,
    input$,
    edit$,
    files$,
    preview: selection
      ? [
          ...selection.files.flatMap((file, index) => {
            return selection.removed.includes(index)
              ? []
              : [{ id: `source-${String(index)}`, file }];
          }),
          ...selection.added.map((file) => {
            return { id: file.key, file };
          }),
        ]
      : [],
    start$,
    attachments$: draft.attachments$,
  };
}

export type LandingFilesSignals = ReturnType<typeof createLandingFilesSignals>;

interface LandingFilesRequest {
  source: URL | null;
  id: string;
  prompt: string;
  request: SendNewThreadMessageRequest;
  transferred: File[] | null;
  selection: LandingFileSelection | null;
}

const landingFilesRequest$ = state<LandingFilesRequest | null>(null);
const landingFiles$ = computed((get) => {
  const request = get(landingFilesRequest$);
  return request ? createLandingFilesSignals(request) : null;
});

export const pendingLandingFiles$ = computed((get) => {
  const files = get(landingFiles$);
  return files && !get(files.submitted$) ? files : null;
});

export const prepareLandingFiles$ = command(
  ({ get, set }, request: LandingFilesRequest, signal: AbortSignal) => {
    signal.throwIfAborted();
    set(landingFilesRequest$, request);
    const files = get(landingFiles$)!;
    const threadId = files.threadId;
    signal.addEventListener(
      "abort",
      () => {
        if (get(landingFiles$)?.threadId === threadId) {
          set(landingFilesRequest$, null);
        }
      },
      { once: true },
    );
    return files;
  },
);
