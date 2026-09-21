import { Zip, ZipDeflate, ZipPassThrough } from "fflate";

import { settle } from "../signals/utils.ts";
import { fetchResource } from "./resource-fetch.ts";

/**
 * Stream a hosted publication into a ZIP.
 *
 * Members arrive one chunk at a time and leave the same way, so neither the
 * sources nor the finished archive is ever held whole. Compressing everything
 * is what makes a browser-side archive expensive, and it buys almost nothing on
 * a publication of images and fonts, so only the members whose media type still
 * has redundancy to remove are deflated.
 */

export interface HostedPublicationMember {
  readonly path: string;
  readonly contentType: string;
}

/** Media types whose bytes are already compressed by their own container. */
const STORED_MEDIA_TYPE_PATTERN =
  /^(?:image\/(?:png|jpeg|gif|webp|avif|heic|heif)|video\/|audio\/|font\/woff2?|application\/(?:zip|gzip|x-7z-compressed|x-rar-compressed|pdf|font-woff2?))/u;

function deflates(contentType: string): boolean {
  return !STORED_MEDIA_TYPE_PATTERN.test(
    contentType.split(";")[0]?.trim().toLowerCase() ?? "",
  );
}

function zipEntryName(path: string): string {
  return path.replace(/^\/+/u, "");
}

/** A member that could not be read; the archive cannot stand without it. */
class ZipMemberError extends Error {}

/**
 * Read one member and push it through its ZIP entry. The response body is
 * consumed as a stream so a large member never materializes as one buffer.
 */
async function pushMember(
  args: {
    readonly member: HostedPublicationMember;
    readonly baseUrl: string;
    readonly entry: ZipDeflate | ZipPassThrough;
    readonly flush: () => Promise<void>;
  },
  signal: AbortSignal,
): Promise<void> {
  const response = await fetchResource(
    new URL(args.member.path, args.baseUrl),
    { cache: "reload", mode: "cors" },
    signal,
  );
  signal.throwIfAborted();
  if (!response.ok || !response.body) {
    throw new ZipMemberError(`Hosted member unavailable: ${args.member.path}`);
  }

  const reader = response.body.getReader();
  let closed = false;
  let pending = await reader.read();
  while (!pending.done) {
    const chunk = pending.value;
    pending = await reader.read();
    signal.throwIfAborted();
    args.entry.push(chunk, pending.done);
    closed ||= pending.done;
    await args.flush();
  }
  // An empty member still needs the terminating push that closes its entry.
  if (!closed) {
    args.entry.push(new Uint8Array(0), true);
    await args.flush();
  }
}

/**
 * Write every member of a publication as one ZIP, handing each produced chunk
 * to `write`. Returns false when a member could not be read, because an archive
 * missing members would misrepresent the publication.
 */
export async function writeHostedPublicationZip(
  args: {
    readonly members: readonly HostedPublicationMember[];
    readonly baseUrl: string;
    readonly write: (chunk: Uint8Array) => Promise<void> | void;
  },
  signal: AbortSignal,
): Promise<boolean> {
  const produced: Uint8Array[] = [];
  let streamError: Error | null = null;
  const zip = new Zip((error, chunk) => {
    if (error) {
      streamError ??= error;
      return;
    }
    produced.push(chunk);
  });

  const flush = async (): Promise<void> => {
    if (streamError) {
      throw streamError;
    }
    // Splice rather than iterate: the ZIP keeps appending while we await.
    for (const chunk of produced.splice(0, produced.length)) {
      await args.write(chunk);
    }
  };

  const written = await settle(
    (async () => {
      for (const member of args.members) {
        const entry = deflates(member.contentType)
          ? new ZipDeflate(zipEntryName(member.path))
          : new ZipPassThrough(zipEntryName(member.path));
        zip.add(entry);
        await pushMember(
          { member, baseUrl: args.baseUrl, entry, flush },
          signal,
        );
      }
      zip.end();
      await flush();
    })(),
    signal,
  );

  if (written.ok) {
    return true;
  }
  zip.terminate();
  if (written.error instanceof ZipMemberError) {
    return false;
  }
  throw written.error;
}
