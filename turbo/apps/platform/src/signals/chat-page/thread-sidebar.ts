import type { ChatThreadWorkflowAutomation } from "@okouai/api-contracts/contracts/workflows";
import {
  attachmentPreviewSignalsFor,
  createAttachmentPreviewSignals,
  shouldRefreshArtifactPreview,
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

import type { ArtifactCatalogViewSignals } from "../artifacts-page/create-artifact-catalog-signals.ts";
import {
  createCatalogArtifactPreviewSignals,
  createCatalogPreviewSessionsRefresh$,
} from "../artifacts-page/artifact-catalog-preview.ts";
import { selectArtifactPreviewSessions$ } from "../artifact-preview-sessions.ts";
import {
  createZipArtifactPreviewScope,
  type ZipArtifactPreviewScope,
} from "../zip-artifact-preview.ts";
import { isZipArtifact } from "../../lib/zip-artifact.ts";
import {
  createTextPreviewComputed,
  isTextPreviewKind,
  type TextPreviewComputed,
} from "../text-preview.ts";
import { detach, Reason, resetSignal } from "../utils.ts";
import { pageSignal$ } from "../page-signal.ts";
import { refreshWorkspaceLayout$ } from "./workspace-layout.ts";
import type {
  createMessageArtifactDetails,
  MessageArtifactReads,
} from "./chat-artifact-preview.ts";
import {
  prepareNarrowSidebarScroll$,
  restoreNarrowSidebarScroll$,
} from "./chat-layout.ts";
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
  readonly artifactReads?: MessageArtifactReads;
  readonly groupId?: string;
  readonly resourceUrl$: Computed<Promise<string | null>>;
  readonly imageUrl$: Computed<Promise<string | null>>;
  readonly shareUrl$: Computed<Promise<string | null>>;
  readonly url: string;
  readonly kind: ArtifactPreviewKind;
  readonly filename: string;
  readonly contentType?: string | undefined;
  readonly shareAvailable?: boolean;
  /**
   * Text preview content for text-kind refs, resolved by the opening command
   * from the owning thread's artifact signals. The sidebar renders from the
   * ref alone.
   */
  readonly text$?: TextPreviewComputed;
  /** The prepared tree for markdown-kind refs, diagram signals embedded. */
  readonly markdownTree$?: MarkdownPreviewTreeComputed;
  readonly zipPreview?: ZipArtifactPreviewScope;
};

export type ArtifactFileRef = {
  readonly file: File;
  readonly shareAvailable?: boolean;
};

export type ArtifactMetadataRef = {
  readonly groupId?: string;
  readonly url: string;
  readonly filename: string;
  readonly contentType?: string;
  readonly shareAvailable?: boolean;
  readonly text$?: TextPreviewComputed;
  readonly preview?: AttachmentPreviewSignals;
};

export type ArtifactRefInput = string | ArtifactFileRef | ArtifactMetadataRef;

type AttachmentArtifactRef = ArtifactRef &
  Pick<
    AttachmentPreviewSignals,
    "refreshOnArtifactChange$" | "refreshOnOpen$" | "artifactShareIdentity$"
  >;

function artifactRefFromUrl(url: string): AttachmentArtifactRef {
  const attachment = previewAttachmentFromUrl(url);
  const kind = classifyChatAttachment(attachment);
  return {
    url,
    ...createAttachmentPreviewSignals(url, {
      refreshOnArtifactChange: shouldRefreshArtifactPreview(kind),
    }),
    kind,
    filename: attachment.filename,
    contentType: attachment.contentType,
  };
}

interface ThreadArtifactPreviewContext {
  readonly openDiagram$: MermaidDiagramPreviewCommand;
  readonly threadId: string;
}

