import { fetchResource } from "../../lib/resource-fetch.ts";
import {
  command,
  computed,
  state,
  type Command,
  type Computed,
  type State,
} from "ccstate";
import { delay } from "signal-timers";
import {
  onRejection,
  resetSignal,
  setLoop,
  settle,
  tapError,
} from "../utils.ts";
import {
  createImageLoadSignals,
  type ImageLoadSignals,
} from "../image-load.ts";
import { apiClient$ } from "../api-client.ts";
import { accept } from "../../lib/accept.ts";
import { IN_VITEST } from "../../env.ts";
import type {
  GenerationTemplateRequest,
  PersistedAttachment,
  UserMessageDocument,
  ImageAnnotation,
} from "@okouai/api-contracts/contracts/chat-threads";
import { uploadsContract } from "@okouai/api-contracts/contracts/uploads";
import { webFilesContract } from "@okouai/api-contracts/contracts/web-files";
import { toast } from "@okouai/ui/components/ui/sonner";
import type { EditorDocumentSnapshot } from "./user-message-document-codec.ts";
import { i18n } from "../../i18n/index.ts";
import { flattenAnnotatedImage } from "./flatten-annotated-image.ts";
import { logger } from "../log.ts";
import {
  createAttachmentPreviewSignals,
  type AttachmentPreviewSignals,
} from "../attachment-resource-url.ts";
import { canonicalUserMessageFileUrl } from "../chat-page/user-message-files.ts";
import { isAnnotationMeaningful } from "./image-annotation.ts";

// ---------------------------------------------------------------------------
// Attachment types
// ---------------------------------------------------------------------------

interface FileInfo {
  id: string;
  url: string;
  contentType: string;
}

function uploadFileInfo(
  file: Pick<FileInfo, "id" | "url">,
  contentType: string,
): FileInfo {
  return { id: file.id, url: file.url, contentType };
}

type AttachmentUploadState =
  | {
      readonly status: "pending";
      readonly promise: Promise<FileInfo> | null;
    }
  | {
      readonly status: "uploaded";
      readonly fileInfo: FileInfo;
    };

const log = logger("chat-draft");

const MULTIPART_UPLOAD_THRESHOLD_BYTES = 5 * 1024 * 1024;
const MAX_PART_UPLOAD_ATTEMPTS = 5;
const PART_UPLOAD_RETRY_BASE_DELAY_MS = 250;
const MULTIPART_ABORT_TIMEOUT_MS = 5000;
interface MultipartUploadReference {
  id: string;
  filename: string;
  uploadId: string;
}

const abortMultipartUpload$ = command(
  async (
    { get },
    upload: MultipartUploadReference,
    signal: AbortSignal,
  ): Promise<void> => {
    const client = get(apiClient$)(uploadsContract);
    await tapError(
      accept(
        client.abortMultipart({
          body: upload,
          fetchOptions: {
            keepalive: true,
            signal,
          },
        }),
        [200],
        signal,
        { showErrorToast: false },
      ),
    );
  },
);

