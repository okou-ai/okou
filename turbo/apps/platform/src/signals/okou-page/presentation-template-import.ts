import { command } from "ccstate";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";

import { featureSwitch$ } from "../external/feature-switch.ts";
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
 * The same request, aimed at the custom template catalog.
 *
 * Naming the command is the one instruction this message has to carry. The
 * reverse guide the run already loads ends at `okou presentation-template
 * publish`, which writes to the presentation table; a template published there
 * never reaches the Custom pane, which reads the user template catalog. Until
 * that pinned guide moves, the message is where the run learns which catalog
 * the user asked for.
 */
function customTemplateImportPrompt(): string {
  return "Analyse this deck and save its visual language as a reusable template. Publish it with `okou user-template publish` so it appears under Custom.";
}

/**
 * Attach the deck to the composer and send it.
 *
 * This deliberately reuses the ordinary composer path rather than adding an
 * upload protocol of its own: the deck becomes a chat attachment, the message
 * is sent, and the existing new-thread flow creates the thread and navigates
 * into it. The user then watches the analysis happen and can interrupt or
 * follow up, which a background job could not offer.
 */
export const importPresentationTemplateDeck$ = command(
  async (
    { get, set },
    args: { readonly signals: ComposerSignals; readonly file: File },
    signal: AbortSignal,
  ): Promise<boolean> => {
    const { signals, file } = args;
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
    // Which catalog the deck lands in follows the switch that decides which
    // catalog the user can see. Sending every import to the custom catalog
    // while the switch is off would publish templates into a pane that member
    // cannot open, and take them out of the Presentation grid where they
    // currently appear.
    const customTemplates =
      get(featureSwitch$)[FeatureSwitchKey.CustomTemplates] === true;
    set(
      signals.draft.setDraftInput$,
      customTemplates
        ? customTemplateImportPrompt()
        : presentationTemplateImportPrompt(),
    );

    const action = await get(signals.submission.primaryAction$);
    signal.throwIfAborted();
    return await set(signals.submission.submitCurrentInput$, action, signal);
  },
);
