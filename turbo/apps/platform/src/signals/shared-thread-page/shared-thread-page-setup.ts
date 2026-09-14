import { isRetiredGoalArchiveText } from "@okouai/api-contracts/contracts/retired-goal-archive";
import { literalHistoryTree } from "../../lib/markdown/literal-history.ts";
import { sharedThreadsContract } from "@okouai/api-contracts/contracts/shared-threads";
import { command } from "ccstate";
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
import { updateDocumentTitle$ } from "../document-title.ts";
import { pathParams$ } from "../route.ts";
import { updatePage$ } from "../react-router.ts";
import { setPageSignal$ } from "../page-signal.ts";
import { createSharedThreadRichContentSignals } from "./shared-thread-rich-content.ts";

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
    let sharedThread: SharedDisplayThread | null = null;
    if (result.status === 200) {
      const messages: SharedDisplayThread["messages"][number][] = [];
      const richMessages: (typeof result.body.messages)[number][] = [];
      for (const message of result.body.messages) {
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
      sharedThread = {
        ...result.body,
        messages,
        richContent:
          richMessages.length === 0
            ? undefined
            : createSharedThreadRichContentSignals(richMessages, signal),
      };
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
