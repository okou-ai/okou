import { command, type Command } from "ccstate";
import type {
  GenerationTemplateRequest,
  ImageAnnotation,
} from "@okouai/api-contracts/contracts/chat-threads";
import type { ConnectorSlug } from "@okouai/api-contracts/contracts/connector-identity";
import { formatUserPresentationTemplateId } from "@okouai/core/presentation-template-selection";
import type {
  ChatAttachment,
  DraftSignals,
  RestorableAttachment,
} from "./chat-draft.ts";
import type { ComposerTaskChipsSignals } from "./composer-task-chips.ts";
import type { ComposerTemplateAttachment } from "./tiptap-workflow-composer.ts";
import type { ComposerUiSignalGroups } from "./chat-composer.ts";
import type { ComposerConnectorSignals } from "./connectors.ts";
import { loadCustomTemplateCatalog$ } from "./custom-template-library.ts";
import { invalidateAgentConnectorAccess$ } from "./composer-agent-connectors.ts";
import { withCleanup } from "../utils.ts";

export function createComposerTemplateSelection(
  taskChips: ComposerTaskChipsSignals,
  templates: ComposerUiSignalGroups["template"],
  saveDraft$: Command<Promise<void>, [AbortSignal]>,
) {
  return command(
    async (
      { set },
      value: GenerationTemplateRequest,
      builtInAttachment: ComposerTemplateAttachment | undefined,
      signal: AbortSignal,
    ): Promise<void> => {
      signal.throwIfAborted();
      let attachment = builtInAttachment;
      let type: GenerationTemplateRequest["type"] = value.type;
      if (!attachment && value.type === "custom") {
        const catalog = await set(loadCustomTemplateCatalog$, signal);
        const template = catalog.find((entry) => {
          return entry.id === value.selection.userTemplateId;
        });
        if (template) {
          type = template.kind;
          attachment = {
            type: "custom",
            title: template.title,
            category:
              template.kind === "presentation" ? "slides" : template.kind,
            ...(template.coverUrl === null || template.kind === "document"
              ? {}
              : { previewImageUrl: template.coverUrl }),
          };
        }
      } else if (!attachment && value.type === "presentation") {
        const catalog = await set(
          templates.loadImportedPresentationTemplates$,
          signal,
        );
        const template = catalog.find((entry) => {
          return (
            formatUserPresentationTemplateId(entry.id) ===
            value.selection.templateId
          );
        });
        if (template) {
          attachment = {
            type: "presentation",
            title: template.title,
            category: "slides",
            ...(template.coverUrl === null
              ? {}
              : { previewImageUrl: template.coverUrl }),
          };
        }
      }
      signal.throwIfAborted();
      if (!attachment) {
        return;
      }
      set(taskChips.selectTemplate$, value, attachment, type);
      await set(saveDraft$, signal);
    },
  );
}

export function createComposerDraftActions(
  draft: DraftSignals,
  saveDraft$: Command<Promise<void>, [AbortSignal]>,
) {
  const restorePastedAttachments$ = command(
    async (
      { set },
      attachments: RestorableAttachment[],
      signal: AbortSignal,
    ): Promise<void> => {
      // Insert the placeholders immediately, then persist the reconciled result.
      // In particular, never leave an unavailable pasted attachment in storage.
      await withCleanup(
        set(draft.restoreAttachments$, attachments, signal),
        () => {
          // A failed availability read must not lose the text or other draft input
          // already inserted by the paste. Navigation is cancellation, not a new
          // persistence owner: never start a save on an aborted page.
          if (!signal.aborted) {
            return set(saveDraft$, signal);
          }
          return undefined;
        },
      );
    },
  );
  const confirmAttachmentAnnotations$ = command(
    async (
      { set },
      attachment: ChatAttachment,
      annotations: ImageAnnotation | null,
      signal: AbortSignal,
    ): Promise<void> => {
      // The upload must settle before persistence: marks without their derivative
      // restore as a failed annotation. Preserve saving on failure as well.
      await withCleanup(
        set(attachment.confirmAnnotations$, annotations, signal),
        () => {
          if (!signal.aborted) {
            return set(saveDraft$, signal);
          }
          return undefined;
        },
      );
    },
  );
  const retryAttachmentAnnotations$ = command(
    async (
      { set },
      attachment: ChatAttachment,
      signal: AbortSignal,
    ): Promise<void> => {
      await withCleanup(set(attachment.retryAnnotationUpload$, signal), () => {
        if (!signal.aborted) {
          return set(saveDraft$, signal);
        }
        return undefined;
      });
    },
  );
  return {
    restorePastedAttachments$,
    confirmAttachmentAnnotations$,
    retryAttachmentAnnotations$,
  };
}

export type ComposerAttachmentAnnotationActions = Pick<
  ReturnType<typeof createComposerDraftActions>,
  "confirmAttachmentAnnotations$" | "retryAttachmentAnnotations$"
>;

export function createComposerConnectorCompletion(
  connector: ComposerConnectorSignals,
  agentId: string,
) {
  const completeConnectorAddition$ = command(
    async (
      { set },
      connectorSlug: ConnectorSlug,
      alreadyAuthorized: boolean,
      signal: AbortSignal,
    ): Promise<boolean> => {
      signal.throwIfAborted();
      if (!alreadyAuthorized) {
        await set(
          connector.setConnectorAuthorization$,
          { kind: "builtin", connectorSlug },
          true,
          signal,
        );
      }
      signal.throwIfAborted();
      set(connector.resources.reloadConnected$);
      return !alreadyAuthorized;
    },
  );
  const completeCustomConnectorAddition$ = command(({ set }) => {
    set(connector.resources.reloadConnected$);
    set(invalidateAgentConnectorAccess$, agentId);
  });
  return { completeConnectorAddition$, completeCustomConnectorAddition$ };
}
