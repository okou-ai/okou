import type { UserTemplateKind } from "@okouai/api-contracts/contracts/user-templates";
import { command } from "ccstate";

import type { ComposerSignals } from "./composer-signals.ts";

/**
 * What a user uploads to make each kind of template.
 *
 * Keyed by kind rather than listed flat, so the table cannot describe a kind
 * the catalog does not have and a kind added to `USER_TEMPLATE_KINDS` fails to
 * compile until someone says what file produces one. Without that, a new kind
 * would be publishable by the CLI and unreachable from the product.
 *
 * `.ppt` is here because a deck old enough to still be saved in the legacy
 * binary format is exactly the deck whose visual language is worth reusing,
 * and a picker that greys it out reads as "not supported" rather than "export
 * it first". `.pdf` sits under presentation because that is the only kind it
 * has ever compiled to here; the mapping is this product's choice, not a fact
 * about the format.
 */
const TEMPLATE_IMPORT_EXTENSIONS: Readonly<
  Record<UserTemplateKind, readonly string[]>
> = {
  presentation: [".pptx", ".ppt", ".pdf"],
  document: [".docx", ".doc"],
  // `.webp` is here even though the reverse scripts cannot read it: they
  // convert it first, and it is what a phone screenshot or a saved web image
  // is. Refusing it in the picker would turn the one format users arrive with
  // into "not supported". `.gif` is absent for the opposite reason — a browser
  // draws it, but it animates where a cover is one still image, and its
  // palette is quantised to 256 colours, so the colour axis would describe the
  // encoder. `.tiff` is absent because no browser draws it.
  illustration: [".png", ".jpg", ".jpeg", ".webp", ".bmp"],
};

function acceptList(kinds: readonly UserTemplateKind[]): string {
  return kinds
    .flatMap((kind) => {
      return TEMPLATE_IMPORT_EXTENSIONS[kind];
    })
    .join(",");
}

/**
 * The Presentation tab's tile, which publishes to the presentation catalog.
 * It offers decks only, and must keep offering exactly those.
 */
export const PRESENTATION_TEMPLATE_IMPORT_ACCEPT = acceptList(["presentation"]);

/** The Image shelf imports only still images into the custom style catalog. */
export const IMAGE_TEMPLATE_IMPORT_ACCEPT = acceptList(["illustration"]);

/** The Document tab imports Word documents into the custom catalog. */
export const DOCUMENT_TEMPLATE_IMPORT_ACCEPT = acceptList(["document"]);

/**
 * The request sent to the custom template catalog.
 *
 * One sentence for every kind, because the guide already sorts them: the
 * `extract-template` skill reads the file and follows the branch that matches.
 * Repeating that decision here would give the run two answers that can
 * disagree, and the one in the guide is the one that read the file.
 *
 * Which skill reads the file and which command publishes it are absent for the
 * same reason: they describe how the run works, not what the member asked for,
 * and a message reciting them reads
 * as a script written for someone else in the member's own thread.
 * `customTemplateImportGuidance` carries them where only the run sees them.
 */
function customTemplateImportPrompt(): string {
  return "Analyse this file and save it as a reusable template.";
}

/**
 * What the run has to be told and the member does not, sent as the message's
 * `additional_info` part, which reaches the agent's prompt and never the
 * thread's visible text.
 *
 * Which guide and which catalog, and nothing else.
 *
 * Custom imports explicitly select the four-branch `extract-template`
 * dispatcher in `okou-ai/okou-skills`. The standing agent-tools prompt points
 * deck imports to the separate presentation-only registry guide.
 *
 * The catalog still has to be said because the presentation branch ends in
 * `okou presentation-template publish`, which writes to the presentation table
 * and never reaches the Custom pane. `--kind` rides along because the flag
 * defaults to `presentation`, and that kind then requires `--pages`: a
 * document published without the flag either fails for want of page images or
 * lands in the catalog as a presentation. Neither is worth explaining to the
 * run — the flag is in the command it is given.
 *
 * How to read the file, which branch to take and what the package must contain
 * are all in the guide, and restating any of it here would only give the run a
 * second answer to disagree with.
 */
function customTemplateImportGuidance(): string {
  return "Analyse this file with the `extract-template` dispatcher in `okou-ai/okou-skills`: read `extract-template/SKILL.md` there, take the branch it routes this file to, and follow that branch. Publish with `okou user-template publish` and the `--kind` that branch produced, so it appears under Custom.";
}

/**
 * Attach the file to the composer and send it.
 *
 * This deliberately reuses the ordinary composer path rather than adding an
 * upload protocol of its own: the file becomes a chat attachment and the
 * message is sent, so the analysis is a thread the member can open, interrupt
 * and follow up on, which a background job could not offer.
 *
 * Both entries open the thread the send creates. The analysis is the thing
 * the member just asked for, and watching it is where its progress is
 * reported, so neither catalog leaves them behind.
 */
export const importPresentationTemplateDeck$ = command(
  async (
    { get, set },
    args: { readonly signals: ComposerSignals; readonly file: File },
    signal: AbortSignal,
  ): Promise<boolean> => {
    const { signals, file } = args;
    await set(signals.draft.uploadAttachment$, file, signal);
    signal.throwIfAborted();
    // Import analyses the source, regardless of which creation task opened
    // the picker. Do not append that task's generation instructions.
    set(signals.create.setMode$, null, false);
    set(signals.draft.setDraftInput$, customTemplateImportPrompt());

    const action = await get(signals.submission.primaryAction$);
    signal.throwIfAborted();
    return await set(
      signals.submission.submitCurrentInput$,
      action,
      customTemplateImportGuidance(),
      signal,
    );
  },
);
