import {
  createAttachmentPreviewSignals,
  type AttachmentPreviewSignals,
} from "../attachment-resource-url.ts";
import { command, computed, state } from "ccstate";
import { openArtifactInOpenSidebar$ } from "../chat-page/thread-sidebar-coordinator.ts";
import {
  createMarkdownPreviewTree,
  type MarkdownPreviewTreeComputed,
} from "../markdown-preview-tree.ts";
import type { ArtifactRefInput } from "../chat-page/thread-sidebar.ts";
import { previewAttachmentFromUrl } from "../chat-page/parse-body-blocks.ts";
import {
  createTextPreviewComputed,
  isTextPreviewKind,
  type TextPreviewComputed,
  type TextPreviewKind,
} from "../text-preview.ts";
import { onRef, resetSignal } from "../utils.ts";
import {
  createObjectUrlResource,
  type ObjectUrlResource,
} from "../object-url-resource.ts";
import { rootSignal$ } from "../root-signal.ts";
import type {
  ChatThreadArtifactGoogleDriveRecovery,
  ImageAnnotation,
} from "@okouai/api-contracts/contracts/chat-threads";
import { createZoomableImageCanvasSignals } from "../zoomable-image-canvas.ts";

// ---------------------------------------------------------------------------
// Lightbox state — tracks which attachment is open in the global preview UI
// ---------------------------------------------------------------------------

export type AttachmentArtifactMetadata = {
  readonly googleDriveAccountReady: boolean;
  readonly agentId?: string | null;
  readonly artifactKind?: "hosted-site" | "presentation-html";
  readonly contentType: string;
  readonly createdAt: string;
  readonly fileId: string;
  readonly filename: string;
  readonly googleDriveDisconnected: boolean;
  readonly googleDriveRecovery:
    | ChatThreadArtifactGoogleDriveRecovery
    | undefined;
  readonly googleDriveSynced: boolean;
  readonly onSyncSuccess?: () => void;
  readonly runId: string;
  readonly size: number;
  readonly threadId: string;
};

interface AttachmentNamedLightboxBase {
  readonly url: string;
  readonly filename: string;
  readonly artifact?: AttachmentArtifactMetadata;
  readonly shareAvailable?: boolean;
  readonly showSizeInSubtitle?: boolean;
  readonly splitViewAvailable?: boolean;
}

type AttachmentTextDocumentLightboxInput = AttachmentNamedLightboxBase & {
  readonly kind: TextPreviewKind;
  readonly text$?: TextPreviewComputed;
};

type AttachmentFramedDocumentLightboxInput = AttachmentNamedLightboxBase & {
  readonly kind: "html" | "pdf";
};

type AttachmentFileLightboxInput = AttachmentNamedLightboxBase & {
  readonly kind: "file";
};

type AttachmentDocumentLightboxInput =
  | AttachmentTextDocumentLightboxInput
  | AttachmentFramedDocumentLightboxInput;

type AttachmentImageLightboxInput = {
  readonly url: string;
  /** Reuse the initiating thread image's already resolved credential. */
  readonly preview?: AttachmentPreviewSignals;
  readonly file?: File;
  /**
   * Present only for an image the viewer is allowed to mark up — a composer
   * draft. Artifacts and sent messages open the same lightbox without it, so
   * the annotate affordance simply is not there for something immutable.
   */
  readonly annotationTarget?: {
    readonly annotations: ImageAnnotation | null;
    readonly open: () => void;
  };
  readonly filename?: string;
  readonly threadId?: string;
  readonly artifact?: AttachmentArtifactMetadata;
  readonly shareAvailable?: boolean;
  readonly showSizeInSubtitle?: boolean;
  readonly splitViewAvailable?: boolean;
};

type AttachmentDocumentLightboxState =
  | (AttachmentNamedLightboxBase & {
      readonly kind: Exclude<TextPreviewKind, "markdown">;
      readonly text$: TextPreviewComputed;
    })
  | (AttachmentNamedLightboxBase & {
      readonly kind: "markdown";
      readonly text$: TextPreviewComputed;
      /** Prepared render tree, diagram signals embedded. */
      readonly markdownTree$: MarkdownPreviewTreeComputed;
    })
  | AttachmentFramedDocumentLightboxInput;

function isAttachmentTextDocumentLightboxInput(
  value: AttachmentDocumentLightboxInput,
): value is AttachmentTextDocumentLightboxInput {
  return isTextPreviewKind(value.kind);
}

type AttachmentImageLightboxState = AttachmentImageLightboxInput & {
  readonly kind: "image";
};

type AttachmentLightboxInput =
  | AttachmentImageLightboxState
  | AttachmentDocumentLightboxState
  | AttachmentFileLightboxInput
  | {
      kind: "audio" | "video";
      url: string;
      filename: string;
      artifact?: AttachmentArtifactMetadata;
      shareAvailable?: boolean;
      showSizeInSubtitle?: boolean;
      splitViewAvailable?: boolean;
    };

export type AttachmentLightboxState = AttachmentLightboxInput &
  ReturnType<typeof createAttachmentPreviewSignals>;

