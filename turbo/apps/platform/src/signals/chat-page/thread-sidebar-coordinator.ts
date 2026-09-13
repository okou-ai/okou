import { createAttachmentPreviewSignals } from "../attachment-resource-url.ts";
import { command, computed } from "ccstate";

import {
  classifyChatAttachment,
  previewAttachmentFromUrl,
} from "./parse-body-blocks.ts";
import {
  createTextPreviewComputed,
  isTextPreviewKind,
} from "../text-preview.ts";
import { createMarkdownPreviewTree } from "../markdown-preview-tree.ts";
import {
  currentLeftThread$,
  currentRightThread$,
} from "./chat-thread-pane-state.ts";
import type { ChatPanelSignals } from "./chat-panel-signals.ts";
import type { MailDraftSignals } from "./mail-draft.ts";
import type {
  ArtifactRef,
  ArtifactRefInput,
  ThreadSidebarTarget,
} from "./thread-sidebar.ts";
import { createObjectUrlResource } from "../object-url-resource.ts";
import { resetSignal } from "../utils.ts";
import { pageSignal$ } from "../page-signal.ts";

// ---------------------------------------------------------------------------
// Page-level coordinator for the thread-owned utility sidebar. Sidebar state
// lives in the initiating thread's `ChatPanelSignals`; this module only
// enforces "at most one utility sidebar per page" across the two thread panes
// and routes every entry point into that thread-owned state.
// ---------------------------------------------------------------------------

/**
 * The single open utility sidebar on the page, with its owning thread. Null
 * while every pane's sidebar is closed.
 */
export const activeThreadSidebar$ = computed(
  (
    get,
  ): {
    readonly thread: ChatPanelSignals;
    readonly target: ThreadSidebarTarget;
    readonly animateEntry: boolean;
  } | null => {
    for (const thread of [get(currentLeftThread$), get(currentRightThread$)]) {
      if (!thread) {
        continue;
      }
      const target = get(thread.sidebar.target$);
      if (target) {
        return {
          thread,
          target,
          animateEntry: get(thread.sidebar.animateEntry$),
        };
      }
    }
    return null;
  },
);

export const syncActiveBrowserFitAction$ = command(({ get, set }) => {
  const active = get(activeThreadSidebar$);
  if (active?.target.type !== "browser") {
    return;
  }
  set(active.thread.browserSessionSignals.syncFitActionVisibility$);
});

const openOnThread$ = command(
  ({ get, set }, thread: ChatPanelSignals, target: ThreadSidebarTarget) => {
    for (const other of [get(currentLeftThread$), get(currentRightThread$)]) {
      if (other && other.threadId !== thread.threadId) {
        set(other.sidebar.close$);
      }
    }
    set(thread.sidebar.open$, target);
  },
);

export const openThreadArtifacts$ = command(
  ({ set }, thread: ChatPanelSignals) => {
    set(openOnThread$, thread, { type: "artifacts" });
  },
);

export const openThreadAutomations$ = command(
  ({ set }, thread: ChatPanelSignals) => {
    set(openOnThread$, thread, { type: "automations" });
  },
);

/**
 * The card hands over its own signals, which carry the owning thread id, so
 * the sidebar target holds everything its panel renders from — no registry
 * lookup on either side.
 */
export const openThreadMailDraft$ = command(
  ({ get, set }, signals: MailDraftSignals) => {
    const thread = [get(currentLeftThread$), get(currentRightThread$)].find(
      (candidate) => {
        return candidate?.threadId === signals.threadId;
      },
    );
    if (!thread) {
      return;
    }
    set(openOnThread$, thread, { type: "email-draft", signals });
  },
);

export const openThreadBrowserSession$ = command(
  ({ get, set }, threadId: string) => {
    const thread = [get(currentLeftThread$), get(currentRightThread$)].find(
      (candidate) => {
        return candidate?.threadId === threadId;
      },
    );
    if (!thread) {
      return;
    }
    set(openOnThread$, thread, { type: "browser" });
  },
);

export function artifactRefFromUrl(url: string): ArtifactRef {
  const attachment = previewAttachmentFromUrl(url);
  return {
    url,
    ...createAttachmentPreviewSignals(url),
    kind: classifyChatAttachment(attachment),
    filename: attachment.filename,
  };
}

