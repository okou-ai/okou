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
import { registerComposerConnectHost$ } from "./composer-connect-hosts.ts";
import { withCleanup } from "../utils.ts";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { featureSwitch$ } from "../external/feature-switch.ts";

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
      // eslint-disable-next-line ccstate/no-with-cleanup -- Legacy 20261022: existing withCleanup only; do not add new usages.
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
      { get, set },
      attachment: ChatAttachment,
      annotations: ImageAnnotation | null,
      signal: AbortSignal,
    ): Promise<void> => {
      // The marks are stored on this call and the editor closes on it, so the
      // copy is still uploading while the user can already leave the chat.
      // Save the marks now, as the missing-copy draft a restore rebuilds, so a
      // cancelled upload does not take them with it.
      const copy = set(attachment.confirmAnnotations$, annotations, signal);
      const [, copied] = await Promise.allSettled([
        set(saveDraft$, signal),
        copy,
      ]);
      signal.throwIfAborted();
      // A failed copy is the chip's to show and retry; the first save has
      // already written the marks without it.
      if (copied?.status === "rejected") {
        throw copied.reason;
      }
      // Then once more to record the finished copy, so a reload does not
      // flatten and upload it again. This save supersedes the first, so the
      // first one's outcome no longer decides what the draft holds.
      if (get(attachment.annotatedFileId$) !== null) {
        await set(saveDraft$, signal);
      }
    },
  );
  return {
    restorePastedAttachments$,
    confirmAttachmentAnnotations$,
  };
}

export function createComposerConnectorCompletion(
  connector: ComposerConnectorSignals,
  agentId: string,
) {
  const completeConnectorAddition$ = command(
    async (
      { get, set },
      connectorSlug: ConnectorSlug,
      alreadyAuthorized: boolean,
      signal: AbortSignal,
    ): Promise<boolean> => {
      signal.throwIfAborted();
      const chatAccounts =
        get(featureSwitch$)[FeatureSwitchKey.ConnectorChatAccountAccess];
      if (!chatAccounts && !alreadyAuthorized) {
        await set(
          connector.setConnectorAuthorization$,
          { kind: "builtin", connectorSlug },
          true,
          signal,
        );
      }
      signal.throwIfAborted();
      set(connector.resources.reloadConnected$);
      if (chatAccounts) {
        set(connector.chatAccess.reload$);
      }
      return !chatAccounts && !alreadyAuthorized;
    },
  );
  const completeCustomConnectorAddition$ = command(({ get, set }) => {
    set(connector.resources.reloadConnected$);
    if (get(featureSwitch$)[FeatureSwitchKey.ConnectorChatAccountAccess]) {
      set(connector.chatAccess.reload$);
    } else {
      set(invalidateAgentConnectorAccess$, agentId);
    }
  });
  // A connection started from this composer finds it again by this key.
  const connectHostKey = crypto.randomUUID();
  const registerConnectHost$ = command(({ set }, signal: AbortSignal) => {
    set(
      registerComposerConnectHost$,
      connectHostKey,
      {
        agentId,
        connector,
        completeConnectorAddition$,
        completeCustomConnectorAddition$,
      },
      signal,
    );
  });
  return {
    completeConnectorAddition$,
    completeCustomConnectorAddition$,
    connectHostKey,
    registerConnectHost$,
  };
}
