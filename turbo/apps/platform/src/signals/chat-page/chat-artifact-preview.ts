import { command, computed, state, type Computed, type Command } from "ccstate";
import { artifactReferencesContract } from "@okouai/api-contracts/client/artifact-references";
import type { MessageArtifactDetail } from "@okouai/api-contracts/contracts/message-artifact";
import type { ChatThreadArtifactFile } from "@okouai/api-contracts/contracts/chat-threads";
import { accept } from "../../lib/accept.ts";
import { messageArtifactKey } from "../../views/okou-page/attachment-url.ts";
import { resetSignal } from "../utils.ts";
import { apiClient$ } from "../api-client.ts";
import { artifactCatalogRevision$ } from "../artifact-deletion.ts";
import { createCardSignalsRegistry } from "./card-signal-map.ts";
import { isPreviewableChatUrl } from "./parse-body-blocks.ts";

export type MessageArtifactRead = Computed<
  Promise<MessageArtifactDetail | null>
>;
export const emptyMessageArtifact$ = computed(() => {
  return Promise.resolve(null);
});
export interface MessageArtifactReads {
  readonly beginOpen$: Command<AbortSignal, AbortSignal[]>;
  readonly detail$: MessageArtifactRead;
  readonly item$: Computed<Promise<ChatArtifactPreviewItem | undefined>>;
}
export const emptyPreviewItem$ = computed(() => {
  return Promise.resolve(undefined);
});
/** Cards, a sidebar and the lightbox in a chat share the same per-link read. */
export function createMessageArtifactDetails(
  threadId: string,
  driveAccountRevision$: Computed<string>,
) {
  const revision$ = state(0);
  const beginOpen$ = resetSignal();
  const registry = createCardSignalsRegistry(
    messageArtifactKey,
    (url: string): MessageArtifactReads => {
      const detail$: MessageArtifactRead = computed(async (get) => {
        if (!isPreviewableChatUrl(url)) {
          return null;
        }
        get(revision$);
        get(artifactCatalogRevision$);
        const result = await accept(
          get(apiClient$)(artifactReferencesContract).byUrl({
            query: { url },
          }),
          [200, 404],
          undefined,
          { showErrorToast: false },
        );
        return result.status === 200 ? result.body : null;
      });
      // Only the open preview's action bar subscribes to the viewing chat's selected Drive account.
      const item$ = computed(async (get) => {
        const detail = await get(detail$);
        const item = ownedPreviewItem(detail);
        if (!item?.file.artifactId || !detail?.owner) {
          return item;
        }
        get(driveAccountRevision$);
        const result = await accept(
          get(apiClient$)(artifactReferencesContract).driveStatus({
            params: { publicationId: detail.owner.publicationId },
            query: { chatThreadId: threadId },
          }),
          [200, 404],
          undefined,
          { showErrorToast: false },
        );
        return result.status === 200
          ? { file: { ...item.file, ...result.body } }
          : item;
      });
      return { detail$, item$, beginOpen$ };
    },
  );
  return {
    register$: registry.register$,
    refresh$: command(({ set }) => {
      return set(revision$, (n) => {
        return n + 1;
      });
    }),
  };
}

export interface ChatArtifactPreviewItem {
  readonly file: ChatThreadArtifactFile;
}

/** Only an owned publication supplies management, Drive, and quote identities. */
export function ownedPreviewItem(
  detail: MessageArtifactDetail | null,
): ChatArtifactPreviewItem | undefined {
  if (!detail?.owner) {
    return undefined;
  }
  const { owner, preview } = detail;
  const hosted =
    preview.kind === "website" || preview.kind === "presentation-html"
      ? preview
      : undefined;
  return {
    file: {
      id: owner.fileId,
      artifactId: owner.artifactId,
      createdAt: owner.createdAt,
      title: owner.title,
      filename: detail.filename,
      url: detail.url,
      size: detail.size ?? 0,
      contentType: detail.contentType,
      aliasUrl: hosted?.aliasUrl,
      artifactKind: hosted?.kind === "website" ? "hosted-site" : hosted?.kind,
    },
  };
}