function uploadContentTypeByExtension(ext: string): string | undefined {
  const contentTypeByExtension: Record<string, string | undefined> = {
    aac: "audio/aac",
    "7z": "application/x-7z-compressed",
    ai: "application/postscript",
    avif: "image/avif",
    bmp: "image/bmp",
    bz2: "application/x-bzip2",
    csv: "text/csv",
    db: "application/vnd.sqlite3",
    doc: "application/msword",
    docm: "application/vnd.ms-word.document.macroenabled.12",
    docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    dotm: "application/vnd.ms-word.template.macroenabled.12",
    dotx: "application/vnd.openxmlformats-officedocument.wordprocessingml.template",
    epub: "application/epub+zip",
    flac: "audio/flac",
    gif: "image/gif",
    gz: "application/gzip",
    har: "application/json",
    heic: "image/heic",
    heif: "image/heif",
    htm: "text/html",
    html: "text/html",
    jpeg: "image/jpeg",
    jpg: "image/jpeg",
    json: "application/json",
    key: "application/vnd.apple.keynote",
    m4a: "audio/mp4",
    md: "text/markdown",
    mov: "video/quicktime",
    mp3: "audio/mpeg",
    mp4: "video/mp4",
    mpga: "audio/mpga",
    odp: "application/vnd.oasis.opendocument.presentation",
    ods: "application/vnd.oasis.opendocument.spreadsheet",
    odt: "application/vnd.oasis.opendocument.text",
    oga: "audio/ogg",
    ogg: "audio/ogg",
    opus: "audio/opus",
    numbers: "application/vnd.apple.numbers",
    pages: "application/vnd.apple.pages",
    parquet: "application/vnd.apache.parquet",
    pdf: "application/pdf",
    png: "image/png",
    potm: "application/vnd.ms-powerpoint.template.macroenabled.12",
    potx: "application/vnd.openxmlformats-officedocument.presentationml.template",
    ppsm: "application/vnd.ms-powerpoint.slideshow.macroenabled.12",
    ppsx: "application/vnd.openxmlformats-officedocument.presentationml.slideshow",
    ppt: "application/vnd.ms-powerpoint",
    pptm: "application/vnd.ms-powerpoint.presentation.macroenabled.12",
    pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    psd: "image/vnd.adobe.photoshop",
    rar: "application/vnd.rar",
    rtf: "application/rtf",
    sqlite: "application/vnd.sqlite3",
    sqlite3: "application/vnd.sqlite3",
    svg: "image/svg+xml",
    tar: "application/x-tar",
    tgz: "application/gzip",
    tif: "image/tiff",
    tiff: "image/tiff",
    txt: "text/plain",
    tsv: "text/tab-separated-values",
    wav: "audio/wav",
    wave: "audio/wave",
    webm: "video/webm",
    webp: "image/webp",
    xls: "application/vnd.ms-excel",
    xlsb: "application/vnd.ms-excel.sheet.binary.macroenabled.12",
    xlsm: "application/vnd.ms-excel.sheet.macroenabled.12",
    xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    xltm: "application/vnd.ms-excel.template.macroenabled.12",
    xltx: "application/vnd.openxmlformats-officedocument.spreadsheetml.template",
    xml: "application/xml",
    xz: "application/x-xz",
    yaml: "application/yaml",
    yml: "application/yaml",
    zip: "application/zip",
  };
  return contentTypeByExtension[ext];
}

function inferUploadContentType(file: File): string {
  const explicitType = file.type.split(";")[0]?.trim().toLowerCase();
  if (explicitType && explicitType !== "application/octet-stream") {
    return explicitType;
  }
  const ext = file.name.split(".").pop()?.toLowerCase();
  return ext
    ? (uploadContentTypeByExtension(ext) ?? "application/octet-stream")
    : "application/octet-stream";
}

async function uploadPartWithRetry(
  uploadUrl: string,
  body: Blob,
  contentType: string,
  signal: AbortSignal,
): Promise<void> {
  let attempt = 0;
  await setLoop(
    async (loopSignal) => {
      attempt += 1;
      const result = await settle(
        fetchResource(
          uploadUrl,
          {
            method: "PUT",
            body,
            headers: { "content-type": contentType },
          },
          loopSignal,
        ),
        loopSignal,
      );
      if (result.ok) {
        if (result.value.ok) {
          return true;
        }
        if (attempt === MAX_PART_UPLOAD_ATTEMPTS) {
          throw new Error(
            `storage returned ${result.value.status} ${result.value.statusText}`,
          );
        }
      } else if (attempt === MAX_PART_UPLOAD_ATTEMPTS) {
        throw result.error;
      }
      await delay(
        IN_VITEST ? 0 : PART_UPLOAD_RETRY_BASE_DELAY_MS * 2 ** (attempt - 1),
        { signal: loopSignal },
      );
      return false;
    },
    0,
    signal,
    { retryTransientErrors: false },
  );
  signal.throwIfAborted();
}

/**
 * Presigns, transfers and finalizes one file, returning its canonical info.
 *
 * Extracted from the draft attachment closure so the send path can push a
 * flattened annotated copy through exactly the same route rather than growing
 * a second, subtly different uploader. The file body never travels through the
 * app runtime in either case.
 */
