import { command, computed, state } from "ccstate";
import type { SandboxChannelPeer } from "@okouai/core/sandbox-channel-peer";
import { sandboxFsCategory } from "@okouai/api-contracts/contracts/sandbox-channel-fs";
import { SandboxChannelError } from "@okouai/api-contracts/contracts/sandbox-channel";
import { createBrowserSandboxChannelPeer } from "../../lib/sandbox-channel-peer.ts";
import {
  FilePreviewError,
  readSandboxFilePreview,
  type FilePreviewFailure,
  type SandboxPreviewContent,
} from "../../lib/sandbox-file-preview.ts";
import { apiClient$ } from "../api-client.ts";
import { authenticatedSessionKey$ } from "../auth.ts";
import { currentRunId$ } from "./activity-signals.ts";
import {
  onRef,
  onRejection,
  resetSignal,
  settle,
  withCleanup,
} from "../utils.ts";
import { createAttachmentPreviewSignals } from "../attachment-resource-url.ts";
import { parseMarkdownTree } from "../../lib/markdown/pipeline.ts";
import { createZoomableImageCanvasSignals } from "../zoomable-image-canvas.ts";
import type { AttachmentLightboxState } from "../okou-page/attachment-chips.ts";
import { createTextPreviewContent } from "../text-preview.ts";

interface PreviewRequest {
  readonly runId: string;
  readonly sessionKey: string;
  readonly path: readonly string[];
  readonly name: string;
}
type PreviewResult =
  | { readonly status: "loading" }
  | { readonly status: "error"; readonly error: FilePreviewFailure }
  | {
      readonly status: "ready";
      readonly preview: AttachmentLightboxState | null;
      readonly truncated: boolean;
    };

function previewFailure(error: unknown): FilePreviewFailure {
  if (error instanceof FilePreviewError) {
    return error.code;
  }
  if (error instanceof TypeError) {
    return "decode";
  }
  if (error instanceof SandboxChannelError) {
    if (error.code === "file_changed") {
      return "changed";
    }
    if (error.code === "limit_exceeded") {
      return "size";
    }
    if (
      [
        "unsupported_category",
        "category_version_mismatch",
        "unknown_operation",
        "unsupported_schema",
      ].includes(error.code)
    ) {
      return "updateRequired";
    }
  }
  return "unavailable";
}

function buildPreview(
  content: SandboxPreviewContent,
  url: string,
  name: string,
): AttachmentLightboxState {
  // The Activity header owns full Download; hide the native PDF toolbar's
  // competing Blob-save and external Drive actions.
  const resourceUrl =
    content.kind === "pdf" ? `${url}#toolbar=0&navpanes=0` : url;
  const resource = createAttachmentPreviewSignals(resourceUrl, {
    resolvedToken: {
      token: resourceUrl,
      expiresAt: "9999-12-31T00:00:00.000Z",
      publicUrl: null,
    },
  });
  const base = {
    ...resource,
    preview: resource,
    url: resourceUrl,
    filename: name,
  };
  if ("text" in content) {
    const text$ = computed(() => {
      return Promise.resolve(
        createTextPreviewContent(content.text, content.truncated),
      );
    });
    return content.kind === "markdown"
      ? {
          ...base,
          kind: "markdown",
          text$,
          markdownTree$: computed(() => {
            return Promise.resolve(
              parseMarkdownTree(content.text, { escapeHtml: true }),
            );
          }),
        }
      : { ...base, kind: content.kind, text$ };
  }
  return { ...base, kind: content.kind };
}

/** Activity owns resources; this graph never writes Chat's lightbox state. */
function createPreviewGraph() {
  const request$ = state<PreviewRequest | null>(null);
  const result$ = state<PreviewResult>({ status: "loading" });
  const mounted$ = state(false);
  const ownerGeneration$ = state(0);
  const fallback$ = state<HTMLElement | null>(null);
  const trigger$ = state<HTMLElement | null>(null);
  const objectUrl$ = state<string | null>(null);
  const reset$ = resetSignal();
  const imageCanvas = createZoomableImageCanvasSignals();
  const close$ = command(({ get, set }) => {
    set(reset$);
    set(request$, null);
    set(result$, { status: "loading" });
    const url = get(objectUrl$);
    set(objectUrl$, null);
    if (url) {
      URL.revokeObjectURL(url);
    }
    set(imageCanvas.reset$);
  });
  const installOwner$ = command(
    ({ get, set }, element: HTMLElement | null, signal: AbortSignal) => {
      signal.throwIfAborted();
      set(close$);
      const generation = get(ownerGeneration$) + 1;
      set(ownerGeneration$, generation);
      set(mounted$, true);
      set(fallback$, element);
      signal.addEventListener(
        "abort",
        () => {
          if (get(ownerGeneration$) === generation) {
            set(close$);
            set(mounted$, false);
            set(fallback$, null);
            set(trigger$, null);
          }
        },
        { once: true },
      );
    },
  );
  return {
    request$,
    result$,
    mounted$,
    fallback$,
    trigger$,
    objectUrl$,
    reset$,
    imageCanvas,
    close$,
    installOwner$,
  };
}