function withContentPreview(
  ref: AttachmentArtifactRef,
  { openDiagram$, threadId }: ThreadArtifactPreviewContext,
): AttachmentArtifactRef {
  if (!isTextPreviewKind(ref.kind)) {
    return ref.kind === "file" && isZipArtifact(ref.filename, ref.contentType)
      ? { ...ref, zipPreview: createZipArtifactPreviewScope(ref.resourceUrl$) }
      : ref;
  }
  const text$ =
    ref.text$ ?? createTextPreviewComputed(ref.url, ref.resourceUrl$);
  return {
    ...ref,
    text$,
    ...(ref.kind === "markdown"
      ? {
          markdownTree$: createMarkdownPreviewTree(
            text$,
            openDiagram$,
            threadId,
          ),
        }
      : {}),
  };
}

function materializeArtifactRef(
  input: ArtifactRefInput,
  previewContext: ThreadArtifactPreviewContext,
  signal: AbortSignal,
): AttachmentArtifactRef {
  if (typeof input === "string") {
    return withContentPreview(artifactRefFromUrl(input), previewContext);
  }
  if (!("file" in input)) {
    const kind = classifyChatAttachment({
      contentType: input.contentType,
      filename: input.filename,
      url: input.url,
    });
    return withContentPreview(
      {
        url: input.url,
        groupId: input.groupId,
        ...attachmentPreviewSignalsFor({
          ...input,
          refreshOnArtifactChange: shouldRefreshArtifactPreview(kind),
        }),
        kind,
        filename: input.filename,
        contentType: input.contentType,
        ...(input.text$ === undefined ? {} : { text$: input.text$ }),
        ...(input.shareAvailable === undefined
          ? {}
          : { shareAvailable: input.shareAvailable }),
      },
      previewContext,
    );
  }
  const resource = createObjectUrlResource(input.file, signal);
  return withContentPreview(
    {
      url: resource.url,
      ...createAttachmentPreviewSignals(resource.url),
      kind: classifyChatAttachment({
        contentType: input.file.type,
        filename: input.file.name,
        url: resource.url,
      }),
      filename: input.file.name,
      contentType: input.file.type,
      ...(input.shareAvailable === undefined
        ? {}
        : { shareAvailable: input.shareAvailable }),
    },
    previewContext,
  );
}

export type ThreadSidebarArtifactSource =
  | {
      readonly kind: "catalog";
      readonly artifactId: string;
      readonly ownerSignal: AbortSignal;
    }
  | {
      readonly kind: "attachment";
      readonly ref: AttachmentArtifactRef;
      readonly ownerSignal: AbortSignal;
    };

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
  readonly readArtifactOwner$: Command<AbortSignal | undefined, []>;
  readonly artifactDetails: ReturnType<typeof createMessageArtifactDetails>;
  readonly target$: Computed<ThreadSidebarTarget | null>;
  readonly open$: Command<void, [ThreadSidebarOpenTarget, AbortSignal]>;
  readonly openCatalogArtifact$: Command<Promise<void>, [string, AbortSignal]>;
  readonly openAttachment$: Command<void, [ArtifactRefInput, AbortSignal]>;
  readonly refreshPreviewSessions$: Command<Promise<void>, [AbortSignal]>;
  readonly selectedArtifactResourceUrl$: Computed<Promise<string | null>>;
  readonly selectedArtifactImageUrl$: Computed<Promise<string | null>>;
  readonly selectedArtifactShareUrl$: Computed<Promise<string | null>>;
  readonly selectedArtifactZipPreview: ZipArtifactPreviewScope;
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
  readonly artifactCatalog: ArtifactCatalogViewSignals;
  readonly selectedArtifactText$: TextPreviewComputed;
  readonly selectedArtifactMarkdownTree$: MarkdownPreviewTreeComputed;
}

const refreshClosedLayout$ = command(
  async ({ set }, signal: AbortSignal): Promise<void> => {
    await Promise.all([
      set(restoreNarrowSidebarScroll$, signal),
      set(refreshWorkspaceLayout$, signal),
    ]);
  },
);

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

