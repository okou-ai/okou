import { isRetiredGoalArchiveText } from "@okouai/api-contracts/contracts/retired-goal-archive";
import { literalHistoryTree } from "../../lib/markdown/literal-history.ts";
import {
  sharedThreadsContract,
  type SharedThreadResponse,
} from "@okouai/api-contracts/contracts/shared-threads";
import { command, computed, state } from "ccstate";
import { createElement } from "react";

import { accept } from "../../lib/accept.ts";
import { i18n } from "../../i18n/index.ts";
import { createPlainMarkdownTree } from "../../lib/markdown/plain-markdown.ts";
import {
  SharedThreadPage,
  type SharedDisplayThread,
} from "../../views/shared-thread-page/shared-thread-page.tsx";
import { hideAppSkeleton$ } from "../app-skeleton.ts";
import { apiClient$ } from "../api-client.ts";
import { createAttachmentPreviewSignals } from "../attachment-resource-url.ts";
import { updateDocumentTitle$ } from "../document-title.ts";
import { pathParams$ } from "../route.ts";
import { updatePage$ } from "../react-router.ts";
import { setPageSignal$ } from "../page-signal.ts";
import {
  createSharedThreadArtifactSignals,
  createSharedThreadRichContentSignals,
} from "./shared-thread-rich-content.ts";
import { createSharedThreadArtifactPreviewSignals } from "./shared-thread-artifact-preview.ts";
import { classifyChatAttachment } from "../chat-page/parse-body-blocks.ts";

const sharedThreadResponse$ = state<SharedThreadResponse | null>(null);
const sharedThread$ = computed((get) => {
  const response = get(sharedThreadResponse$);
  if (!response) {
    return null;
  }
  const artifactPreview = createSharedThreadArtifactPreviewSignals();
  const messages: SharedDisplayThread["messages"][number][] = [];
  const richMessages: SharedThreadResponse["messages"][number][] = [];
  for (const source of response.messages) {
    const message = {
      ...source,
      attachments: source.attachments?.map((attachment) => {
        const kind = classifyChatAttachment(attachment);
        return {
          ...attachment,
          ...(kind === "video" || kind === "html"
            ? {
                artifact: createSharedThreadArtifactSignals(
                  { ...attachment, kind },
                  artifactPreview,
                ),
              }
            : {}),
          preview: createAttachmentPreviewSignals(attachment.url, {
            contentType: attachment.contentType,
          }),
        };
      }),
    };
    if (message.role !== "assistant") {
      messages.push(message);
      continue;
    }
    const tree =
      message.runIndex === undefined &&
      message.runGroupIndex === undefined &&
      isRetiredGoalArchiveText(message.content)
        ? literalHistoryTree(message.content)
        : createPlainMarkdownTree(message.content, {
            mathEnabled: true,
          });
    if (tree === null) {
      richMessages.push(message);
      messages.push({ ...message, tree: undefined });
      continue;
    }
    messages.push({ ...message, tree });
  }
  const richContent =
    richMessages.length === 0
      ? undefined
      : createSharedThreadRichContentSignals(richMessages, artifactPreview);
  return { ...response, messages, richContent, artifactPreview };
});

export const setupSharedThreadPage$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    set(setPageSignal$, signal);
    const params = get(pathParams$);
    const id = String(params?.id ?? "");
    const client = get(apiClient$)(sharedThreadsContract);
    const result = await accept(
      client.get({ params: { id }, fetchOptions: { signal } }),
      [200, 404],
      signal,
    );
    set(sharedThreadResponse$, result.status === 200 ? result.body : null);
    const sharedThread = get(sharedThread$);
    if (sharedThread) {
      set(sharedThread.artifactPreview.initialize$, signal);
    }
    set(
      updateDocumentTitle$,
      sharedThread?.title ??
        i18n.t(($) => {
          return $.sharedThread.notFoundTitle;
        }),
    );
    set(updatePage$, createElement(SharedThreadPage, { sharedThread }));
    await set(hideAppSkeleton$, signal);
  },
);
