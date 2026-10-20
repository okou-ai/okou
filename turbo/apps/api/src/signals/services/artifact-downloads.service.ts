import { command } from "ccstate";
import type { ArtifactDownloadResponse } from "@okouai/api-contracts/contracts/artifact-downloads";
import { parseArtifactReference } from "@okouai/api-contracts/contracts/artifact-references";
import { sharedThreadHostedSnapshotFile } from "../../lib/shared-thread-artifact";
import { s3ObjectHead } from "../external/s3";
import { resolveArtifactDownloadUrl$ } from "./artifact-download-url.service";
import {
  artifactReferenceRecord$,
  type SharedThreadArtifactReference,
} from "./artifact-reference.service";
import { privateArtifactRecord$ } from "./private-artifact-storage.service";
import { resolveArtifactShareDownload$ } from "./artifact-shares.service";
import { getHostedSiteFiles$ } from "./host.service";
import {
  resolveSharedThreadArtifactReference$,
  sharedThreadArtifactTarget$,
} from "./shared-thread-artifact-reference.service";
import { signSharedThreadHostedDownload$ } from "./shared-thread-artifacts.service";
import { checkHostedSiteAccess$ } from "./hosted-site-access.service";

const resolveSharedThreadArtifactDownload$ = command(
  async (
    { set },
    args: {
      readonly reference: SharedThreadArtifactReference;
      readonly expectedKind?: "html";
      readonly viewerId: string;
    },
    signal: AbortSignal,
  ): Promise<ArtifactDownloadResponse | null> => {
    const { reference } = args;
    if (reference.target.kind === "file") {
      if (args.expectedKind) {
        return null;
      }
      const file = await set(
        resolveSharedThreadArtifactReference$,
        reference,
        signal,
      );
      return file
        ? {
            kind: "file",
            url: file.downloadUrl,
            filename: file.filename,
            contentType: file.contentType,
          }
        : null;
    }
    const target = await set(sharedThreadArtifactTarget$, reference, signal);
    signal.throwIfAborted();
    if (target?.kind !== "html") {
      return null;
    }
    if (
      !(
        await set(
          checkHostedSiteAccess$,
          { siteId: target.siteId, userId: args.viewerId },
          signal,
        )
      ).allowed
    ) {
      return null;
    }
    const file = sharedThreadHostedSnapshotFile(target, reference.previewPath);
    if (!file) {
      return null;
    }
    const mediaType = file.contentType.split(";")[0]?.trim().toLowerCase();
    if (mediaType !== "text/html" && args.expectedKind) {
      return null;
    }
    const site = await set(
      signSharedThreadHostedDownload$,
      {
        publicSlug: reference.publicToken,
        layoutSegment: reference.publicBrand,
        target,
        viewerId: args.viewerId,
        attachment: mediaType !== "text/html",
      },
      signal,
    );
    if (mediaType !== "text/html") {
      const url = site.files.find((entry) => {
        return entry.path === file.path;
      })?.downloadUrl;
      if (!url) {
        return null;
      }
      return {
        kind: "file",
        url,
        filename: file.path.slice(file.path.lastIndexOf("/") + 1),
        contentType: file.contentType,
      };
    }
    return { kind: "html", site };
  },
);

/** References identify one resource; all byte access is authorized afresh. */
export const resolveArtifactDownload$ = command(
  async (
    { get, set },
    args: {
      readonly reference: string;
      readonly userId: string;
      readonly orgId?: string;
      readonly expectedKind?: "html";
    },
    signal: AbortSignal,
  ): Promise<ArtifactDownloadResponse | null> => {
    const parsed = parseArtifactReference(`/artifacts/${args.reference}`);
    if (!parsed) {
      return null;
    }
    let id = parsed.id;
    let kind: "file" | "html" | undefined;
    if (id === null) {
      const record = await set(artifactReferenceRecord$, parsed.hash, signal);
      signal.throwIfAborted();
      if (!record) {
        return null;
      }
      if (record.version === 1) {
        return await set(
          resolveArtifactShareDownload$,
          {
            selector: { kind: "share", id: record.shareId },
            userId: args.userId,
            allowPrivateOwner: true,
            expectedKind: args.expectedKind,
          },
          signal,
        );
      }
      if (record.version === 3) {
        return await set(
          resolveSharedThreadArtifactDownload$,
          {
            reference: record,
            expectedKind: args.expectedKind,
            viewerId: args.userId,
          },
          signal,
        );
      }
      id = record.target.id;
      kind = record.target.kind;
    }
    if (args.expectedKind && kind === "file") {
      return null;
    }
    if (kind !== "html" && args.expectedKind !== "html") {
      const file = await set(privateArtifactRecord$, id, signal);
      signal.throwIfAborted();
      if (file) {
        if (file.userId !== args.userId || file.orgId !== args.orgId) {
          return await set(
            resolveArtifactShareDownload$,
            {
              selector: {
                kind: "target",
                target: { kind: "file", id },
                targetId: id,
              },
              userId: args.userId,
            },
            signal,
          );
        }
        // Match the viewer's support for older single-PUT upload clients.
        const object = await get(s3ObjectHead(file.bucket, file.key));
        signal.throwIfAborted();
        if (object.kind === "missing") {
          return null;
        }
        const url = await set(resolveArtifactDownloadUrl$, file, signal);
        signal.throwIfAborted();
        return {
          kind: "file",
          url,
          filename: file.filename,
          contentType: file.contentType,
        };
      }
    }
    if (kind === "file") {
      return null;
    }
    const hosted = await set(
      getHostedSiteFiles$,
      { userId: args.userId, orgId: args.orgId, publicSlug: `dpl-${id}` },
      signal,
    );
    if (hosted.status === "ok") {
      return { kind: "html", site: hosted.body };
    }
    if (hosted.status === "config_error") {
      throw new Error(hosted.message);
    }
    if (kind === "html") {
      return null;
    }
    return await set(
      resolveArtifactShareDownload$,
      {
        selector: { kind: "share", id },
        userId: args.userId,
        allowPrivateOwner: true,
        expectedKind: args.expectedKind,
      },
      signal,
    );
  },
);