const uploadFileToStorage$ = command(
  async ({ get, set }, file: File, signal: AbortSignal): Promise<FileInfo> => {
    const createClient = get(apiClient$);
    const client = createClient(uploadsContract);
    const contentType = inferUploadContentType(file);

    // Step 1: ask the server to sign either one PUT URL or retryable R2
    // multipart URLs. The file body never travels through the app runtime.
    const prepared = await accept(
      client.prepare({
        body: {
          filename: file.name,
          contentType,
          size: file.size,
          ...(file.size >= MULTIPART_UPLOAD_THRESHOLD_BYTES
            ? { multipart: true as const }
            : {}),
        },
        fetchOptions: { signal },
      }),
      [200],
    );
    signal.throwIfAborted();

    if ("multipart" in prepared.body) {
      const multipart = prepared.body.multipart;
      let completionStarted = false;
      return await onRejection(
        (async () => {
          signal.throwIfAborted();
          for (const part of multipart.parts) {
            const start = (part.partNumber - 1) * multipart.partSize;
            const end = Math.min(start + multipart.partSize, file.size);
            await uploadPartWithRetry(
              part.uploadUrl,
              file.slice(start, end, prepared.body.contentType),
              prepared.body.contentType,
              signal,
            );
          }

          signal.throwIfAborted();
          completionStarted = true;
          const completed = await accept(
            client.completeMultipart({
              body: {
                id: prepared.body.id,
                filename: prepared.body.filename,
                uploadId: multipart.uploadId,
                partCount: multipart.parts.length,
              },
              fetchOptions: { signal },
            }),
            [200],
          );
          signal.throwIfAborted();
          return uploadFileInfo(completed.body, prepared.body.contentType);
        })(),
        async () => {
          // Aborting after completion starts can remove the upload while R2
          // is still finalizing it, so only clean up pre-completion failures.
          if (completionStarted) {
            return;
          }
          const cleanupSignal = AbortSignal.timeout(MULTIPART_ABORT_TIMEOUT_MS);
          await set(
            abortMultipartUpload$,
            {
              id: prepared.body.id,
              filename: prepared.body.filename,
              uploadId: multipart.uploadId,
            },
            cleanupSignal,
          );
        },
      );
    }

    signal.throwIfAborted();
    const putRes = await fetchResource(
      prepared.body.uploadUrl,
      {
        method: "PUT",
        body: file,
        headers: {
          "content-type": prepared.body.contentType,
          ...prepared.body.uploadHeaders,
        },
      },
      signal,
    );
    signal.throwIfAborted();

    if (!putRes.ok) {
      throw new Error(`storage returned ${putRes.status} ${putRes.statusText}`);
    }

    return uploadFileInfo(prepared.body, prepared.body.contentType);
  },
);

export type AttachmentAnnotationUploadStatus =
  | "idle"
  | "pending"
  | "uploaded"
  | "failed";

type AttachmentAnnotationUploadState =
  | { readonly status: "idle" }
  | { readonly status: "pending" }
  | { readonly status: "uploaded"; readonly fileId: string }
  | { readonly status: "failed" };