const internalLightboxState$ = state<AttachmentLightboxState | null>(null);
const internalLightboxDialogVisible$ = state(false);
const internalLightboxDialogFullscreen$ = state(false);
const internalLightboxDialogMountToken$ = state(0);
const internalLightboxDialogElement$ = state<HTMLDivElement | null>(null);

export const lightboxDialogElement$ = command(({ get }) => {
  return get(internalLightboxDialogElement$);
});
const resetLightboxPreviewSignal$ = resetSignal();
export const attachmentLightboxImageCanvasSignals =
  createZoomableImageCanvasSignals();
const internalLightboxObjectUrlResources$ = state<readonly ObjectUrlResource[]>(
  [],
);

const releaseLightboxObjectUrlResources$ = command(({ get, set }) => {
  for (const resource of get(internalLightboxObjectUrlResources$)) {
    resource.release();
  }
  set(internalLightboxObjectUrlResources$, []);
});

const disposeLightboxSession$ = command(({ set }) => {
  set(internalLightboxDialogVisible$, false);
  set(internalLightboxDialogFullscreen$, false);
  set(internalLightboxState$, null);
  set(attachmentLightboxImageCanvasSignals.reset$);
  set(resetLightboxPreviewSignal$);
  set(releaseLightboxObjectUrlResources$);
});

/**
 * Closes without the exit animation. Handing the screen to the annotation
 * editor used to animate the viewer out while the editor animated in, and the
 * two transitions read as the modal jumping.
 */
export const closeLightboxImmediately$ = command(({ set }) => {
  set(disposeLightboxSession$);
});

const disposeLightboxForDialogUnmountToken$ = command(
  ({ get, set }, token: number) => {
    if (get(internalLightboxDialogMountToken$) !== token) {
      return;
    }
    set(disposeLightboxSession$);
  },
);

export const lightboxUrl$ = computed((get) => {
  return get(internalLightboxState$);
});

export const lightboxDialogVisible$ = computed((get) => {
  return get(internalLightboxDialogVisible$);
});

export const lightboxDialogFullscreen$ = computed((get) => {
  return get(internalLightboxDialogFullscreen$);
});

export const toggleLightboxDialogFullscreen$ = command(({ get, set }) => {
  set(
    internalLightboxDialogFullscreen$,
    !get(internalLightboxDialogFullscreen$),
  );
});

export const completeLightboxDialogExit$ = command(
  ({ get, set }, open: boolean) => {
    if (!open && !get(internalLightboxDialogVisible$)) {
      set(disposeLightboxSession$);
    }
  },
);

export const closeLightboxWithDialogExit$ = command(
  ({ set }, signal: AbortSignal) => {
    signal.throwIfAborted();
    set(internalLightboxDialogVisible$, false);
  },
);

/**
 * An open artifact sidebar owns every artifact click that could live in it, so
 * the preview swaps the sidebar content instead of stacking a dialog over it.
 * Previews that cannot move into the sidebar keep the lightbox.
 *
 * This is opt-out: a new lightbox caller is routed unless it explicitly targets
 * the lightbox or sets `splitViewAvailable: false`. An explicit target lets a
 * modal stack its preview without disabling the preview's split-view action.
 * Disable split view for previews that do not belong in the thread sidebar,
 * such as a pending composer upload. File-backed previews pass
 * the File metadata so each destination can create an object URL for its own
 * consumer lifetime while preserving the name and content type.
 */
type AttachmentSidebarPreviewInput = {
  readonly url: string;
  readonly file?: File;
  readonly filename?: string;
  readonly contentType?: string;
  readonly shareAvailable?: boolean;
  readonly splitViewAvailable?: boolean;
  readonly text$?: TextPreviewComputed;
  readonly preview?: AttachmentPreviewSignals;
};

export function attachmentSidebarRef(
  value: AttachmentSidebarPreviewInput,
): ArtifactRefInput {
  const share =
    value.shareAvailable === undefined
      ? {}
      : { shareAvailable: value.shareAvailable };
  if (value.file) {
    return { file: value.file, url: value.url, ...share };
  }
  if (value.filename) {
    const contentType =
      value.contentType ??
      previewAttachmentFromUrl(value.url, value.filename).contentType;
    return {
      url: value.url,
      filename: value.filename,
      ...(contentType ? { contentType } : {}),
      // The caller's preview content rides along, so the sidebar reuses the
      // already-fetched text instead of fetching its own copy.
      ...(value.text$ ? { text$: value.text$ } : {}),
      ...(value.preview ? { preview: value.preview } : {}),
      ...share,
    };
  }
  return value.url;
}

const routeToOpenArtifactSidebar$ = command(
  (
    { set },
    value: AttachmentSidebarPreviewInput,
    target?: "lightbox",
  ): boolean => {
    if (target === "lightbox" || value.splitViewAvailable === false) {
      return false;
    }
    return set(openArtifactInOpenSidebar$, attachmentSidebarRef(value));
  },
);