function createOpenCommand(graph: ReturnType<typeof createPreviewGraph>) {
  const { request$, result$, mounted$, trigger$, objectUrl$, reset$, close$ } =
    graph;
  return command(
    async (
      { get, set },
      request: PreviewRequest,
      trigger: HTMLElement | undefined,
      signal: AbortSignal,
    ) => {
      if (
        !get(mounted$) ||
        request.runId !== get(currentRunId$) ||
        request.sessionKey !== get(authenticatedSessionKey$)
      ) {
        return;
      }
      set(close$);
      set(request$, request);
      set(trigger$, trigger ?? null);
      const lifetime = set(reset$, signal);
      const peer: SandboxChannelPeer = createBrowserSandboxChannelPeer(
        request.runId,
        get(apiClient$),
        {
          categories: [sandboxFsCategory],
          onStateChange(phase) {
            // A preview never reconnects an open file against a new Guest session.
            if (phase === "reconnecting") {
              peer.close();
            }
          },
        },
      );
      const outcome = await settle(
        withCleanup(
          onRejection(
            readSandboxFilePreview(peer, request.path, request.name, lifetime),
            (error) => {
              lifetime.throwIfAborted();
              // Peer retirement is a source failure; only owner cancellation is quiet.
              if (
                error instanceof DOMException &&
                error.name === "AbortError"
              ) {
                throw new FilePreviewError("unavailable");
              }
            },
          ),
          () => {
            peer.close();
          },
        ),
        lifetime,
      );
      signal.throwIfAborted();
      lifetime.throwIfAborted();
      if (
        get(request$) !== request ||
        get(currentRunId$) !== request.runId ||
        get(authenticatedSessionKey$) !== request.sessionKey
      ) {
        return;
      }
      if (!outcome.ok) {
        set(result$, { status: "error", error: previewFailure(outcome.error) });
        return;
      }
      const content = outcome.value;
      if (content.empty) {
        set(result$, { status: "ready", preview: null, truncated: false });
        return;
      }
      const url = "blob" in content ? URL.createObjectURL(content.blob) : "";
      if (url) {
        set(objectUrl$, url);
      }
      const preview = buildPreview(content, url, request.name);
      set(result$, { status: "ready", preview, truncated: content.truncated });
    },
  );
}

export function createSandboxFilePreviewSignals() {
  const graph = createPreviewGraph();
  const {
    request$,
    result$,
    trigger$,
    fallback$,
    installOwner$,
    close$,
    imageCanvas,
  } = graph;
  const popup$ = state<HTMLDivElement | null>(null);
  const popupRef$ = onRef(
    command(({ get, set }, element: HTMLDivElement, signal: AbortSignal) => {
      set(popup$, element);
      signal.addEventListener(
        "abort",
        () => {
          if (get(popup$) === element) {
            set(popup$, null);
          }
        },
        { once: true },
      );
    }),
  );
  const initialFocus$ = command(({ get }) => {
    return get(popup$);
  });
  const finalFocus$ = command(({ get }) => {
    const trigger = get(trigger$);
    // Virtualization may retire the initiating row while its dialog is open.
    return trigger?.isConnected
      ? trigger
      : (get(fallback$)?.querySelector<HTMLElement>("button:not([disabled])") ??
          undefined);
  });
  return {
    request$: computed((get) => {
      return get(request$);
    }),
    result$: computed((get) => {
      return get(result$);
    }),
    installOwner$,
    open$: createOpenCommand(graph),
    close$,
    finalFocus$,
    popupRef$,
    initialFocus$,
    imageCanvas,
  };
}
