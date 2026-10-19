import { fetchResource } from "../lib/resource-fetch.ts";
import { computed, type Computed } from "ccstate";
import { createAttachmentResourceUrl$ } from "./attachment-resource-url.ts";
import {
  createJsonPreviewSignals,
  type JsonPreviewSignals,
} from "./json-preview.ts";
import { withCleanup } from "./utils.ts";

export type TextPreviewKind = "markdown" | "text" | "json" | "csv";
export interface TextPreviewContent {
  readonly text: string;
  readonly truncated: boolean;
  readonly json: JsonPreviewSignals;
}
export type TextPreviewComputed = Computed<Promise<TextPreviewContent>>;

const TEXT_PREVIEW_MAX_BYTES = 65_536;

export function isTextPreviewKind(kind: string): kind is TextPreviewKind {
  return (
    kind === "markdown" || kind === "text" || kind === "json" || kind === "csv"
  );
}

/** Created at the memoized load boundary, never in a React render. */
export function createTextPreviewContent(
  text: string,
  truncated: boolean,
): TextPreviewContent {
  return {
    text,
    truncated,
    json: createJsonPreviewSignals({ text, truncated }),
  };
}

function completeResponse(
  response: Response,
  received: number,
  reachedLimit: boolean,
): boolean {
  const encoding = response.headers.get("content-encoding");
  const compressed = encoding !== null && encoding !== "identity";
  if (response.status === 206) {
    const range = /^bytes 0-(\d+)\/(\d+)$/.exec(
      response.headers.get("content-range") ?? "",
    );
    const end = range?.[1];
    const total = range?.[2];
    return (
      !compressed &&
      end !== undefined &&
      total !== undefined &&
      BigInt(end) + 1n === BigInt(received) &&
      BigInt(total) === BigInt(received)
    );
  }
  const length = response.headers.get("content-length");
  if (!compressed && length !== null && /^\d+$/.test(length)) {
    return BigInt(length) === BigInt(received);
  }
  return !reachedLimit;
}

function readLimitedText(response: Response): Promise<TextPreviewContent> {
  const reader = response.body?.getReader();
  if (!reader) {
    return Promise.resolve(
      createTextPreviewContent("", response.status === 206),
    );
  }
  return withCleanup(
    (async () => {
      const chunks: Uint8Array[] = [];
      let received = 0;
      let reachedLimit = false;
      let overflow = false;

      while (received < TEXT_PREVIEW_MAX_BYTES) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }

        const remaining = TEXT_PREVIEW_MAX_BYTES - received;
        overflow = value.byteLength > remaining;
        const chunk =
          value.byteLength > remaining ? value.slice(0, remaining) : value;
        chunks.push(chunk);
        received += chunk.byteLength;
        if (received >= TEXT_PREVIEW_MAX_BYTES) {
          reachedLimit = true;
          break;
        }
      }

      if (reachedLimit) {
        await reader.cancel();
      }

      const bytes = new Uint8Array(received);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
      }
      const truncated =
        overflow || !completeResponse(response, received, reachedLimit);
      return createTextPreviewContent(
        new TextDecoder("utf-8", { fatal: true }).decode(bytes, {
          stream: truncated,
        }),
        truncated,
      );
    })(),
    () => {
      return reader.releaseLock();
    },
  );
}

export async function fetchPreviewText(
  url: string,
): Promise<TextPreviewContent> {
  const response = await fetchResource(url, {
    headers: { Range: `bytes=0-${String(TEXT_PREVIEW_MAX_BYTES - 1)}` },
  });
  if (!response.ok) {
    throw new Error(`HTTP ${String(response.status)}`);
  }
  return readLimitedText(response);
}

export function createTextPreviewComputed(
  url: string,
  resourceUrl$?: Computed<Promise<string | null>>,
): TextPreviewComputed {
  const resolvedUrl$ = resourceUrl$ ?? createAttachmentResourceUrl$(url);
  return computed(async (get) => {
    // The canonical attachment URL needs an Authorization header this fetch
    // does not carry, so read the presigned object URL instead.
    const resourceUrl = await get(resolvedUrl$);
    if (!resourceUrl) {
      throw new Error("Attachment preview is unavailable");
    }
    return fetchPreviewText(resourceUrl);
  });
}

export function createTextPreviewComputedFromBlob(
  blob: Blob,
): TextPreviewComputed {
  return computed(async (_get) => {
    return createTextPreviewContent(
      await blob.slice(0, TEXT_PREVIEW_MAX_BYTES).text(),
      blob.size > TEXT_PREVIEW_MAX_BYTES,
    );
  });
}
