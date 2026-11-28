import { officialStaticTemplatePreview } from "@okouai/core/official-template-preview";
import { inferMimetype } from "../../lib/mimetype";
import { readableHostedSiteMetadata$ } from "../services/hosted-site-preview.service";
import {
  findActiveArtifactForFile$,
  resolveInvitedArtifactFile$,
} from "../services/artifact-file-share-access.service";
import { artifactDownloadsContract } from "@okouai/api-contracts/contracts/artifact-downloads";
import { env } from "../../lib/env";
import { nowDate } from "../../lib/time";
import { command } from "ccstate";
import {
  artifactReferencesContract,
  parseArtifactReference,
} from "@okouai/api-contracts/contracts/artifact-references";
import {
  messageArtifactAddress,
  messageArtifactDriveStatus$,
  messageArtifactPreview,
  ownedMessageArtifact$,
} from "../services/message-artifact.service";
import { notFound } from "../../lib/error";
import { authContext$, organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { authorization$, setResHeader$ } from "../context/hono";
import { pathParamsOf, queryOf } from "../context/request";
import { s3ObjectHead } from "../external/s3";
import { resolveArtifactPreviewUrl$ } from "../services/artifact-preview-url.service";
import { appDownloadPaywalled$ } from "../services/artifact-paywall.service";
import { resolveArtifactDownloadUrl$ } from "../services/artifact-download-url.service";
import { privateArtifactRecord$ } from "../services/private-artifact-storage.service";
import { uploadedArtifactPreviewImageUrl$ } from "../services/uploaded-artifact.service";
import {
  resolveArtifactShare$,
  resolveArtifactTargetShare$,
  resolvePublicArtifactUrl$,
} from "../services/artifact-shares.service";
import {
  artifactReferenceRecord$,
  type ArtifactReferenceRecord,
} from "../services/artifact-reference.service";
import { resolveSharedThreadArtifactReference$ } from "../services/shared-thread-artifact-reference.service";
import type { RouteEntry } from "../route-entry";
import { getOwnedArtifactCatalogFromReference$ } from "../services/artifact-catalog.service";

const ownerArtifact$ = command(async ({ get, set }, signal: AbortSignal) => {
  set(setResHeader$, "Cache-Control", "private, no-store");
  const auth = get(organizationAuthContext$);
  const { reference } = get(
    pathParamsOf(artifactReferencesContract.ownerArtifact),
  );
  const artifact = await set(
    getOwnedArtifactCatalogFromReference$,
    {
      reference,
      userId: auth.userId,
      orgId: auth.orgId,
    },
    signal,
  );
  return artifact
    ? { status: 200 as const, body: { artifactId: artifact.id } }
    : notFound("Artifact not found");
});

const resolveFileReference$ = command(
  async (
    { get, set },
    args: {
      readonly id: string;
      readonly ownerKind: "file" | "html" | "artifact" | undefined;
    },
    signal: AbortSignal,
  ) => {
    const { id, ownerKind } = args;
    const auth = get(authContext$);
    const file = await set(privateArtifactRecord$, id, signal);
    signal.throwIfAborted();
    if (file) {
      if (ownerKind === "html") {
        return notFound("Artifact unavailable");
      }
      if (file.userId !== auth.userId || file.orgId !== auth.orgId) {
        if (ownerKind) {
          return notFound("Artifact unavailable");
        }
        const invited = await set(
          resolveInvitedArtifactFile$,
          { file, userId: auth.userId },
          signal,
        );
        const shared =
          invited ??
          (await set(
            resolveArtifactTargetShare$,
            { target: { kind: "file", id }, targetId: id, userId: auth.userId },
            signal,
          ));
        return shared
          ? { status: 200 as const, body: shared }
          : notFound("Artifact unavailable");
      }
      // Older attachment composers do not call complete after a single PUT.
      // Verify the owned object exists before signing its preview; multipart
      // uploads remain unreadable until R2 publishes the completed object.
      const object = await get(s3ObjectHead(file.bucket, file.key));
      signal.throwIfAborted();
      if (object.kind === "missing") {
        return notFound("Artifact unavailable");
      }
      const preview = await set(
        resolveArtifactPreviewUrl$,
        { bucket: file.bucket, key: file.key, signingDate: nowDate() },
        signal,
      );
      const downloadUrl = await set(resolveArtifactDownloadUrl$, file, signal);
      const activeArtifact = await set(
        findActiveArtifactForFile$,
        file,
        signal,
      );
      const previewImageUrl =
        activeArtifact?.thumbnail?.url ??
        (await set(
          uploadedArtifactPreviewImageUrl$,
          { id: file.id, userId: file.userId, orgId: file.orgId },
          signal,
        ));
      signal.throwIfAborted();
      return {
        status: 200 as const,
        body: {
          ...preview,
          downloadUrl,
          filename: file.filename,
          contentType: file.contentType,
          ...(previewImageUrl ? { previewImageUrl } : {}),
          ...(activeArtifact ? { artifactId: activeArtifact.id } : {}),
          target: { kind: "file" as const, id },
        },
      };
    }
    return null;
  },
);

const resolveReference$ = command(
  async (
    { get, set },
    {
      reference,
      ownerKind,
      record: knownRecord,
    }: {
      readonly reference: string;
      readonly ownerKind?: "file" | "html" | "artifact";
      readonly record?: ArtifactReferenceRecord | null;
    },
    signal: AbortSignal,
  ) => {
    const auth = get(authContext$);
    const parsed = parseArtifactReference(`/artifacts/${reference}`);
    if (!parsed) {
      return notFound("Artifact unavailable");
    }
    let id = parsed.id;
    let targetKind: "file" | "html" | undefined;
    if (id === null) {
      const record =
        knownRecord === undefined
          ? await set(artifactReferenceRecord$, parsed.hash, signal)
          : knownRecord;
      signal.throwIfAborted();
      if (!record) {
        return notFound("Artifact unavailable");
      }
      if (record.version === 3) {
        if (ownerKind) {
          return notFound("Artifact unavailable");
        }
        const shared = await set(
          resolveSharedThreadArtifactReference$,
          { ...record, viewerId: auth.userId },
          signal,
        );
        return shared
          ? { status: 200 as const, body: shared }
          : notFound("Artifact unavailable");
      }
      if (record.version === 1) {
        if (ownerKind) {
          return notFound("Artifact unavailable");
        }
        const shared = await set(
          resolveArtifactShare$,
          { id: record.shareId, userId: auth.userId, allowPrivateOwner: true },
          signal,
        );
        return shared
          ? { status: 200 as const, body: shared }
          : notFound("Artifact unavailable");
      }
      id = record.target.id;
      targetKind = record.target.kind;
    }
    if (targetKind !== "html") {
      const file = await set(resolveFileReference$, { id, ownerKind }, signal);
      if (file) {
        return file;
      }
    }
    if (targetKind === "file") {
      return notFound("Artifact unavailable");
    }
    if (targetKind || ownerKind) {
      return notFound("Artifact unavailable");
    }
    const shared = await set(
      resolveArtifactShare$,
      { id, userId: auth.userId, allowPrivateOwner: true },
      signal,
    );
    return shared
      ? { status: 200 as const, body: shared }
      : notFound("Artifact unavailable");
  },
);

const byUrl$ = command(async ({ get, set }, signal: AbortSignal) => {
  set(setResHeader$, "Cache-Control", "private, no-store");
  const { url } = get(queryOf(artifactReferencesContract.byUrl));
  const address = messageArtifactAddress(url);
  if (!address) {
    return notFound("Artifact unavailable");
  }
  const template = officialStaticTemplatePreview(address.url);
  if (template) {
    const contentType =
      template.contentType ?? inferMimetype(template.filename);
    return {
      status: 200 as const,
      body: {
        url,
        filename: template.filename,
        contentType,
        preview: messageArtifactPreview({ ...template, url, contentType }),
      },
    };
  }
  const owner = get(organizationAuthContext$);
  const record =
    address.reference?.id === null
      ? await set(artifactReferenceRecord$, address.reference.hash, signal)
      : null;
  signal.throwIfAborted();
  const detail = await set(
    ownedMessageArtifact$,
    owner,
    { ...address, record },
    signal,
  );
  if (detail) {
    return { status: 200 as const, body: detail };
  }
  // References shared by a different owner and conversation snapshots keep their
  // established read authority. A grant never exposes the owner's controls.
  if (address.reference) {
    const result = await set(
      resolveReference$,
      {
        reference: address.reference.hash + address.reference.extension,
        record,
      },
      signal,
    );
    if (result.status === 200) {
      const { filename, contentType, previewImageUrl } = result.body;
      return {
        status: 200 as const,
        body: {
          url,
          filename,
          contentType,
          preview: messageArtifactPreview({
            url,
            filename,
            contentType,
            previewImageUrl,
            artifactKind:
              result.body.target.kind === "html" ? "hosted-site" : undefined,
          }),
        },
      };
    }
  }
  if (address.siteSlug) {
    const site = await set(
      readableHostedSiteMetadata$,
      {
        publicSlug: address.siteSlug,
        hostname: address.url.hostname,
        userId: owner.userId,
      },
      signal,
    );
    if (site) {
      const { filename, artifactKind } = site;
      const contentType = "text/html";
      return {
        status: 200 as const,
        body: {
          url,
          filename,
          contentType,
          ...(typeof site.size === "number" ? { size: site.size } : {}),
          preview: messageArtifactPreview({
            url,
            filename,
            contentType,
            artifactKind,
          }),
        },
      };
    }
  }
  return notFound("Artifact unavailable");
});

const resolve$ = command(async ({ get, set }, signal: AbortSignal) => {
  const { kind } = get(queryOf(artifactReferencesContract.resolve));
  const { reference } = get(pathParamsOf(artifactReferencesContract.resolve));
  const resolved = await set(
    resolveReference$,
    { reference, ownerKind: kind },
    signal,
  );
  // Standalone conversation snapshots retain their independent sharing authority.
  if (
    resolved.status === 200 &&
    !("sharedThreadSnapshot" in resolved.body) &&
    (await set(appDownloadPaywalled$, signal))
  ) {
    const downloadUrl = new URL(
      artifactDownloadsContract.download.path.replace(
        ":reference",
        encodeURIComponent(reference),
      ),
      env("OKOU_API_BACKEND_URL"),
    ).href;
    return {
      ...resolved,
      body: { ...resolved.body, downloadUrl, downloadAllowed: false },
    };
  }
  return resolved;
});

const resolvePublicReference$ = command(
  async ({ set }, reference: string, signal: AbortSignal) => {
    const parsed = parseArtifactReference(`/artifacts/${reference}`);
    if (!parsed) {
      return notFound("Artifact unavailable");
    }
    const record =
      parsed.id === null
        ? await set(artifactReferenceRecord$, parsed.hash, signal)
        : null;
    signal.throwIfAborted();
    if (record?.version === 3) {
      const shared = await set(
        resolveSharedThreadArtifactReference$,
        record,
        signal,
      );
      return shared
        ? {
            status: 200 as const,
            body: {
              url: shared.url,
              expiresAt: shared.expiresAt,
              downloadUrl: shared.downloadUrl,
              sharedThreadSnapshot: shared.sharedThreadSnapshot,
              preview: {
                filename: shared.filename,
                contentType: shared.contentType,
                ...(shared.previewImageUrl
                  ? { previewImageUrl: shared.previewImageUrl }
                  : {}),
              },
            },
          }
        : notFound("Artifact unavailable");
    }
    const target =
      parsed.id !== null
        ? { id: parsed.id }
        : record?.version === 1
          ? { id: record.shareId, kind: "share" as const }
          : record?.target;
    if (!target) {
      return notFound("Artifact unavailable");
    }
    const result = await set(resolvePublicArtifactUrl$, target, signal);
    return result
      ? { status: 200 as const, body: result }
      : notFound("Artifact unavailable");
  },
);

const read$ = command(async ({ get, set }, signal: AbortSignal) => {
  const { reference } = get(pathParamsOf(artifactReferencesContract.read));
  const result = await set(resolveReference$, { reference }, signal);
  if (result.status === 200) {
    return {
      status: 200 as const,
      body: {
        url: result.body.url,
        filename: result.body.filename,
        contentType: result.body.contentType,
      },
    };
  }
  // Public content remains readable outside its originating organization,
  // just as it is in the artifact viewer.
  const published = await set(resolvePublicReference$, reference, signal);
  return published.status === 200
    ? {
        status: 200 as const,
        body: { url: published.body.url, ...published.body.preview },
      }
    : published;
});

const authorizedRead$ = authRoute(
  { requiredCapability: "artifact:read" },
  read$,
);

const authorizedResolve$ = authRoute({}, resolve$);
const authorizedFileResolve$ = authRoute(
  { requiredCapability: "file:read" },
  resolve$,
);
const authorizedHostedResolve$ = authRoute(
  { requiredCapability: "host:read" },
  resolve$,
);
const authorizedArtifactResolve$ = authRoute(
  { requiredCapability: "artifact:read" },
  resolve$,
);

export const artifactReferenceRoutes: readonly RouteEntry[] = [
  {
    route: artifactReferencesContract.byUrl,
    handler: authRoute(
      {
        requireOrganization: true,
        missingOrganizationStatus: 401,
        requiredCapability: "chat-event:read",
      },
      byUrl$,
    ),
  },
  {
    route: artifactReferencesContract.driveStatus,
    handler: authRoute(
      {
        requireOrganization: true,
        missingOrganizationStatus: 401,
        requiredCapability: "chat-event:read",
      },
      command(async ({ get, set }, signal: AbortSignal) => {
        set(setResHeader$, "Cache-Control", "private, no-store");
        const { publicationId } = get(
          pathParamsOf(artifactReferencesContract.driveStatus),
        );
        const { chatThreadId } = get(
          queryOf(artifactReferencesContract.driveStatus),
        );
        const status = await set(
          messageArtifactDriveStatus$,
          get(organizationAuthContext$),
          publicationId,
          chatThreadId,
          signal,
        );
        return status
          ? { status: 200 as const, body: status }
          : notFound("Artifact unavailable");
      }),
    ),
  },
  {
    route: artifactReferencesContract.ownerArtifact,
    handler: authRoute(
      {
        requireOrganization: true,
        missingOrganizationStatus: 401,
        requiredCapability: "chat-event:read",
      },
      ownerArtifact$,
    ),
  },
  {
    route: artifactReferencesContract.read,
    handler: command(async ({ set }, signal: AbortSignal) => {
      set(setResHeader$, "Cache-Control", "private, no-store");
      set(setResHeader$, "Referrer-Policy", "no-referrer");
      return await set(authorizedRead$, signal);
    }),
  },
  {
    route: artifactReferencesContract.publicUrl,
    handler: command(async ({ get, set }, signal: AbortSignal) => {
      set(setResHeader$, "Cache-Control", "private, no-store");
      set(setResHeader$, "Referrer-Policy", "no-referrer");
      const { reference } = get(
        pathParamsOf(artifactReferencesContract.publicUrl),
      );
      return await set(resolvePublicReference$, reference, signal);
    }),
  },
  {
    route: artifactReferencesContract.resolve,
    handler: command(async ({ get, set }, signal: AbortSignal) => {
      set(setResHeader$, "Cache-Control", "private, no-store");
      set(setResHeader$, "Referrer-Policy", "no-referrer");
      const { kind } = get(queryOf(artifactReferencesContract.resolve));
      if (kind === undefined && !get(authorization$)) {
        const { reference } = get(
          pathParamsOf(artifactReferencesContract.resolve),
        );
        const parsed = parseArtifactReference(`/artifacts/${reference}`);
        const record =
          parsed?.id === null
            ? await set(artifactReferenceRecord$, parsed.hash, signal)
            : null;
        signal.throwIfAborted();
        if (record?.version === 3) {
          const shared = await set(
            resolveSharedThreadArtifactReference$,
            record,
            signal,
          );
          return shared
            ? { status: 200 as const, body: shared }
            : notFound("Artifact unavailable");
        }
      }
      return await set(
        kind === "file"
          ? authorizedFileResolve$
          : kind === "html"
            ? authorizedHostedResolve$
            : kind === "artifact"
              ? authorizedArtifactResolve$
              : authorizedResolve$,
        signal,
      );
    }),
  },
];