function createAttachmentAnnotationSignals(args: {
  readonly filename: string;
  readonly fileInfo$: Computed<Promise<FileInfo | null>>;
  readonly initialAnnotations?: ImageAnnotation;
  readonly initialAnnotatedFileId?: string;
}) {
  const internalAnnotations$ = state<ImageAnnotation | null>(
    args.initialAnnotations ?? null,
  );
  // Marks without their annotated copy mean the copy is MISSING, not that
  // making it failed. Reporting `failed` here put a retry badge on a draft
  // nothing had been attempted for, and the user reads that as an error they
  // caused. `restoreAttachments$` regenerates the copy instead, so the state
  // that describes it is `pending`.
  const initialUploadState: AttachmentAnnotationUploadState =
    args.initialAnnotations && args.initialAnnotatedFileId
      ? { status: "uploaded", fileId: args.initialAnnotatedFileId }
      : args.initialAnnotations
        ? { status: "pending" }
        : { status: "idle" };
  const internalUploadState$ =
    state<AttachmentAnnotationUploadState>(initialUploadState);
  const resetUploadSignal$ = resetSignal();

  const annotations$ = computed((get) => {
    return get(internalAnnotations$);
  });
  const annotatedFileId$ = computed((get): string | null => {
    const upload = get(internalUploadState$);
    return upload.status === "uploaded" ? upload.fileId : null;
  });
  const annotationUploadStatus$ = computed(
    (get): AttachmentAnnotationUploadStatus => {
      return get(internalUploadState$).status;
    },
  );
  const annotationReady$ = computed((get): boolean => {
    return (
      !isAnnotationMeaningful(get(internalAnnotations$)) ||
      get(internalUploadState$).status === "uploaded"
    );
  });

  const confirmAnnotations$ = command(
    async (
      { get, set },
      annotations: ImageAnnotation | null,
      parentSignal: AbortSignal,
    ): Promise<void> => {
      const signal = set(resetUploadSignal$, parentSignal);
      set(internalAnnotations$, annotations);
      if (!annotations || !isAnnotationMeaningful(annotations)) {
        set(internalUploadState$, { status: "idle" });
        return;
      }

      set(internalUploadState$, { status: "pending" });
      const rendered = await settle(
        (async () => {
          const original = await get(args.fileInfo$);
          signal.throwIfAborted();
          if (!original) {
            throw new Error("Original image is unavailable");
          }
          // A presigned resource URL can render in an image element while its
          // response remains unreadable to fetch because of CORS. Flattening
          // needs the bytes. Private storage must allow authenticated app origins
          // through R2 CORS; public inputs retain their existing CDN URL.
          const preview = createAttachmentPreviewSignals(original.url);
          const [resourceUrl, shareUrl] = await Promise.all([
            get(preview.resourceUrl$),
            get(preview.shareUrl$),
          ]);
          signal.throwIfAborted();
          const flattened = await flattenAnnotatedImage(
            shareUrl ?? resourceUrl,
            annotations,
            args.filename,
            signal,
          );
          return await set(uploadFileToStorage$, flattened.file, signal);
        })(),
        signal,
      );
      if (!rendered.ok) {
        set(internalUploadState$, { status: "failed" });
        // Five different steps land on that one state — the original going
        // missing, the read, the decode, the encode and the upload. Dropping
        // `rendered.error` left the retry badge as the only evidence any of
        // them had happened, so a failure that reproduced every time was
        // indistinguishable from a flaky one. Warn rather than error: the
        // attachment keeps its marks and the badge retries in place, so this
        // is a recoverable condition the user is already being shown.
        log.warn("annotation flatten failed", args.filename, rendered.error);
        return;
      }
      set(internalUploadState$, {
        status: "uploaded",
        fileId: rendered.value.id,
      });
    },
  );

  const retryAnnotationUpload$ = command(
    async ({ get, set }, signal: AbortSignal): Promise<void> => {
      const annotations = get(internalAnnotations$);
      if (!annotations || !isAnnotationMeaningful(annotations)) {
        return;
      }
      await set(confirmAnnotations$, annotations, signal);
    },
  );

  const cancelAnnotationUpload$ = command(({ get, set }) => {
    set(resetUploadSignal$);
    if (get(internalUploadState$).status === "pending") {
      set(internalUploadState$, { status: "failed" });
    }
  });

  return {
    annotations$,
    annotatedFileId$,
    annotationUploadStatus$,
    annotationReady$,
    confirmAnnotations$,
    retryAnnotationUpload$,
    cancelAnnotationUpload$,
  };
}

export interface ChatAttachment {
  /** Stable identity for this attachment inside its owning composer. */
  key: string;
  filename: string;
  contentType: string;
  size: number;
  /** Load state of the chip's image thumbnail, for image attachments. */
  imageLoad: ImageLoadSignals;
  /** Reactive file info (id + url) — loading while uploading, hasData when done. */
  fileInfo$: Computed<Promise<FileInfo | null>>;
  preview$: Computed<Promise<AttachmentPreviewSignals | null>>;
  /** Whether either the original or its annotated derivative is uploading. */
  uploadPending$: Computed<boolean>;
  /** Whether every file required by a send has been uploaded successfully. */
  sendReady$: Computed<boolean>;
  /** Cancel the in-flight upload. Always safe to call (no-op if already completed). */
  cancel$: Command<void, []>;
  /** Start the upload and publish its fileInfo$ promise for later send-time resolution. */
  upload$: Command<Promise<void>, [AbortSignal]>;
  annotations$: Computed<ImageAnnotation | null>;
  annotatedFileId$: Computed<string | null>;
  annotationUploadStatus$: Computed<AttachmentAnnotationUploadStatus>;
  confirmAnnotations$: Command<
    Promise<void>,
    [ImageAnnotation | null, AbortSignal]
  >;
  retryAnnotationUpload$: Command<Promise<void>, [AbortSignal]>;
  cancelAnnotationUpload$: Command<void, []>;
}

function createComposerAttachmentPreview(
  fileInfo$: Computed<Promise<FileInfo | null>>,
) {
  return computed(async (get) => {
    const file = await get(fileInfo$);
    return file
      ? createAttachmentPreviewSignals(canonicalUserMessageFileUrl(file.id))
      : null;
  });
}

