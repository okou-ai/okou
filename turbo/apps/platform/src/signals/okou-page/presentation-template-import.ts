import { command } from "ccstate";

import type { ComposerSignals } from "./composer-signals.ts";

/**
 * Decks a user can hand over. They all end up as ordered page images the same
 * way, so nothing downstream distinguishes them.
 *
 * `.ppt` is here because a deck old enough to still be saved in the legacy
 * binary format is exactly the deck whose visual language is worth reusing,
 * and a picker that greys it out reads as "not supported" rather than "export
 * it first".
 */
export const PRESENTATION_TEMPLATE_IMPORT_ACCEPT = ".pptx,.ppt,.pdf";

/**
 * The message the deck is sent with.
 *
 * One plain sentence on purpose: importing a template is not a special
 * protocol, it is a chat message with a file attached, and the user should be
 * able to read what was asked on their behalf in the thread they land in.
 *
 * How to reach the guide is deliberately absent. The agent tools prompt
 * already carries it for every run, so repeating it here only spends the
 * user's own message on instructions addressed to the run.
 */
function presentationTemplateImportPrompt(): string {
  return "Analyse this deck and save its visual language as a reusable presentation template.";
}

/**
 * Attach the deck to the composer and send it.
 *
 * This deliberately reuses the ordinary composer path rather than adding an
 * upload protocol of its own: the deck becomes a chat attachment, the message
 * is sent, and the existing new-thread flow creates the thread and navigates
 * into it. The user then watches the analysis happen and can interrupt or
 * follow up, which a background job could not offer.
 *
 * The prompt is an argument because the same send serves two destinations: the
 * official catalog and the caller's own. Nothing else about the sequence
 * differs, and a second copy of it would be a second place for the
 * failed-upload rule below to drift.
 */
export const submitDeckImport$ = command(
  async (
    { get, set },
    args: {
      readonly signals: ComposerSignals;
      readonly file: File;
      readonly prompt: string;
    },
    signal: AbortSignal,
  ): Promise<boolean> => {
    const { signals, file, prompt } = args;
    const before = new Set(get(signals.draft.attachments$));
    await set(signals.draft.uploadAttachment$, file, signal);
    signal.throwIfAborted();
    // A failed upload resolves normally: the composer drops the attachment and
    // toasts. Sending now would ask for an analysis of a deck that never
    // arrived, so stop at the error the user was already shown.
    const attached = get(signals.draft.attachments$).some((attachment) => {
      return !before.has(attachment);
    });
    if (!attached) {
      return false;
    }
    set(signals.draft.setDraftInput$, prompt);

    const action = await get(signals.submission.primaryAction$);
    signal.throwIfAborted();
    return await set(signals.submission.submitCurrentInput$, action, signal);
  },
);

export const importPresentationTemplateDeck$ = command(
  async (
    { set },
    args: { readonly signals: ComposerSignals; readonly file: File },
    signal: AbortSignal,
  ): Promise<boolean> => {
    return await set(
      submitDeckImport$,
      { ...args, prompt: presentationTemplateImportPrompt() },
      signal,
    );
  },
);
