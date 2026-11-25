import { computed, type Computed } from "ccstate";
import { artifactCatalogContract } from "@okouai/api-contracts/client/artifact-catalog";
import type {
  ChatThreadArtifactFile,
  ChatThreadArtifactRun,
} from "@okouai/api-contracts/contracts/chat-threads";
import { accept } from "../../lib/accept.ts";
import { artifactPreviewUrlsMatch } from "../../views/okou-page/attachment-url.ts";
import { apiClient$ } from "../api-client.ts";
import type { ArtifactDeletionIdentity } from "../artifact-deletion.ts";
import {
  currentLeftThread$,
  currentRightThread$,
} from "./chat-thread-pane-state.ts";

export interface ChatArtifactPreviewItem {
  readonly runId: string;
  readonly file: ChatThreadArtifactFile;
}

export function findChatArtifactForUrl(
  runs: readonly ChatThreadArtifactRun[],
  url: string,
): ChatArtifactPreviewItem | undefined {
  for (const run of runs) {
    const file = run.files.find((candidate) => {
      return (
        artifactPreviewUrlsMatch(candidate.url, url) ||
        (candidate.aliasUrl !== undefined &&
          artifactPreviewUrlsMatch(candidate.aliasUrl, url))
      );
    });
    if (file) {
      return { runId: run.runId, file };
    }
  }
  return undefined;
}

interface ChatArtifactPreviewView {
  readonly threadId: string;
  readonly url: string;
}

interface CrossChatArtifactPreview {
  readonly view: ChatArtifactPreviewView;
  readonly item: ChatArtifactPreviewItem;
}

export interface CrossChatArtifactPreviewSignals {
  readonly view$: Computed<ChatArtifactPreviewView | undefined>;
  readonly artifact$: Computed<Promise<CrossChatArtifactPreview | undefined>>;
}

/** The preview and its deletion control resolve the same current thread metadata. */
export function createChatArtifactDeletionIdentity(
  source$: Computed<
    | {
        readonly url: string;
        readonly threadId?: string;
        readonly artifactId?: string;
      }
    | undefined
  >,
  crossChat: CrossChatArtifactPreviewSignals,
): Computed<Promise<ArtifactDeletionIdentity | null>> {
  return computed(async (get) => {
    const source = get(source$);
    if (!source) {
      return null;
    }
    const threads = [get(currentLeftThread$), get(currentRightThread$)].filter(
      (thread) => {
        return (
          thread && (!source.threadId || thread.threadId === source.threadId)
        );
      },
    );
    for (const thread of threads) {
      if (!thread) {
        continue;
      }
      const item = findChatArtifactForUrl(
        await get(thread.artifacts$),
        source.url,
      );
      if (item) {
        return item.file.artifactId
          ? { artifactId: item.file.artifactId }
          : null;
      }
    }
    const other = await get(crossChat.artifact$);
    const artifactId =
      other?.view.url === source.url
        ? other.item.file.artifactId
        : source.artifactId;
    return artifactId ? { artifactId } : null;
  });
}

/** The other pane can resolve the file, while Drive status belongs to the viewing Chat. */
export function createCrossChatArtifactPreview(
  view$: Computed<ChatArtifactPreviewView | undefined>,
): CrossChatArtifactPreviewSignals {
  const artifact$ = computed(async (get) => {
    const view = get(view$);
    if (!view) {
      return undefined;
    }
    const left = get(currentLeftThread$);
    const right = get(currentRightThread$);
    const viewing = left?.threadId === view.threadId ? left : right;
    const source = viewing === left ? right : left;
    if (viewing?.threadId !== view.threadId || !source || source === viewing) {
      return undefined;
    }

    // The viewing thread's run list also tracks its Drive account revision.
    const viewingRuns = await get(viewing.artifacts$);
    if (get(view$) !== view || findChatArtifactForUrl(viewingRuns, view.url)) {
      return undefined;
    }
    const sourceRuns = await get(source.artifacts$);
    if (get(view$) !== view) {
      return undefined;
    }
    const item = findChatArtifactForUrl(sourceRuns, view.url);
    if (!item?.file.artifactId) {
      return item && { view, item };
    }
    const result = await accept(
      get(apiClient$)(artifactCatalogContract).get({
        params: { artifactId: item.file.artifactId },
        query: { chatThreadId: view.threadId },
      }),
      [200, 404],
    );
    const detail = result.status === 200 ? result.body : undefined;
    return {
      view,
      item: {
        ...item,
        file: {
          ...item.file,
          googleDriveConnectionId: detail?.googleDriveConnectionId,
          googleDriveSync: detail?.googleDriveSync,
        },
      },
    };
  });
  return { view$, artifact$ };
}