function createChatAttachment(file: File): ChatAttachment {
  const contentType = inferUploadContentType(file);
  const imageLoad = createImageLoadSignals();
  const resetSignal$ = resetSignal();
  const internalUpload$ = state<AttachmentUploadState>({
    status: "pending",
    promise: null,
  });

  const fileInfo$ = computed(async (get) => {
    const upload = get(internalUpload$);
    if (upload.status === "uploaded") {
      return upload.fileInfo;
    }
    if (upload.promise === null) {
      return null;
    }
    return await upload.promise;
  });
  const annotation = createAttachmentAnnotationSignals({
    filename: file.name,
    fileInfo$,
  });
  const uploadPending$ = computed((get): boolean => {
    return (
      get(internalUpload$).status === "pending" ||
      get(annotation.annotationUploadStatus$) === "pending"
    );
  });
  const sendReady$ = computed((get): boolean => {
    return (
      get(internalUpload$).status === "uploaded" &&
      get(annotation.annotationReady$)
    );
  });
  const cancel$ = command(({ set }) => {
    set(resetSignal$);
    set(annotation.cancelAnnotationUpload$);
  });

  const upload$ = command(async ({ set }, parentSignal: AbortSignal) => {
    const signal = set(resetSignal$, parentSignal);
    const promise = set(uploadFileToStorage$, file, signal);
    set(internalUpload$, { status: "pending", promise });
    const fileInfo = await promise;
    signal.throwIfAborted();
    set(internalUpload$, { status: "uploaded", fileInfo });
  });

  return {
    key: crypto.randomUUID(),
    filename: file.name,
    contentType,
    size: file.size,
    imageLoad,
    fileInfo$,
    preview$: createComposerAttachmentPreview(fileInfo$),
    uploadPending$,
    sendReady$,
    cancel$,
    upload$,
    ...annotation,
  };
}

// ---------------------------------------------------------------------------
// DraftSignals — encapsulates per-thread composer state
// ---------------------------------------------------------------------------

export interface DraftSignals {
  hasLocalInput$: Computed<boolean>;
  input$: Computed<string>;
  hasInput$: Computed<boolean>;
  readInput$: Command<string, []>;
  setInput$: Command<void, [string]>;
  appendInput$: Command<void, [string]>;
  setInputSyncTarget$: Command<void, [DraftInputSyncTarget | null]>;
  takeRestoredUserMessage$: Command<UserMessageDocument | null, []>;
  readEditorDocument$: Command<EditorDocumentSnapshot | null, []>;
  setEditorDocument$: Command<void, [EditorDocumentSnapshot | null]>;
  generationTemplate$: Computed<GenerationTemplateRequest | undefined>;
  setGenerationTemplate$: Command<
    void,
    [GenerationTemplateRequest | undefined]
  >;
  attachments$: Computed<ChatAttachment[]>;
  attachmentUploadsReady$: Computed<boolean>;
  uploadAttachment$: Command<Promise<void>, [File, AbortSignal]>;
  /**
   * Adds persisted attachments to the draft and drops the ones whose artifact
   * no longer resolves for this account.
   */
  restoreAttachments$: Command<
    Promise<boolean>,
    [RestorableAttachment[], AbortSignal]
  >;
  removeAttachment$: Command<void, [ChatAttachment]>;
  dragOver$: Computed<boolean>;
  setDragOver$: Command<void, [boolean]>;
  /** Reset all draft state (input, template, attachments). Called after send. */
  clear$: Command<void, []>;
  /**
   * Seed draft from persisted server data. Only called when local cache was
   * empty. The draft is visible immediately; the returned promise settles once
   * unresolvable attachments have been dropped.
   */
  seed$: Command<Promise<boolean>, [DraftSeed, AbortSignal]>;
}

interface DraftSeed {
  content: string;
  userMessage: UserMessageDocument | null;
  generationTemplate: GenerationTemplateRequest | undefined;
  attachments: ChatAttachment[];
}

export interface DraftInputSyncTarget {
  syncInput(value: string): void;
  syncUserMessage(value: UserMessageDocument | null): void;
}

/**
 * Attachment metadata a caller can restore into a draft.
 *
 * `url` is optional because a caller can legitimately hold only an artifact id:
 * the desktop recording handoff arrives as upload ids in a URL and has no
 * stored URL to pass. `fileInfo$` signs one against the owning API in that
 * case. A caller that does carry the persisted URL keeps it, so re-saving the
 * draft persists the canonical artifact URL instead of a short-lived signed one.
 */
export type RestorableAttachment = Omit<PersistedAttachment, "url"> & {
  readonly url?: string;
  readonly annotatedFileId?: string;
  readonly annotations?: ImageAnnotation;
};

/**
 * Reconstructs a ChatAttachment from persisted attachment metadata.
 *
 * The persisted id is an externally managed reference: the artifact is stored
 * per user, so a saved draft, a forwarded message, or a pasted chat payload can
 * carry an id the current account cannot read. `fileInfo$` resolves it once
 * against the current account and reports `null` when it no longer resolves,
 * instead of asserting the file is still reachable.
 *
 */