function imageLightboxState(
  input: AttachmentImageLightboxInput,
): AttachmentImageLightboxState {
  if (!input.file) {
    return { kind: "image", ...input };
  }
  return {
    kind: "image",
    ...input,
    filename: input.filename ?? input.file.name,
  };
}

export const openImageLightbox$ = command(
  (
    { get, set },
    value: string | AttachmentImageLightboxInput,
    target?: "lightbox",
  ) => {
    const input = typeof value === "string" ? { url: value } : value;
    if (set(routeToOpenArtifactSidebar$, input, target)) {
      return;
    }
    set(attachmentLightboxImageCanvasSignals.reset$);
    const previewSignal = set(resetLightboxPreviewSignal$, get(rootSignal$));
    const resource = input.file
      ? createObjectUrlResource(input.file, previewSignal)
      : undefined;
    if (resource) {
      set(internalLightboxObjectUrlResources$, (current) => {
        return [...current, resource];
      });
    }
    set(internalLightboxDialogVisible$, true);
    set(internalLightboxDialogFullscreen$, false);
    set(internalLightboxState$, {
      ...imageLightboxState(resource ? { ...input, url: resource.url } : input),
      ...(input.preview ??
        createAttachmentPreviewSignals(resource?.url ?? input.url)),
    });
  },
);

/**
 * Swap the previewed image without re-opening the dialog. Unlike
 * `openImageLightbox$`, this preserves the current fullscreen state so
 * keyboard/arrow navigation between images does not collapse fullscreen.
 */
export const navigateImageLightbox$ = command(
  (
    { get, set },
    value: {
      url: string;
      filename?: string;
      threadId?: string;
      preview?: AttachmentPreviewSignals;
      artifact?: AttachmentArtifactMetadata;
      shareAvailable?: boolean;
      showSizeInSubtitle?: boolean;
      splitViewAvailable?: boolean;
    },
  ) => {
    set(attachmentLightboxImageCanvasSignals.reset$);
    set(resetLightboxPreviewSignal$, get(rootSignal$));
    set(internalLightboxState$, {
      kind: "image",
      ...value,
      ...(value.preview ?? createAttachmentPreviewSignals(value.url)),
    });
  },
);

export const openDocumentLightbox$ = command(
  (
    { get, set },
    value: AttachmentDocumentLightboxInput,
    target?: "lightbox",
  ) => {
    if (set(routeToOpenArtifactSidebar$, value, target)) {
      return;
    }
    const previewSignal = set(resetLightboxPreviewSignal$, get(rootSignal$));
    set(internalLightboxDialogVisible$, true);
    set(internalLightboxDialogFullscreen$, false);
    const preview = createAttachmentPreviewSignals(value.url);
    if (isAttachmentTextDocumentLightboxInput(value)) {
      const text$ =
        value.text$ ??
        createTextPreviewComputed(value.url, preview.resourceUrl$);
      if (value.kind === "markdown") {
        set(internalLightboxState$, {
          ...value,
          kind: "markdown",
          ...preview,
          text$,
          markdownTree$: createMarkdownPreviewTree(text$, previewSignal),
        });
        return;
      }
      set(internalLightboxState$, {
        ...value,
        kind: value.kind,
        text$,
        ...preview,
      });
      return;
    }
    set(internalLightboxState$, { ...value, ...preview });
  },
);

function createSimpleLightboxOpener(kind: "audio" | "file" | "video") {
  return command(
    ({ get, set }, value: AttachmentNamedLightboxBase, target?: "lightbox") => {
      if (set(routeToOpenArtifactSidebar$, value, target)) {
        return;
      }
      set(resetLightboxPreviewSignal$, get(rootSignal$));
      set(internalLightboxDialogVisible$, true);
      set(internalLightboxDialogFullscreen$, false);
      set(internalLightboxState$, {
        kind,
        ...value,
        ...createAttachmentPreviewSignals(value.url),
      });
    },
  );
}

export const openFileLightbox$ = createSimpleLightboxOpener("file");
export const openVideoLightbox$ = createSimpleLightboxOpener("video");
export const openAudioLightbox$ = createSimpleLightboxOpener("audio");

// ---------------------------------------------------------------------------
// Global attachment preview mount owner — releases resources on route unmount
// ---------------------------------------------------------------------------

const ownLightboxDialogMount$ = command(
  ({ get, set }, element: HTMLDivElement, signal: AbortSignal) => {
    set(internalLightboxDialogElement$, element);
    const mountToken = get(internalLightboxDialogMountToken$) + 1;
    set(internalLightboxDialogMountToken$, mountToken);
    signal.addEventListener(
      "abort",
      () => {
        set(internalLightboxDialogElement$, null);
        // React can detach and immediately reattach a callback ref during a
        // render or StrictMode check. Defer disposal so that replacement mount
        // can supersede this token; a real route unmount has no replacement.
        queueMicrotask(() => {
          set(disposeLightboxForDialogUnmountToken$, mountToken);
        });
      },
      { once: true },
    );
  },
);

export const lightboxDialogMountRef$ = onRef(ownLightboxDialogMount$);
