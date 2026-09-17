import {
  USER_TEMPLATE_KINDS,
  type UserTemplateKind,
} from "@okouai/api-contracts/contracts/user-templates";
import { command } from "ccstate";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { toast } from "@okouai/ui/components/ui/sonner";

import { i18n } from "../../i18n/index.ts";
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

function importedTemplateKind(file: File): UserTemplateKind | null {
  const name = file.name.toLowerCase();
  return (
    USER_TEMPLATE_KINDS.find((kind) => {
      return TEMPLATE_IMPORT_EXTENSIONS[kind].some((extension) => {
        return name.endsWith(extension);
      });
    }) ?? null
  );
}

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
 * The same request, aimed at the custom template catalog, per kind.
 *
 * Naming the command is the one instruction this message has to carry. The
 * reverse guide the run already loads ends at `okou presentation-template
 * publish`, which writes to the presentation table; a template published there
 * never reaches the Custom pane, which reads the user template catalog. Until
 * that pinned guide moves, the message is where the run learns which catalog
 * the user asked for — and, now that a source can compile to more than one
 * kind, which command publishes it.
 *
 * Each kind says its own sentence rather than one being what the others fall
 * through to: a document is not a deck read differently, it is styles rather
 * than pages, and a message that called it a deck would ask the run for page
 * images that a document template has no use for.
 */
function customTemplateImportPrompt(kind: UserTemplateKind): string {
  switch (kind) {
    case "presentation": {
      return "Analyse this deck and save its visual language as a reusable template. Publish it with `okou user-template publish` so it appears under Custom.";
    }
    case "document": {
      return "Analyse this document and save its styles as a reusable template. Publish it with `okou user-template publish --kind document` so it appears under Custom.";
    }
  }
}

/**
 * Which message this file is sent with, or null if it cannot become one.
 *
 * The switch-off answer does not read the file at all. That path is the one
 * every existing import already takes, and it has always sent the same
 * sentence for whatever the input accepted, so inspecting the file here could
 * only start refusing something it accepts today.
 */
function templateImportPrompt(args: {
  readonly file: File;
  readonly customTemplates: boolean;
}): string | null {
  if (!args.customTemplates) {
    return presentationTemplateImportPrompt();
  }
  const kind = importedTemplateKind(args.file);
  return kind === null ? null : customTemplateImportPrompt(kind);
}

/**
 * Attach the file to the composer and send it.
 *
 * This deliberately reuses the ordinary composer path rather than adding an
 * upload protocol of its own: the file becomes a chat attachment and the
 * message is sent, so the analysis is a thread the member can open, interrupt
 * and follow up on, which a background job could not offer.
 *
 * Where it leaves them differs by catalog. The Presentation tile opens the
 * thread, as it always has. The Custom entry does not: it is reached from
 * inside the picker, so the member is mid-task, and taking them out of the
 * picker discards the work they were doing to answer a question they did not
 * ask. The thread is still theirs to open from the sidebar, and the toast says
 * the analysis started, because a tile that swallows a click and changes
 * nothing visible reads as broken.
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
    const customTemplates =
      get(featureSwitch$)[FeatureSwitchKey.CustomTemplates] === true;
    // Decided before the upload so a file that cannot become a template is
    // refused while the user still has the picker open, rather than after the
    // bytes have been spent and a run has started.
    const prompt = templateImportPrompt({ file, customTemplates });
    if (prompt === null) {
      toast.error(
        i18n.t(
          ($) => {
            return $.artifacts.templates.importUnsupported;
          },
          { formats: CUSTOM_TEMPLATE_IMPORT_ACCEPT.split(",").join(", ") },
        ),
      );
      return false;
    }

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
    set(signals.draft.setDraftInput$, prompt);

    const action = await get(signals.submission.primaryAction$);
    signal.throwIfAborted();
    const sent = await set(
      signals.submission.submitCurrentInput$,
      action,
      { stayOnPage: customTemplates },
      signal,
    );
    if (sent && customTemplates) {
      toast.success(
        i18n.t(
          ($) => {
            return $.artifacts.templates.importStarted;
          },
          { filename: file.name },
        ),
      );
    }
    return sent;
  },
);
