import { command, computed, state } from "ccstate";
import { createDraftSignals } from "../okou-page/chat-draft.ts";
import {
  sendNewThread$,
  type SendNewThreadMessageRequest,
} from "../chat-page/optimistic-chat-thread-page.ts";
import { rootSignal$ } from "../root-signal.ts";
import {
  landingFileReturnUrl,
  LandingFilesUnavailableError,
  readLandingFiles,
} from "./landing-file-handoff.ts";

import {
  landingFileSelection$,
  LandingFileLimitError,
} from "./landing-file-preview.ts";
import { readLandingFileAdditions } from "./landing-file-store.ts";

interface LandingFile {
  id: string;
  file: File;
}

function createLandingFilesSignals(
  source: URL | null,
  id: string,
  prompt: string,
  request: SendNewThreadMessageRequest,
) {
  const draft = createDraftSignals();
  const input$ = state(prompt);
  const edit$ = command(({ set }, value: string) => {
    set(input$, value);
  });
  const internalFiles$ = state<LandingFile[] | null>(null);
  const files$ = computed((get) => {
    return get(internalFiles$);
  });
  const start$ = command(async ({ get, set }, operationSignal: AbortSignal) => {
    operationSignal.throwIfAborted();
    if (!source) {
      throw new Error("Invalid landing file source");
    }
    let files = get(files$);
    if (!files) {
      const selection = get(landingFileSelection$);
      const needsSource =
        !selection ||
        selection.files.some((_file, index) => {
          return !selection.removed.includes(index);
        });
      // Open the source window before awaiting anything, preserving user activation.
      const original = needsSource
        ? await readLandingFiles(source, id, operationSignal)
        : [];
      operationSignal.throwIfAborted();
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
        operationSignal,
      );
      operationSignal.throwIfAborted();
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
      files = restored.map((file) => {
        return { id: crypto.randomUUID(), file };
      });
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
    await set(
      sendNewThread$,
      { ...request, prompt: get(input$), draft, preserveAgentDraft: true },
      get(rootSignal$),
    );
  });
  return {
    source,
    back: source ? landingFileReturnUrl(source, id, location.origin) : null,
    input$,
    edit$,
    files$,
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
}

const landingFilesRequest$ = state<LandingFilesRequest | null>(null);
const landingFiles$ = computed((get) => {
  const request = get(landingFilesRequest$);
  return request
    ? createLandingFilesSignals(
        request.source,
        request.id,
        request.prompt,
        request.request,
      )
    : null;
});

export const prepareLandingFiles$ = command(
  ({ get, set }, request: LandingFilesRequest, signal: AbortSignal) => {
    signal.throwIfAborted();
    set(landingFilesRequest$, request);
    signal.addEventListener(
      "abort",
      () => {
        if (get(landingFilesRequest$) === request) {
          set(landingFilesRequest$, null);
        }
      },
      { once: true },
    );
    return get(landingFiles$)!;
  },
);
