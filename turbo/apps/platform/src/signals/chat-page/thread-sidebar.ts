import type { ChatThreadWorkflowAutomation } from "@okouai/api-contracts/contracts/workflows";
import {
  attachmentPreviewSignalsFor,
  createAttachmentPreviewSignals,
  type AttachmentPreviewSignals,
} from "../attachment-resource-url.ts";
import {
  command,
  computed,
  state,
  type Command,
  type Computed,
  type State,
} from "ccstate";

import {
  createArtifactCatalogSignals,
  type ArtifactCatalogSignals,
} from "../artifacts-page/create-artifact-catalog-signals.ts";
import { createCatalogArtifactPreviewSignals } from "../artifacts-page/artifact-catalog-preview.ts";
import {
  createTextPreviewComputed,
  isTextPreviewKind,
  type TextPreviewComputed,
} from "../text-preview.ts";
import { resetSignal } from "../utils.ts";
import {
  createMarkdownPreviewTree,
  type MarkdownPreviewTreeComputed,
} from "../markdown-preview-tree.ts";
import type {
  MailDraftCardSignalsRegistry,
  MailDraftSignals,
} from "./mail-draft.ts";
import {
  closeThreadMailLocation$,
  threadMailLocation$,
} from "./thread-mail-location.ts";
import {
  classifyChatAttachment,
  previewAttachmentFromUrl,
} from "./parse-body-blocks.ts";
import { createObjectUrlResource } from "../object-url-resource.ts";
import {
  createArtifactDiagramPreviewSignals,
  type ArtifactDiagramPreviewSignals,
} from "../artifact-diagram-preview.ts";
import type { MermaidDiagramPreviewCommand } from "../mermaid-diagram.ts";
import {
  createZoomableImageCanvasSignals,
  type ZoomableImageCanvasSignals,
} from "../zoomable-image-canvas.ts";

// ---------------------------------------------------------------------------
// Thread-owned utility sidebar.
//
// One thread holds at most one open sidebar target; the five target types are
// mutually exclusive by construction because they share a single state. The
// page-level coordinator (`thread-sidebar-coordinator.ts`) additionally keeps
// at most one utility sidebar open across the left and right thread panes.
// ---------------------------------------------------------------------------

/**
 * The artifact detail target serves two entry paths: a card opened from the
 * thread's catalog list, and a message attachment promoted from the lightbox
 * into split view.
 */
export type ArtifactPreviewKind =
  | "markdown"
  | "text"
  | "json"
  | "csv"
  | "html"
  | "pdf"
  | "image"
  | "video"
  | "audio"
  | "file";

export type ArtifactRef = {
  readonly wordDocumentHtml$: Computed<Promise<string>>;
  readonly resourceUrl$: Computed<Promise<string | null>>;
  readonly shareUrl$: Computed<Promise<string | null>>;
  readonly url: string;
  readonly kind: ArtifactPreviewKind;
  readonly filename: string;
  readonly shareAvailable?: boolean;
  /**
   * Text preview content for text-kind refs, resolved by the opening command
   * from the owning thread's artifact signals. The sidebar renders from the
   * ref alone.
   */
  readonly text$?: TextPreviewComputed;
  /** The prepared tree for markdown-kind refs, diagram signals embedded. */
  readonly markdownTree$?: MarkdownPreviewTreeComputed;
};

export type ArtifactFileRef = {
  readonly file: File;
  readonly shareAvailable?: boolean;
};

export type ArtifactMetadataRef = {
  readonly url: string;
  readonly filename: string;
  readonly contentType?: string;
  readonly shareAvailable?: boolean;
  readonly text$?: TextPreviewComputed;
  readonly preview?: AttachmentPreviewSignals;
};

export type ArtifactRefInput = string | ArtifactFileRef | ArtifactMetadataRef;

function artifactRefFromUrl(url: string): ArtifactRef {
  const attachment = previewAttachmentFromUrl(url);
  return {
    url,
    ...createAttachmentPreviewSignals(url),
    kind: classifyChatAttachment(attachment),
    filename: attachment.filename,
  };
}

function withTextPreview(
  ref: ArtifactRef,
  openDiagram$: MermaidDiagramPreviewCommand,
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
      ? {
          markdownTree$: createMarkdownPreviewTree(text$, openDiagram$),
        }
      : {}),
  };
}

function materializeArtifactRef(
  input: ArtifactRefInput,
  openDiagram$: MermaidDiagramPreviewCommand,
  signal: AbortSignal,
): ArtifactRef {
  if (typeof input === "string") {
    return withTextPreview(artifactRefFromUrl(input), openDiagram$);
  }
  if (!("file" in input)) {
    return withTextPreview(
      {
        url: input.url,
        ...attachmentPreviewSignalsFor(input),
        kind: classifyChatAttachment({
          contentType: input.contentType,
          filename: input.filename,
          url: input.url,
        }),
        filename: input.filename,
        ...(input.text$ === undefined ? {} : { text$: input.text$ }),
        ...(input.shareAvailable === undefined
          ? {}
          : { shareAvailable: input.shareAvailable }),
      },
      openDiagram$,
    );
  }
  const resource = createObjectUrlResource(input.file, signal);
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
      ...(input.shareAvailable === undefined
        ? {}
        : { shareAvailable: input.shareAvailable }),
    },
    openDiagram$,
  );
}