export function createRestoredAttachment(
  persisted: RestorableAttachment,
): ChatAttachment {
  const restored$ = computed(async (get) => {
    const client = get(apiClient$)(webFilesContract);
    const resolved = await accept(
      client.fileUrl({
        query: { file_id: persisted.id },
      }),
      [200, 404],
    );
    return resolved.status === 404
      ? null
      : {
          fileInfo: {
            id: persisted.id,
            url: persisted.url ?? resolved.body.url,
            contentType: persisted.contentType,
          },
          preview: createAttachmentPreviewSignals(
            canonicalUserMessageFileUrl(persisted.id),
            {
              token: resolved.body.url,
              expiresAt: resolved.body.expiresAt,
              publicUrl: resolved.body.publicUrl,
            },
          ),
        };
  });
  const fileInfo$ = computed(async (get): Promise<FileInfo | null> => {
    return (await get(restored$))?.fileInfo ?? null;
  });
  const annotation = createAttachmentAnnotationSignals({
    filename: persisted.filename,
    fileInfo$,
    ...(persisted.annotations
      ? { initialAnnotations: persisted.annotations }
      : {}),
    ...(persisted.annotatedFileId
      ? { initialAnnotatedFileId: persisted.annotatedFileId }
      : {}),
  });

  const cancel$ = command(({ set }) => {
    set(annotation.cancelAnnotationUpload$);
  });
  // upload$ accepts a signal parameter to match the ChatAttachment interface.
  // The file is already uploaded, so this is a no-op.
  const upload$ = command((_visitor, _signal: AbortSignal): Promise<void> => {
    return Promise.resolve();
  });
  const uploadPending$ = computed((get): boolean => {
    return get(annotation.annotationUploadStatus$) === "pending";
  });

  return {
    key: crypto.randomUUID(),
    filename: persisted.filename,
    contentType: persisted.contentType,
    size: persisted.size,
    imageLoad: createImageLoadSignals(),
    fileInfo$,
    preview$: computed(async (get) => {
      return (await get(restored$))?.preview ?? null;
    }),
    uploadPending$,
    sendReady$: annotation.annotationReady$,
    cancel$,
    upload$,
    ...annotation,
  };
}

/** Fixed id so repeated restores replace the toast instead of stacking. */
const UNAVAILABLE_ATTACHMENT_TOAST_ID = "chat-attachment-unavailable";

/**
 * Tells the user which attachments no longer resolve and returns the message so
 * a caller can reuse it to abort. Re-uploading is the only fix, so the copy
 * says that rather than offering a retry.
 */
function reportUnavailableAttachments(filenames: readonly string[]): string {
  const message =
    filenames.length === 1
      ? i18n.t(
          ($) => {
            return $.chat.attachments.unavailable;
          },
          { filename: filenames[0] },
        )
      : i18n.t(
          ($) => {
            return $.chat.attachments.unavailableCount;
          },
          { count: filenames.length },
        );
  toast.warning(message, { id: UNAVAILABLE_ATTACHMENT_TOAST_ID });
  return message;
}

function createDraftInputSignals() {
  const internalInput$ = state<string | undefined>(undefined);
  const hasLocalInput$ = computed((get) => {
    return get(internalInput$) !== undefined;
  });
  const internalInputSyncTarget$ = state<DraftInputSyncTarget | null>(null);
  const input$ = computed((get) => {
    return get(internalInput$) ?? "";
  });
  const hasInput$ = computed((get) => {
    return (get(internalInput$) ?? "").trim().length > 0;
  });
  const readInput$ = command(({ get }) => {
    return get(internalInput$) ?? "";
  });
  const syncInput$ = command(({ get }, value: string) => {
    get(internalInputSyncTarget$)?.syncInput(value);
  });
  const syncUserMessage$ = command(
    ({ get }, value: UserMessageDocument | null) => {
      const target = get(internalInputSyncTarget$);
      if (!target) {
        return false;
      }
      target.syncUserMessage(value);
      return true;
    },
  );
  const setInputSyncTarget$ = command(
    ({ set }, target: DraftInputSyncTarget | null) => {
      set(internalInputSyncTarget$, target);
    },
  );
  const setInput$ = command(({ set }, value: string) => {
    set(syncInput$, value);
    set(internalInput$, value);
  });
  const appendInput$ = command(({ get, set }, value: string) => {
    const text = value.trim();
    if (!text) {
      return;
    }
    const base = get(internalInput$) ?? "";
    const separator = base.length > 0 && !base.endsWith(" ") ? " " : "";
    set(setInput$, `${base}${separator}${text}`);
  });
  return {
    hasLocalInput$,
    input$,
    hasInput$,
    readInput$,
    setInput$,
    appendInput$,
    setInputSyncTarget$,
    syncUserMessage$,
  };
}

