import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { featureSwitch$ } from "../external/feature-switch.ts";
import { command, computed, state } from "ccstate";
import { createDraftSignals } from "../okou-page/chat-draft.ts";
import {
  sendNewThread$,
  type SendNewThreadMessageRequest,
} from "../chat-page/optimistic-chat-thread-page.ts";
import { rootSignal$ } from "../root-signal.ts";
import { readLandingFiles } from "./landing-file-handoff.ts";

interface LandingFile {
  id: string;
  file: File;
}

export function createLandingFilesSignals(
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
  const internalFiles$ = state<Promise<LandingFile[]>>(Promise.resolve([]));
  const files$ = computed((get) => {
    return get(internalFiles$);
  });
  const read$ = command(async ({ get }, signal: AbortSignal) => {
    const switches = await get(featureSwitch$);
    signal.throwIfAborted();
    if (!switches[FeatureSwitchKey.LandingFileHandoff]) {
      throw new Error("Landing file handoff is disabled");
    }
    if (!source) {
      throw new Error("Invalid landing file source");
    }
    const files = await readLandingFiles(source, id, signal);
    signal.throwIfAborted();
    return files.map((file) => {
      return { id: crypto.randomUUID(), file };
    });
  });
  const load$ = command(async ({ set }, signal: AbortSignal) => {
    const pending = set(read$, signal);
    set(internalFiles$, pending);
    await pending;
  });
  const start$ = command(async ({ get, set }, operationSignal: AbortSignal) => {
    const files = await get(files$);
    operationSignal.throwIfAborted();
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
    id,
    input$,
    edit$,
    files$,
    load$,
    start$,
    attachments$: draft.attachments$,
  };
}

export type LandingFilesSignals = ReturnType<typeof createLandingFilesSignals>;