export type ThreadSidebarArtifactSource =
  | { readonly kind: "catalog"; readonly artifactId: string }
  | { readonly kind: "attachment"; readonly ref: ArtifactRef };

export type ThreadSidebarTarget =
  | { readonly type: "artifacts" }
  | { readonly type: "artifact"; readonly source: ThreadSidebarArtifactSource }
  | {
      readonly type: "email-draft";
      readonly signals: MailDraftSignals;
      readonly fromMailList?: true;
    }
  | { readonly type: "browser" }
  | { readonly type: "automations" };

export type ThreadSidebarOpenTarget = Exclude<
  ThreadSidebarTarget,
  { readonly type: "artifact" | "email-draft" }
>;

type NonMailThreadSidebarTarget = Exclude<
  ThreadSidebarTarget,
  { readonly type: "email-draft" }
>;

interface ThreadAutomationEditor {
  readonly automation: ChatThreadWorkflowAutomation;
}

export interface ThreadSidebarSignals {
  readonly target$: Computed<ThreadSidebarTarget | null>;
  readonly open$: Command<void, [ThreadSidebarOpenTarget, AbortSignal]>;
  readonly openCatalogArtifact$: Command<Promise<void>, [string, AbortSignal]>;
  readonly openAttachment$: Command<void, [ArtifactRefInput, AbortSignal]>;
  readonly selectedArtifactResourceUrl$: Computed<Promise<string | null>>;
  readonly selectedArtifactWordHtml$: Computed<Promise<string>>;
  readonly selectedArtifactShareUrl$: Computed<Promise<string | null>>;
  readonly close$: Command<void, []>;
  /** Clear presentation before another navigation owns the URL. */
  readonly dismiss$: Command<void, []>;
  /**
   * Whether the current sidebar session should animate into the split layout.
   * The first IndexedDB-driven auto-open captures `false`; later opens capture
   * `true` after the initial cache read completes.
   */
  readonly animateEntry$: Computed<boolean>;
  readonly enableEntryAnimations$: Command<void, []>;
  readonly editingAutomation$: Computed<ThreadAutomationEditor | null>;
  readonly closeEditingAutomation$: Command<
    void,
    [ThreadAutomationEditor | null]
  >;
  readonly setEditingAutomation$: Command<
    void,
    [ChatThreadWorkflowAutomation | null]
  >;
  /**
   * Sidebar fullscreen. Artifacts render a fullscreen toggle;
   * the state belongs to the current sidebar session and
   * clears whenever the target type changes or the sidebar closes.
   */
  readonly fullscreen$: Computed<boolean>;
  readonly toggleFullscreen$: Command<void, []>;
  readonly imageCanvas: ZoomableImageCanvasSignals;
  readonly diagram: ArtifactDiagramPreviewSignals;
  /**
   * Thread-scoped artifact catalog. Loaded pages persist across sidebar
   * close/reopen — ccstate computeds keep the cache — and are only dropped
   * with the thread signals themselves on a thread switch.
   */
  readonly artifactCatalog: ArtifactCatalogSignals;
  readonly selectedArtifactText$: TextPreviewComputed;
  readonly selectedArtifactMarkdownTree$: MarkdownPreviewTreeComputed;
}

function createThreadSidebarSessionSignals(dispose$: Command<void, []>) {
  const resetSidebarSessionSignal$ = resetSignal();
  const startSession$ = command(({ set }, signal: AbortSignal): AbortSignal => {
    signal.throwIfAborted();
    set(dispose$);
    const sessionSignal = set(resetSidebarSessionSignal$, signal);
    sessionSignal.addEventListener(
      "abort",
      () => {
        set(dispose$);
      },
      { once: true },
    );
    return sessionSignal;
  });
  return { resetSidebarSessionSignal$, startSession$ };
}

function createThreadSidebarTarget(
  threadId: string,
  mailRegistry: MailDraftCardSignalsRegistry,
  internalTarget$: State<NonMailThreadSidebarTarget | null>,
) {
  return computed((get): ThreadSidebarTarget | null => {
    const location = get(threadMailLocation$);
    if (location?.threadId === threadId && location.view === "detail") {
      const signals = get(mailRegistry.values$).find((candidate) => {
        return candidate.mailDraftId === location.mailDraftId;
      });
      return signals
        ? {
            type: "email-draft",
            signals,
            ...(location.fromList ? { fromMailList: true } : {}),
          }
        : null;
    }
    return get(internalTarget$);
  });
}