/**
 * Text-kind refs always carry their preview content: the caller's computed
 * when it handed one over (reusing its fetch cache), a fresh one otherwise.
 * Markdown refs additionally carry their prepared tree. The sidebar renders
 * from the ref alone.
 */
function withTextPreview(
  ref: ArtifactRef,
  ownerSignal: AbortSignal,
): ArtifactRef {
  if (!isTextPreviewKind(ref.kind)) {
    return ref;
  }
  const text$ =
    ref.text$ ?? createTextPreviewComputed(ref.url, ref.resourceUrl$);
  return {
    ...ref,
    text$,
    ...(ref.kind === "markdown"
      ? { markdownTree$: createMarkdownPreviewTree(text$, ownerSignal) }
      : {}),
  };
}

const materializeArtifactRef$ = command(
  ({ set }, input: ArtifactRefInput, ownerSignal: AbortSignal): ArtifactRef => {
    const resetResources$ = resetSignal();
    const previewSignal = set(resetResources$, ownerSignal);
    if (typeof input === "string") {
      return withTextPreview(
        {
          ...artifactRefFromUrl(input),
          resetResources$,
        },
        previewSignal,
      );
    }
    if (!("file" in input)) {
      return withTextPreview(
        {
          url: input.url,
          ...(input.preview ?? createAttachmentPreviewSignals(input.url)),
          kind: classifyChatAttachment({
            contentType: input.contentType,
            filename: input.filename,
            url: input.url,
          }),
          filename: input.filename,
          resetResources$,
          ...(input.text$ === undefined ? {} : { text$: input.text$ }),
          ...(input.shareAvailable === undefined
            ? {}
            : { shareAvailable: input.shareAvailable }),
        },
        previewSignal,
      );
    }
    const resource = createObjectUrlResource(input.file, previewSignal);
    return withTextPreview(
      {
        url: resource.url,
        ...createAttachmentPreviewSignals(resource.url),
        kind: classifyChatAttachment({
          contentType: input.file.type,
          filename: input.file.name,
          url: resource.url,
        }),
        filename: input.file.name,
        resetResources$,
        ...(input.shareAvailable === undefined
          ? {}
          : { shareAvailable: input.shareAvailable }),
      },
      previewSignal,
    );
  },
);

/**
 * Promote a message attachment from the lightbox into split view. The lightbox
 * is page-global, so the main (left) thread hosts the sidebar.
 */
export const openThreadArtifactSplitView$ = command(
  ({ get, set }, input: ArtifactRefInput) => {
    const thread = get(currentLeftThread$) ?? get(currentRightThread$);
    if (!thread) {
      return;
    }
    set(openOnThread$, thread, {
      type: "artifact",
      source: {
        kind: "attachment",
        ref: set(materializeArtifactRef$, input, get(pageSignal$)),
      },
    });
  },
);

/**
 * Route an artifact click into an artifact sidebar the page already has open,
 * replacing its content in place. Returns false when the page has no artifact
 * sidebar, leaving the caller on its own preview surface.
 */
export const openArtifactInOpenSidebar$ = command(
  ({ get, set }, input: ArtifactRefInput): boolean => {
    const active = get(activeThreadSidebar$);
    if (
      active?.target.type !== "artifacts" &&
      active?.target.type !== "artifact"
    ) {
      return false;
    }
    // The owning thread already holds the page's only utility sidebar, so this
    // swaps its content without closing and reopening the pane.
    set(active.thread.sidebar.open$, {
      type: "artifact",
      source: {
        kind: "attachment",
        ref: set(materializeArtifactRef$, input, get(pageSignal$)),
      },
    });
    return true;
  },
);

/**
 * Card selection indicators for which mail draft / browser session the open
 * sidebar is showing, page-wide.
 */
export const activeSidebarMailDraftId$ = computed((get): string | null => {
  const active = get(activeThreadSidebar$);
  return active?.target.type === "email-draft"
    ? active.target.signals.mailDraftId
    : null;
});

export const activeSidebarBrowserThreadId$ = computed((get): string | null => {
  const active = get(activeThreadSidebar$);
  return active?.target.type === "browser" ? active.thread.threadId : null;
});
