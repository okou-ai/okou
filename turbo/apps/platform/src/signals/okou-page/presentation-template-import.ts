import {
  USER_TEMPLATE_KINDS,
  type UserTemplateKind,
} from "@okouai/api-contracts/contracts/user-templates";
import { command } from "ccstate";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";

import { featureSwitch$ } from "../external/feature-switch.ts";
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

/**
 * The Custom pane's tile, which publishes to the user template catalog.
 *
 * One entry for every kind rather than one entry per kind: the user picks a
 * file and the file decides what it becomes, so nothing asks them to classify
 * their own document before the analysis has read it.
 */
export const CUSTOM_TEMPLATE_IMPORT_ACCEPT = acceptList(USER_TEMPLATE_KINDS);

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
 * One sentence for every kind, because the guide already sorts them: the
 * `reverse-template` skill reads the file and follows the branch that matches.
 * Repeating that decision here would give the run two answers that can
 * disagree, and the one in the guide is the one that read the file.
 *
 * Which skill reads the file and which command publishes it are absent for the
 * same reason the deck's message leaves out the guide: they describe how the
 * run works, not what the member asked for, and a message reciting them reads
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
 * Only the catalog is worth saying. The guide's own publish step is
 * `okou presentation-template publish`, which writes to the presentation
 * table, and a template published there never reaches the Custom pane, which
 * reads the user template catalog. How to read the file, which branch to take
 * and what the package must contain are all in the guide, and restating any of
 * it here would only give the run a second answer to disagree with.
 */
function customTemplateImportGuidance(): string {
  return "Analyse this file with the `reverse-template` skill. Publish the result with `okou user-template publish`, not the `okou presentation-template publish` that guide names, so it appears under Custom.";
}

/** One import's message: what the member reads, and what only the run reads. */
interface TemplateImportMessage {
  readonly prompt: string;
  readonly additionalInfo: string | undefined;
}

/**
 * Which message an import is sent with.
 *
 * Neither answer reads the file. Which formats can become a template is what
 * the input's `accept` states and the file chooser applies, so re-reading the
 * extension here could only refuse a file the chooser already handed over,
 * and what to make of the one that arrives is the `reverse-template` guide's
 * decision rather than this function's.
 */
function templateImportMessage(
  customTemplates: boolean,
): TemplateImportMessage {
  return customTemplates
    ? {
        prompt: customTemplateImportPrompt(),
        additionalInfo: customTemplateImportGuidance(),
      }
    : {
        prompt: presentationTemplateImportPrompt(),
        additionalInfo: undefined,
      };
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
    // Which catalog the file lands in follows the switch that decides which
    // catalog the user can see. Sending every import to the custom catalog
    // while the switch is off would publish templates into a pane that member
    // cannot open, and take them out of the Presentation grid where they
    // currently appear.
    const message = templateImportMessage(
      get(featureSwitch$)[FeatureSwitchKey.CustomTemplates] === true,
    );

    const before = new Set(get(signals.draft.attachments$));
    await set(signals.draft.uploadAttachment$, file, signal);
    signal.throwIfAborted();
    // A failed upload resolves normally: the composer drops the attachment and
    // toasts. Sending now would ask for an analysis of a file that never
    // arrived, so stop at the error the user was already shown.
    const attached = get(signals.draft.attachments$).some((attachment) => {
      return !before.has(attachment);
    });
    if (!attached) {
      return false;
    }
    set(signals.draft.setDraftInput$, message.prompt);

    const action = await get(signals.submission.primaryAction$);
    signal.throwIfAborted();
    return await set(
      signals.submission.submitCurrentInput$,
      action,
      message.additionalInfo,
      signal,
    );
  },
);
