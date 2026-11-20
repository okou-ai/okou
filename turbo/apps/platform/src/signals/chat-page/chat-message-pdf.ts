import { chatThreadPdfFilenameContract } from "@okouai/api-contracts/client/chat-thread-pdf-filename";
import { command } from "ccstate";
import type { Root } from "hast";
import { visit } from "unist-util-visit";

import { artifactDownloadType } from "../../lib/artifact-download-type.ts";
import { accept } from "../../lib/accept.ts";
import { generateMessagePdfBlob } from "../../lib/message-pdf/index.ts";
import { apiClient$ } from "../api-client.ts";
import { createObjectUrlResource } from "../object-url-resource.ts";
import { attachmentDownloadSource$ } from "../attachment-download-source.ts";
import { eventBodyPlan } from "./parse-body-blocks.ts";
import { onRef } from "../utils.ts";

/** Pass the committed DOM owner's lifetime directly to the click action. */
export class GenerateMessagePdfEvent extends Event {
  constructor(readonly generate: (signal: AbortSignal) => void) {
    super("okou:generate-message-pdf", { bubbles: true });
  }
}

export const messagePdfActionRef$ = onRef(
  command((_context, element: HTMLSpanElement, signal: AbortSignal) => {
    element.addEventListener(
      "okou:generate-message-pdf",
      (event) => {
        if (event instanceof GenerateMessagePdfEvent) {
          event.generate(signal);
        }
      },
      { signal },
    );
  }),
);

interface MessagePdfInput {
  readonly threadId: string;
  readonly eventIds: readonly string[];
  readonly contents: readonly string[];
  readonly trees: readonly Root[];
  readonly trigger: HTMLElement;
}

interface MessagePdfDownload {
  readonly filename: string;
  readonly ref: (element: HTMLAnchorElement | null) => (() => void) | undefined;
}

const requestPdfFilename$ = command(
  async (
    { get },
    threadId: string,
    eventIds: readonly string[],
    signal: AbortSignal,
  ): Promise<string> => {
    const [name] = await Promise.allSettled([
      accept(
        get(apiClient$)(chatThreadPdfFilenameContract).generate({
          params: { threadId: threadId },
          body: { eventIds: [...eventIds] },
          fetchOptions: { signal: signal },
        }),
        [200],
        signal,
        { showErrorToast: false },
      ),
    ]);
    signal.throwIfAborted();
    return name.status === "fulfilled" && name.value.body
      ? `${name.value.body}.pdf`
      : "okou-message.pdf";
  },
);

const generatePdfContent$ = command(
  async (
    { set },
    input: Pick<MessagePdfInput, "contents" | "trees">,
    signal: AbortSignal,
  ): Promise<Blob> => {
    const imageSources = new Set<string>();
    for (const tree of input.trees) {
      visit(tree, "element", (node) => {
        if (node.tagName === "img" && typeof node.properties.src === "string") {
          imageSources.add(node.properties.src);
        }
      });
    }
    const imageUrls = new Map<string, string>();
    const fileCards = new Map<string, string>();
    for (const source of imageSources) {
      // Resolve under this click's access and cancellation, not a preview's
      // cached presigned URL, which may already have expired.
      const resource = await set(
        attachmentDownloadSource$,
        source,
        "app",
        signal,
      );
      if (resource.artifact) {
        const kind = artifactDownloadType(resource.artifact);
        if (kind !== "image" && kind !== "other") {
          fileCards.set(source, resource.artifact.filename);
          continue;
        }
      }
      imageUrls.set(source, resource.resourceUrl);
    }
    const sources = input.contents.map((content) => {
      return eventBodyPlan(content).treeSource;
    });
    return await generateMessagePdfBlob(
      sources,
      { imageUrls, fileCards },
      signal,
    );
  },
);

/** Generate bytes only; the user downloads them with a second, native click. */
export const generateMessagePdf$ = command(
  async (
    { set },
    input: MessagePdfInput,
    signal: AbortSignal,
  ): Promise<MessagePdfDownload> => {
    signal.throwIfAborted();
    const filename = set(
      requestPdfFilename$,
      input.threadId,
      input.eventIds,
      signal,
    );
    const fileContent = set(generatePdfContent$, input, signal);
    const [name, blob] = await Promise.all([filename, fileContent]);
    signal.throwIfAborted();
    const transferFocus = document.activeElement === input.trigger;
    return {
      filename: name,
      // Acquire the URL only when the download link commits. Each attachment
      // gets its own resource, including a React Strict Mode reattachment.
      ref: (element) => {
        if (!element || signal.aborted) {
          return;
        }
        const resource = createObjectUrlResource(blob, signal);
        element.href = resource.url;
        if (
          transferFocus &&
          (document.activeElement === input.trigger ||
            document.activeElement === document.body)
        ) {
          element.focus();
        }
        return resource.release;
      },
    };
  },
);
