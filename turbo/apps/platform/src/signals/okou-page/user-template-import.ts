import { command } from "ccstate";

import type { ComposerSignals } from "./composer-signals.ts";
import { submitDeckImport$ } from "./presentation-template-import.ts";

/**
 * Narrower than the official catalog's list: `USER_TEMPLATE_SOURCE_CONTENT_TYPES`
 * in the contract accepts only the two PowerPoint types, so offering `.pdf`
 * here would produce a run that cannot publish what it just analysed.
 */
export const USER_TEMPLATE_IMPORT_ACCEPT = ".pptx,.ppt";

/**
 * The message the deck is sent with.
 *
 * Unlike the official import, this one names the publish command. The reverse
 * guide is shared by both destinations and its publish step names
 * `presentation-template`, so a run told only to "save this as a template"
 * would file the result in the official catalog and the Custom panel would
 * stay empty. The destination is the one thing the guide cannot know, so it is
 * the one thing worth spending the user's message on.
 */
function userTemplateImportPrompt(): string {
  return [
    "Analyse this deck and save its visual language as a reusable custom template.",
    "Publish it with `okou user-template publish`, not `okou presentation-template publish`.",
  ].join(" ");
}

/** Attach the deck to the composer and send it, bound for the caller's own catalog. */
export const importUserTemplateDeck$ = command(
  async (
    { set },
    args: { readonly signals: ComposerSignals; readonly file: File },
    signal: AbortSignal,
  ): Promise<boolean> => {
    return await set(
      submitDeckImport$,
      { ...args, prompt: userTemplateImportPrompt() },
      signal,
    );
  },
);
