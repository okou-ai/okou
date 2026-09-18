import { command } from "ccstate";
import type { ArtifactDownloadResponse } from "@okouai/api-contracts/contracts/artifact-downloads";
import { parseArtifactReference } from "@okouai/api-contracts/contracts/artifact-references";
import { nowDate } from "../../lib/time";
import { generateArtifactPreviewUrl, s3ObjectHead } from "../external/s3";
import { artifactReferenceRecord } from "./artifact-reference.service";
import { privateArtifactRecord } from "./private-artifact-storage.service";
import { resolveArtifactShareDownload$ } from "./artifact-shares.service";
import { getHostedSiteFiles$ } from "./host.service";

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
      const record = await get(artifactReferenceRecord(parsed.hash, signal));
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
      id = record.target.id;
      kind = record.target.kind;
    }
    if (args.expectedKind && kind === "file") {
      return null;
    }
    if (kind !== "html" && args.expectedKind !== "html") {
      const file = await get(privateArtifactRecord(id));
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
        const preview = await get(
          generateArtifactPreviewUrl(file.bucket, file.key, {
            signingDate: nowDate(),
          }),
        );
        signal.throwIfAborted();
        return {
          kind: "file",
          url: preview.url,
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