function createOpenAttachmentCommand(
  startSession$: Command<AbortSignal, [AbortSignal]>,
  publishTarget$: Command<void, [NonMailThreadSidebarTarget]>,
  previewContext: ThreadArtifactPreviewContext,
  artifactDetails: ReturnType<typeof createMessageArtifactDetails>,
) {
  return command(
    ({ set }, input: ArtifactRefInput, signal: AbortSignal): void => {
      const sessionSignal = set(startSession$, signal);
      const source = materializeArtifactRef(
        input,
        previewContext,
        sessionSignal,
      );
      const ref = {
        ...source,
        artifactReads: set(artifactDetails.register$, source.url),
      };
      set(publishTarget$, {
        type: "artifact",
        source: {
          kind: "attachment",
          ownerSignal: sessionSignal,
          ref,
        },
      });
      set(
        selectArtifactPreviewSessions$,
        "sidebar",
        {
          url: ref.url,
          shareAvailable: ref.shareAvailable,
          artifactShareIdentity$: ref.artifactShareIdentity$,
          deletionIdentity: computed(async (get) => {
            const id = (await get(ref.artifactReads.detail$))?.owner
              ?.artifactId;
            return id ? { artifactId: id } : null;
          }),
        },
        sessionSignal,
      );
      detach(
        set(ref.refreshOnOpen$, ref.text$, sessionSignal),
        Reason.DomCallback,
        "retry attachment preview on open",
      );
    },
  );
}

function createOpenCatalogArtifactCommand(
  startSession$: Command<AbortSignal, [AbortSignal]>,
  publishTarget$: Command<void, [NonMailThreadSidebarTarget]>,
  artifactCatalog: ArtifactCatalogViewSignals,
  contentReady$: Computed<Promise<void>>,
  refreshPreviewSessions$: Command<Promise<void>, [AbortSignal]>,
) {
  return command(
    async ({ set }, artifactId: string, signal: AbortSignal): Promise<void> => {
      const sessionSignal = set(startSession$, signal);
      set(artifactCatalog.selectArtifact$, artifactId);
      set(publishTarget$, {
        type: "artifact",
        source: { kind: "catalog", artifactId, ownerSignal: sessionSignal },
      });
      await set(refreshPreviewSessions$, sessionSignal);
      signal.throwIfAborted();
      sessionSignal.throwIfAborted();
      const selectedPreview = await set(
        artifactCatalog.ensureSelectedArtifactPreview$,
        artifactId,
        sessionSignal,
      );
      signal.throwIfAborted();
      sessionSignal.throwIfAborted();
      if (selectedPreview) {
        await set(selectedPreview.refreshOnOpen$, contentReady$, sessionSignal);
        signal.throwIfAborted();
        sessionSignal.throwIfAborted();
      }
    },
  );
}