function createDraftDocumentSignals() {
  let restoredUserMessage: UserMessageDocument | null = null;
  let editorDocument: EditorDocumentSnapshot | null = null;
  const setRestoredUserMessage$ = command(
    (_context, value: UserMessageDocument | null) => {
      restoredUserMessage = value;
    },
  );
  const takeRestoredUserMessage$ = command(() => {
    const value = restoredUserMessage;
    restoredUserMessage = null;
    return value;
  });
  const readEditorDocument$ = command(() => {
    return editorDocument;
  });
  const setEditorDocument$ = command(
    (_context, value: EditorDocumentSnapshot | null) => {
      editorDocument = value;
    },
  );
  return {
    setRestoredUserMessage$,
    takeRestoredUserMessage$,
    readEditorDocument$,
    setEditorDocument$,
  };
}

/**
 * Makes restored attachments usable, in two passes.
 *
 * Drops the ones whose artifact no longer resolves for this account. Leaving
 * them in place strands the composer: the chip waits on a file it can never
 * load and every send is rejected, so removing them and saying so is the only
 * state the user can act on.
 *
 * Then rebuilds any annotated copy the draft is missing. Both restore paths —
 * `seed$` on page load and `restoreAttachments$` on paste — end here, and an
 * attachment that reaches either one without the rebuild is stuck: marks with
 * no copy start as `pending`, so nothing would move that state and the
 * composer would refuse to send with no affordance to fix it.
 */
function createReconcileRestoredAttachments(
  internalAttachments$: State<ChatAttachment[]>,
): Command<Promise<boolean>, [readonly ChatAttachment[], AbortSignal]> {
  return command(
    async (
      { get, set },
      candidates: readonly ChatAttachment[],
      signal: AbortSignal,
    ): Promise<boolean> => {
      if (candidates.length === 0) {
        return false;
      }
      const infos = await Promise.all(
        candidates.map((attachment) => {
          return get(attachment.fileInfo$);
        }),
      );
      signal.throwIfAborted();
      const currentAttachments = get(internalAttachments$);
      const unavailable = candidates.filter((attachment, index) => {
        return infos[index] === null && currentAttachments.includes(attachment);
      });
      if (unavailable.length > 0) {
        set(internalAttachments$, (prev) => {
          return prev.filter((attachment) => {
            return !unavailable.includes(attachment);
          });
        });
        reportUnavailableAttachments(
          unavailable.map((attachment) => {
            return attachment.filename;
          }),
        );
      }

      // The annotated copy is what the model reads, so a restored draft only
      // still means what the user drew once it exists. Awaited rather than
      // left running: both callers use the result solely to decide whether to
      // re-save, and that save should land after the copy exists rather than
      // persisting the same marks-without-copy shape again.
      await Promise.all(
        candidates
          .filter((attachment) => {
            return (
              !unavailable.includes(attachment) &&
              get(attachment.annotatedFileId$) === null
            );
          })
          .map((attachment) => {
            return set(attachment.retryAnnotationUpload$, signal);
          }),
      );
      signal.throwIfAborted();
      return unavailable.length > 0;
    },
  );
}

function createDraftLifecycleSignals({
  draftInput,
  draftDocument,
  internalGenerationTemplate$,
  internalAttachments$,
  internalDragOver$,
  reconcileRestoredAttachments$,
}: {
  draftInput: ReturnType<typeof createDraftInputSignals>;
  draftDocument: ReturnType<typeof createDraftDocumentSignals>;
  internalGenerationTemplate$: State<GenerationTemplateRequest | undefined>;
  internalAttachments$: State<ChatAttachment[]>;
  internalDragOver$: State<boolean>;
  reconcileRestoredAttachments$: Command<
    Promise<boolean>,
    [readonly ChatAttachment[], AbortSignal]
  >;
}) {
  const clear$ = command(({ get, set }) => {
    set(draftInput.setInput$, "");
    set(draftDocument.setRestoredUserMessage$, null);
    set(draftDocument.setEditorDocument$, null);
    set(internalGenerationTemplate$, undefined);
    const attachments = get(internalAttachments$);
    for (const attachment of attachments) {
      set(attachment.cancel$);
    }
    if (attachments.length > 0) {
      set(internalAttachments$, []);
    }
    set(internalDragOver$, false);
  });

  const seed$ = command(
    async (
      { set },
      value: DraftSeed,
      signal: AbortSignal,
    ): Promise<boolean> => {
      set(draftDocument.setEditorDocument$, null);
      set(draftDocument.setRestoredUserMessage$, value.userMessage);
      set(internalGenerationTemplate$, value.generationTemplate);
      set(internalAttachments$, value.attachments);
      set(draftInput.setInput$, value.content);
      if (
        value.userMessage &&
        set(draftInput.syncUserMessage$, value.userMessage)
      ) {
        set(draftDocument.takeRestoredUserMessage$);
      }
      return await set(
        reconcileRestoredAttachments$,
        value.attachments,
        signal,
      );
    },
  );

  return { clear$, seed$ };
}

