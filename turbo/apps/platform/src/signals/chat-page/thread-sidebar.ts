import {
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
import { artifactDetailPreview } from "../artifacts-page/artifact-catalog-signals.ts";
import {
  createTextPreviewComputed,
  fetchPreviewText,
  isTextPreviewKind,
  type TextPreviewComputed,
} from "../text-preview.ts";
import { resetSignal } from "../utils.ts";
import {
  createMarkdownPreviewTree,
  type MarkdownPreviewTreeComputed,
} from "../markdown-preview-tree.ts";
import type { MailDraftSignals } from "./mail-draft.ts";
import {
  classifyChatAttachment,
  previewAttachmentFromUrl,
} from "./parse-body-blocks.ts";
import { createObjectUrlResource } from "../object-url-resource.ts";
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

function withTextPreview(ref: ArtifactRef): ArtifactRef {
  if (!isTextPreviewKind(ref.kind)) {
    return ref;
  }
  const text$ =
    ref.text$ ?? createTextPreviewComputed(ref.url, ref.resourceUrl$);
  return {
    ...ref,
    text$,
    ...(ref.kind === "markdown"
      ? { markdownTree$: createMarkdownPreviewTree(text$) }
      : {}),
  };
}

function materializeArtifactRef(
  input: ArtifactRefInput,
  signal: AbortSignal,
): ArtifactRef {
  if (typeof input === "string") {
    return withTextPreview(artifactRefFromUrl(input));
  }
  if (!("file" in input)) {
    return withTextPreview({
      url: input.url,
      ...(input.preview ?? createAttachmentPreviewSignals(input.url)),
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
    });
  }
  const resource = createObjectUrlResource(input.file, signal);
  return withTextPreview({
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
  });
}

export type ThreadSidebarArtifactSource =
  | { readonly kind: "catalog"; readonly artifactId: string }
  | { readonly kind: "attachment"; readonly ref: ArtifactRef };

export type ThreadSidebarTarget =
  | { readonly type: "artifacts" }
  | { readonly type: "artifact"; readonly source: ThreadSidebarArtifactSource }
  | { readonly type: "email-draft"; readonly signals: MailDraftSignals }
  | { readonly type: "browser" }
  | { readonly type: "automations" };

export type ThreadSidebarOpenTarget =
  | Exclude<ThreadSidebarTarget, { readonly type: "artifact" }>
  | {
      readonly type: "artifact";
      readonly source: Extract<
        ThreadSidebarArtifactSource,
        { readonly kind: "catalog" }
      >;
    };

export interface ThreadSidebarSignals {
  readonly target$: Computed<ThreadSidebarTarget | null>;
  readonly open$: Command<void, [ThreadSidebarOpenTarget, AbortSignal]>;
  readonly openAttachment$: Command<void, [ArtifactRefInput, AbortSignal]>;
  readonly selectedArtifactResourceUrl$: Computed<Promise<string | null>>;
  readonly selectedArtifactShareUrl$: Computed<Promise<string | null>>;
  readonly close$: Command<void, []>;
  /**
   * Whether the current sidebar session should animate into the split layout.
   * The first IndexedDB-driven auto-open captures `false`; later opens capture
   * `true` after the initial cache read completes.
   */
  readonly animateEntry$: Computed<boolean>;
  readonly enableEntryAnimations$: Command<void, []>;
  readonly editingAutomationId$: Computed<string | null>;
  readonly setEditingAutomationId$: Command<void, [string | null]>;
  /**
   * Claim a derived auto-open candidate once for this thread. This prevents
   * later sync events from reopening a card the user already closed.
   */
  readonly claimAutoOpenCandidate$: Command<boolean, [string]>;
  /**
   * Sidebar fullscreen. Only the `artifacts` list and `artifact` detail render
   * a fullscreen toggle; the state belongs to the current sidebar session and
   * clears whenever the target type changes or the sidebar closes.
   */
  readonly fullscreen$: Computed<boolean>;
  readonly toggleFullscreen$: Command<void, []>;
  readonly imageCanvas: ZoomableImageCanvasSignals;
  /**
   * Thread-scoped artifact catalog. Loaded pages persist across sidebar
   * close/reopen — ccstate computeds keep the cache — and are only dropped
   * with the thread signals themselves on a thread switch.
   */
  readonly artifactCatalog: ArtifactCatalogSignals;
  readonly selectedArtifactText$: Computed<Promise<string>>;
  readonly selectedArtifactMarkdownTree$: MarkdownPreviewTreeComputed;
}

function createCatalogArtifactPreviewSignals(
  artifactCatalog: ArtifactCatalogSignals,
  internalArtifactPreviewVersion$: State<number>,
) {
  const selectedArtifactPreview$ = computed(async (get) => {
    get(internalArtifactPreviewVersion$);
    const detail = await get(artifactCatalog.selectedArtifactDetail$);
    return detail
      ? createAttachmentPreviewSignals(artifactDetailPreview(detail).url)
      : null;
  });

  const resourceUrl$ = computed(async (get) => {
    const preview = await get(selectedArtifactPreview$);
    return preview ? await get(preview.resourceUrl$) : null;
  });
  const shareUrl$ = computed(async (get) => {
    const preview = await get(selectedArtifactPreview$);
    return preview ? await get(preview.shareUrl$) : null;
  });

  const selectedArtifactText$ = computed(async (get): Promise<string> => {
    const detail = await get(artifactCatalog.selectedArtifactDetail$);
    if (!detail) {
      throw new Error("Selected artifact is unavailable");
    }
    const preview = artifactDetailPreview(detail);
    if (!isTextPreviewKind(preview.kind)) {
      throw new Error("Selected artifact is not a text preview");
    }
    const resourceUrl = await get(resourceUrl$);
    if (!resourceUrl) {
      throw new Error("Selected artifact preview is unavailable");
    }
    return fetchPreviewText(resourceUrl);
  });
  const selectedArtifactMarkdownTree$ = createMarkdownPreviewTree(
    selectedArtifactText$,
  );

  return {
    resourceUrl$,
    shareUrl$,
    text$: selectedArtifactText$,
    markdownTree$: selectedArtifactMarkdownTree$,
  };
}

export function createThreadSidebarSignals(
  threadId: string,
): ThreadSidebarSignals {
  const internalTarget$ = state<ThreadSidebarTarget | null>(null);
  const internalEntryAnimationsEnabled$ = state(false);
  const internalAnimateEntry$ = state(false);
  const internalFullscreen$ = state(false);
  const internalEditingAutomationId$ = state<string | null>(null);
  const internalClaimedAutoOpenCandidateKey$ = state<string | null>(null);
  const resetSidebarSessionSignal$ = resetSignal();
  const internalArtifactPreviewVersion$ = state(0);
  const imageCanvas = createZoomableImageCanvasSignals();
  const artifactCatalog = createArtifactCatalogSignals({
    chatThreadId: threadId,
  });
  const preview = createCatalogArtifactPreviewSignals(
    artifactCatalog,
    internalArtifactPreviewVersion$,
  );

  const startSession$ = command(({ set }, signal: AbortSignal): AbortSignal => {
    signal.throwIfAborted();
    const sessionSignal = set(resetSidebarSessionSignal$, signal);
    set(internalArtifactPreviewVersion$, (version) => {
      return version + 1;
    });
    return sessionSignal;
  });

  const publishTarget$ = command(
    ({ get, set }, target: ThreadSidebarTarget): void => {
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
    },
  );

  const open$ = command(
    ({ set }, target: ThreadSidebarOpenTarget, signal: AbortSignal): void => {
      set(startSession$, signal);
      set(publishTarget$, target);
    },
  );

  const openAttachment$ = command(
    ({ set }, input: ArtifactRefInput, signal: AbortSignal): void => {
      const sessionSignal = set(startSession$, signal);
      set(publishTarget$, {
        type: "artifact",
        source: {
          kind: "attachment",
          ref: materializeArtifactRef(input, sessionSignal),
        },
      });
    },
  );

  const close$ = command(({ set }) => {
    set(resetSidebarSessionSignal$);
    set(internalArtifactPreviewVersion$, (version) => {
      return version + 1;
    });
    set(internalTarget$, null);
    set(internalAnimateEntry$, false);
    set(internalFullscreen$, false);
    set(internalEditingAutomationId$, null);
    set(imageCanvas.reset$);
  });

  const claimAutoOpenCandidate$ = command(
    ({ get, set }, candidateKey: string): boolean => {
      if (get(internalClaimedAutoOpenCandidateKey$) === candidateKey) {
        return false;
      }
      set(internalClaimedAutoOpenCandidateKey$, candidateKey);
      return true;
    },
  );

  return {
    target$: computed((get) => {
      return get(internalTarget$);
    }),
    open$,
    openAttachment$,
    close$,
    animateEntry$: computed((get) => {
      return get(internalAnimateEntry$);
    }),
    enableEntryAnimations$: command(({ set }) => {
      set(internalEntryAnimationsEnabled$, true);
    }),
    editingAutomationId$: computed((get) => {
      return get(internalEditingAutomationId$);
    }),
    setEditingAutomationId$: command(({ set }, automationId: string | null) => {
      set(internalEditingAutomationId$, automationId);
    }),
    claimAutoOpenCandidate$,
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
    artifactCatalog,
    selectedArtifactText$: preview.text$,
    selectedArtifactMarkdownTree$: preview.markdownTree$,
    selectedArtifactResourceUrl$: preview.resourceUrl$,
    selectedArtifactShareUrl$: preview.shareUrl$,
  };
}