function createThreadAutomationEditorSignals() {
  const internalAutomationEditor$ = state<ThreadAutomationEditor | null>(null);
  return {
    editingAutomation$: computed((get) => {
      return get(internalAutomationEditor$);
    }),
    setEditingAutomation$: command(
      ({ set }, automation: ChatThreadWorkflowAutomation | null) => {
        set(
          internalAutomationEditor$,
          automation === null ? null : { automation },
        );
      },
    ),
    closeEditingAutomation$: command(
      ({ get, set }, editor: ThreadAutomationEditor | null) => {
        if (editor && get(internalAutomationEditor$) === editor) {
          set(internalAutomationEditor$, null);
        }
      },
    ),
  };
}

export function createThreadSidebarSignals(
  threadId: string,
  mailRegistry: MailDraftCardSignalsRegistry,
): ThreadSidebarSignals {
  const internalTarget$ = state<NonMailThreadSidebarTarget | null>(null);
  const internalEntryAnimationsEnabled$ = state(false);
  const internalAnimateEntry$ = state(false);
  const internalFullscreen$ = state(false);
  const automationEditor = createThreadAutomationEditorSignals();
  const imageCanvas = createZoomableImageCanvasSignals();
  const diagram = createArtifactDiagramPreviewSignals();
  const { resetSidebarSessionSignal$, startSession$ } =
    createThreadSidebarSessionSignals(diagram.dispose$);
  const artifactCatalog = createArtifactCatalogSignals({
    chatThreadId: threadId,
  });
  const preview = createCatalogArtifactPreviewSignals(
    artifactCatalog,
    diagram.open$,
  );

  const publishTarget$ = command(
    ({ get, set }, target: NonMailThreadSidebarTarget): void => {
      const current = get(internalTarget$);
      if (current === null) {
        set(internalAnimateEntry$, get(internalEntryAnimationsEnabled$));
      }
      if (current?.type !== target.type) {
        set(internalFullscreen$, false);
      }
      set(imageCanvas.reset$);
      if (target.type === "artifact" && target.source.kind === "catalog") {
        set(artifactCatalog.selectArtifact$, target.source.artifactId);
      }
      set(internalTarget$, target);
      set(closeThreadMailLocation$);
    },
  );

  const open$ = command(
    ({ set }, target: ThreadSidebarOpenTarget, signal: AbortSignal): void => {
      set(startSession$, signal);
      set(publishTarget$, target);
    },
  );

  const openCatalogArtifact$ = command(
    async ({ set }, artifactId: string, signal: AbortSignal): Promise<void> => {
      const sessionSignal = set(startSession$, signal);
      set(artifactCatalog.selectArtifact$, artifactId);
      set(publishTarget$, {
        type: "artifact",
        source: { kind: "catalog", artifactId },
      });
      await set(
        artifactCatalog.ensureSelectedArtifactPreview$,
        artifactId,
        sessionSignal,
      );
      signal.throwIfAborted();
      sessionSignal.throwIfAborted();
    },
  );

  const openAttachment$ = command(
    ({ set }, input: ArtifactRefInput, signal: AbortSignal): void => {
      const sessionSignal = set(startSession$, signal);
      set(publishTarget$, {
        type: "artifact",
        source: {
          kind: "attachment",
          ref: materializeArtifactRef(input, diagram.open$, sessionSignal),
        },
      });
    },
  );

  const dismiss$ = command(({ set }) => {
    set(resetSidebarSessionSignal$);
    set(internalTarget$, null);
    set(internalAnimateEntry$, false);
    set(internalFullscreen$, false);
    set(automationEditor.setEditingAutomation$, null);
    set(imageCanvas.reset$);
  });
  const close$ = command(({ set }) => {
    set(dismiss$);
    set(closeThreadMailLocation$, threadId);
  });

  return {
    target$: createThreadSidebarTarget(threadId, mailRegistry, internalTarget$),
    open$,
    openCatalogArtifact$,
    openAttachment$,
    close$,
    dismiss$,
    animateEntry$: computed((get) => {
      const location = get(threadMailLocation$);
      if (location?.threadId === threadId && location.view === "detail") {
        return false;
      }
      return get(internalAnimateEntry$);
    }),
    enableEntryAnimations$: command(({ set }) => {
      set(internalEntryAnimationsEnabled$, true);
    }),
    ...automationEditor,
    fullscreen$: computed((get) => {
      return get(internalFullscreen$);
    }),
    toggleFullscreen$: command(({ set }) => {
      set(imageCanvas.reset$);
      set(internalFullscreen$, (fullscreen) => {
        return !fullscreen;
      });
    }),
    imageCanvas,
    diagram,
    artifactCatalog,
    selectedArtifactText$: preview.text$,
    selectedArtifactMarkdownTree$: preview.markdownTree$,
    selectedArtifactResourceUrl$: preview.resourceUrl$,
    selectedArtifactWordHtml$: preview.wordDocumentHtml$,
    selectedArtifactShareUrl$: preview.shareUrl$,
  };
}