export function createDraftSignals(): DraftSignals {
  const draftInput = createDraftInputSignals();
  const draftDocument = createDraftDocumentSignals();
  const internalGenerationTemplate$ = state<
    GenerationTemplateRequest | undefined
  >(undefined);
  const internalAttachments$ = state<ChatAttachment[]>([]);
  const internalDragOver$ = state(false);

  const generationTemplate$ = computed((get) => {
    return get(internalGenerationTemplate$);
  });
  const setGenerationTemplate$ = command(
    ({ set }, value: GenerationTemplateRequest | undefined) => {
      set(internalGenerationTemplate$, value);
    },
  );

  const attachments$ = computed((get) => {
    return get(internalAttachments$);
  });

  const attachmentUploadsReady$ = computed((get): boolean => {
    return get(internalAttachments$).every((attachment) => {
      return get(attachment.sendReady$);
    });
  });

  const uploadAttachment$ = command(
    async ({ set }, file: File, signal: AbortSignal) => {
      const attachment = createChatAttachment(file);
      const upload = set(attachment.upload$, signal);
      set(internalAttachments$, (prev) => {
        return [...prev, attachment];
      });

      await tapError(upload, () => {
        set(internalAttachments$, (prev) => {
          return prev.filter((a) => {
            return a !== attachment;
          });
        });
        toast.error(
          i18n.t(
            ($) => {
              return $.chat.attachments.uploadFailed;
            },
            { filename: file.name },
          ),
        );
      });
    },
  );

  const reconcileRestoredAttachments$ =
    createReconcileRestoredAttachments(internalAttachments$);

  const restoreAttachments$ = command(
    async (
      { set },
      persisted: RestorableAttachment[],
      signal: AbortSignal,
    ): Promise<boolean> => {
      if (persisted.length === 0) {
        return false;
      }
      const restored = persisted.map(createRestoredAttachment);
      set(internalAttachments$, (prev) => {
        return [...prev, ...restored];
      });
      return await set(reconcileRestoredAttachments$, restored, signal);
    },
  );

  const removeAttachment$ = command(({ set }, attachment: ChatAttachment) => {
    set(attachment.cancel$);
    set(internalAttachments$, (prev) => {
      return prev.filter((a) => {
        return a !== attachment;
      });
    });
  });

  const dragOver$ = computed((get) => {
    return get(internalDragOver$);
  });
  const setDragOver$ = command(({ set }, value: boolean) => {
    set(internalDragOver$, value);
  });

  const { clear$, seed$ } = createDraftLifecycleSignals({
    draftInput,
    draftDocument,
    internalGenerationTemplate$,
    internalAttachments$,
    internalDragOver$,
    reconcileRestoredAttachments$,
  });

  return {
    ...draftInput,
    takeRestoredUserMessage$: draftDocument.takeRestoredUserMessage$,
    readEditorDocument$: draftDocument.readEditorDocument$,
    setEditorDocument$: draftDocument.setEditorDocument$,
    generationTemplate$,
    setGenerationTemplate$,
    attachments$,
    attachmentUploadsReady$,
    uploadAttachment$,
    restoreAttachments$,
    removeAttachment$,
    dragOver$,
    setDragOver$,
    clear$,
    seed$,
  };
}

// ---------------------------------------------------------------------------
// Draft storage — talk-page singleton
// ---------------------------------------------------------------------------

const internalTalkDraft$ = state(createDraftSignals());

export const talkDraft$ = computed((get) => {
  return get(internalTalkDraft$);
});

export const setTalkDraft$ = command(({ set }, draft: DraftSignals) => {
  set(internalTalkDraft$, draft);
});
