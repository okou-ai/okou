import { command, computed, state, type Computed, type Command } from "ccstate";
import { artifactReferencesContract } from "@okouai/api-contracts/client/artifact-references";
import type { MessageArtifactDetail } from "@okouai/api-contracts/contracts/message-artifact";
import type { ChatThreadArtifactFile } from "@okouai/api-contracts/contracts/chat-threads";
import { accept } from "../../lib/accept.ts";
import { messageArtifactKey } from "../../views/okou-page/attachment-url.ts";
import { resetSignal } from "../utils.ts";
import { apiClient$, type ApiClientFactory } from "../api-client.ts";
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
function messageArtifactRequests(threadId: string, signal: AbortSignal) {
  return {
    async detail(client: ApiClientFactory, url: string) {
      signal.throwIfAborted();
      const result = await accept(
        client(artifactReferencesContract).byUrl({
          query: { url },
          fetchOptions: { signal },
        }),
        [200, 404],
        signal,
        { showErrorToast: false },
      );
      return result.status === 200 ? result.body : null;
    },
    async driveStatus(client: ApiClientFactory, publicationId: string) {
      signal.throwIfAborted();
      const result = await accept(
        client(artifactReferencesContract).driveStatus({
          params: { publicationId },
          query: { chatThreadId: threadId },
          fetchOptions: { signal },
        }),
        [200, 404],
        signal,
        { showErrorToast: false },
      );
      return result.status === 200 ? result.body : null;
    },
  };
}

/** Cards, a sidebar and the lightbox in a chat share the same per-link read. */
export function createMessageArtifactDetails(
  threadId: string,
  driveAccountRevision$: Computed<string>,
) {
  const requests$ = state<ReturnType<typeof messageArtifactRequests> | null>(
    null,
  );
  const resetRequests$ = resetSignal();
  const beginOpen$ = resetSignal();
  const registry = createCardSignalsRegistry(
    messageArtifactKey,
    (url: string): MessageArtifactReads => {
      const detail$: MessageArtifactRead = computed(async (get) => {
        const requests = get(requests$);
        if (!requests || !isPreviewableChatUrl(url)) {
          return null;
        }
        get(artifactCatalogRevision$);
        return await requests.detail(get(apiClient$), url);
      });
      // Only the open preview's action bar subscribes to the viewing chat's selected Drive account.
      const item$ = computed(async (get) => {
        const requests = get(requests$);
        const detail = await get(detail$);
        const item = ownedPreviewItem(detail);
        if (!requests || !item?.file.artifactId || !detail?.owner) {
          return item;
        }
        get(driveAccountRevision$);
        const drive = await requests.driveStatus(
          get(apiClient$),
          detail.owner.publicationId,
        );
        return drive ? { file: { ...item.file, ...drive } } : item;
      });
      return { detail$, item$, beginOpen$ };
    },
  );
  return {
    register$: registry.register$,
    restartRequests$: command(({ set }, signal: AbortSignal) => {
      const owner = set(resetRequests$, signal);
      set(requests$, messageArtifactRequests(threadId, owner));
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