function createThreadSidebarTargetSignals(
  threadId: string,
  mailRegistry: MailDraftCardSignalsRegistry,
  internalTarget$: State<NonMailThreadSidebarTarget | null>,
) {
  const target$ = computed((get): ThreadSidebarTarget | null => {
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
  return {
    readArtifactOwner$: command(({ get }) => {
      const target = get(internalTarget$);
      return target?.type === "artifact"
        ? target.source.ownerSignal
        : undefined;
    }),
    target$,
  };
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

function createThreadSidebarPreviewSignals(
  threadId: string,
  artifactCatalog: ArtifactCatalogViewSignals,
) {
  const diagram = createArtifactDiagramPreviewSignals();
  const preview = createCatalogArtifactPreviewSignals(
    artifactCatalog,
    diagram.open$,
    threadId,
  );
  return {
    diagram,
    contentReady$: preview.contentReady$,
    selectedArtifactText$: preview.text$,
    selectedArtifactMarkdownTree$: preview.markdownTree$,
    selectedArtifactResourceUrl$: preview.resourceUrl$,
    selectedArtifactImageUrl$: preview.imageUrl$,
    selectedArtifactShareUrl$: preview.shareUrl$,
    selectedArtifactZipPreview: preview.zipPreview,
  };
}

export function createThreadSidebarSignals(
  threadId: string,
  mailRegistry: MailDraftCardSignalsRegistry,
  artifactCatalog: ArtifactCatalogViewSignals,
  artifactDetails: ReturnType<typeof createMessageArtifactDetails>,
): ThreadSidebarSignals {
  const internalTarget$ = state<NonMailThreadSidebarTarget | null>(null);
  const targets = createThreadSidebarTargetSignals(
    threadId,
    mailRegistry,
    internalTarget$,
  );
  const readCatalogOwner$ = command(({ get }) => {
    const target = get(internalTarget$);
    return target?.type === "artifact" && target.source.kind === "catalog"
      ? target.source.ownerSignal
      : undefined;
  });
  const refreshPreviewSessions$ = createCatalogPreviewSessionsRefresh$(
    artifactCatalog,
    readCatalogOwner$,
  );
  const internalEntryAnimationsEnabled$ = state(false);
  const internalAnimateEntry$ = state(false);
  const internalFullscreen$ = state(false);
  const automationEditor = createThreadAutomationEditorSignals();
  const imageCanvas = createZoomableImageCanvasSignals();
  const preview = createThreadSidebarPreviewSignals(threadId, artifactCatalog);
  const previewContext = { openDiagram$: preview.diagram.open$, threadId };
  const { resetSidebarSessionSignal$, startSession$ } =
    createThreadSidebarSessionSignals(preview.diagram.dispose$);

  const publishTarget$ = command(
    ({ get, set }, target: NonMailThreadSidebarTarget): void => {
      set(prepareNarrowSidebarScroll$);
      if (get(internalTarget$) === null) {
        set(internalAnimateEntry$, get(internalEntryAnimationsEnabled$));
      }
      if (get(internalTarget$)?.type !== target.type) {
        set(internalFullscreen$, false);
      }
      set(imageCanvas.reset$);
      if (target.type === "artifact" && target.source.kind === "catalog") {
        set(artifactCatalog.selectArtifact$, target.source.artifactId);
      }
      set(internalTarget$, target);
      set(closeThreadMailLocation$);
      detach(
        set(refreshWorkspaceLayout$, get(pageSignal$)),
        Reason.DomCallback,
      );
    },
  );

  const open$ = command(
    ({ set }, target: ThreadSidebarOpenTarget, signal: AbortSignal): void => {
      set(startSession$, signal);
      set(publishTarget$, target);
    },
  );

  const openCatalogArtifact$ = createOpenCatalogArtifactCommand(
    startSession$,
    publishTarget$,
    artifactCatalog,
    preview.contentReady$,
    refreshPreviewSessions$,
  );

  const openAttachment$ = createOpenAttachmentCommand(
    startSession$,
    publishTarget$,
    previewContext,
    artifactDetails,
  );

  const dismiss$ = command(({ get, set }) => {
    set(resetSidebarSessionSignal$);
    set(internalTarget$, null);
    set(internalAnimateEntry$, false);
    set(internalFullscreen$, false);
    set(automationEditor.setEditingAutomation$, null);
    set(imageCanvas.reset$);
    detach(set(refreshClosedLayout$, get(pageSignal$)), Reason.DomCallback);
  });

  return {
    ...targets,
    artifactDetails,
    open$,
    openCatalogArtifact$,
    openAttachment$,
    refreshPreviewSessions$,
    close$: command(({ set }) => {
      set(dismiss$);
      set(closeThreadMailLocation$, threadId);
    }),
    dismiss$,
    animateEntry$: computed((get) => {
      const location = get(threadMailLocation$);
      return location?.threadId === threadId && location.view === "detail"
        ? false
        : get(internalAnimateEntry$);
    }),
    enableEntryAnimations$: command(({ set }) => {
      set(internalEntryAnimationsEnabled$, true);
    }),
    ...automationEditor,
    fullscreen$: computed((get) => {
      return get(internalFullscreen$);
    }),
    toggleFullscreen$: command(({ get, set }) => {
      set(imageCanvas.reset$);
      set(internalFullscreen$, (fullscreen) => {
        return !fullscreen;
      });
      detach(
        set(refreshWorkspaceLayout$, get(pageSignal$)),
        Reason.DomCallback,
      );
    }),
    imageCanvas,
    artifactCatalog,
    ...preview,
  };
}
