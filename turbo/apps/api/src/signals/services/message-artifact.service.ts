import { command } from "ccstate";
import { and, eq, inArray, isNull, sql, type SQL } from "drizzle-orm";
import { uuid } from "zod";
import { parseArtifactReference } from "@okouai/api-contracts/validators/artifact-references";
import { classifyMessageArtifact } from "@okouai/api-contracts/validators/message-artifact";
import type { MessageArtifactDetail } from "@okouai/api-contracts/contracts/message-artifact";
import { linkLayoutFromSegment } from "@okouai/api-contracts/contracts/link-layout";
import { derivePlatformServiceOrigin } from "@okouai/core/platform-service-origin";
import { artifacts } from "@okouai/db/schema/artifact";
import { artifactShares } from "@okouai/db/schema/artifact-share";
import {
  CANONICAL_ASSET_VERSION,
  RUN_UPLOADED_FILE_SOURCES,
  runUploadedFiles as files,
} from "@okouai/db/schema/run-uploaded-file";
import {
  hostedSites,
  privateHostedDeployments,
} from "@okouai/db/runtime/hosted-site";
import { env } from "../../lib/env";
import {
  canonicalOkouArtifactCatalogUrl,
  OKOU_CDN_ARTIFACTS_ORIGIN,
  OKOU_SHORT_ARTIFACTS_ORIGIN,
  publicArtifactsBaseUrl,
} from "../../lib/file-url";
import { hostedLinkDomain, hostedLinkOrigin } from "../../lib/link-layout";
import { inferMimetype } from "../../lib/mimetype";
import { db$, type ReadonlyDb } from "../external/db";
import { artifactReferenceRecord$ } from "./artifact-reference.service";
import {
  googleDriveArtifactStatusFields,
  googleDriveArtifactStatusLookup$,
} from "./google-drive-artifact-sync.service";
import { ownedGoogleDriveThreadContext$ } from "./artifact-google-drive-authorization.service";

interface Owner {
  readonly userId: string;
  readonly orgId: string;
}

function publicationUrls(url: URL, local: boolean) {
  const legacy = local
    ? /^\/(f|artifacts)\/([^/]+)\/([^/]+)\/([^/]+)$/u.exec(url.pathname)
    : null;
  const urls = new Set([url.href]);
  if (local) {
    urls.add(url.pathname + url.search);
  }
  if (legacy) {
    const [, path, user, id, filename] = legacy;
    const storageUser =
      path === "f" && !/^(?:user$|user[_-])/u.test(user!)
        ? `user_${user}`
        : user;
    urls.add(
      `${publicArtifactsBaseUrl("legacy")}/artifacts/${storageUser}/${id}/${filename}`,
    );
  }
  const canonical = canonicalOkouArtifactCatalogUrl(url);
  if (canonical) {
    urls.add(canonical);
  }
  if (
    url.origin === OKOU_CDN_ARTIFACTS_ORIGIN &&
    url.pathname.startsWith("/artifacts/")
  ) {
    const short = new URL(
      url.pathname.slice("/artifacts".length) + url.search,
      OKOU_SHORT_ARTIFACTS_ORIGIN,
    );
    if (canonicalOkouArtifactCatalogUrl(short) === url.href) {
      urls.add(short.href);
    }
  }
  return urls;
}

export function messageArtifactAddress(value: string) {
  if (!value.startsWith("/") && !URL.canParse(value)) {
    return null;
  }
  if (value.startsWith("//") || /[\s\\]/u.test(value)) {
    return null;
  }
  const url = new URL(value, env("APP_URL"));
  if (
    !["https:", "http:"].includes(url.protocol) ||
    url.username ||
    url.password
  ) {
    return null;
  }
  url.hash = "";
  const app = new URL(env("APP_URL")).origin;
  const backend = env("OKOU_API_BACKEND_URL");
  const api = backend ? new URL(backend).origin : undefined;
  const local =
    url.origin === app ||
    url.origin === api ||
    (["www", "app", "platform", "api"] as const).some((service) => {
      return url.origin === derivePlatformServiceOrigin(app, service);
    });
  const reference = local
    ? parseArtifactReference(url.pathname + url.search)
    : null;
  const fileId =
    local && url.pathname === "/api/web/file-url"
      ? url.searchParams.get("file_id")
      : null;
  const urls = publicationUrls(url, local);
  let siteSlug: string | undefined;
  for (const layout of ["current", "legacy"] as const) {
    const domain = hostedLinkDomain(layout);
    const label = url.hostname.slice(0, -(domain.length + 1));
    if (
      url.hostname.endsWith(`.${domain}`) &&
      /^[a-z0-9][a-z0-9-]*$/u.test(label) &&
      url.origin === hostedLinkOrigin(layout, label)
    ) {
      siteSlug = label;
      urls.add(url.origin);
      urls.add(url.origin + "/");
    }
  }
  return { url, reference, fileId, urls: [...urls], siteSlug };
}

function fileBy(db: ReadonlyDb, owner: Owner, predicate: SQL, ...other: SQL[]) {
  return db
    .select({
      id: files.id,
      externalId: files.externalId,
      runId: files.runId,
      filename: files.filename,
      contentType: files.contentType,
      size: files.sizeBytes,
      url: files.url,
      previewImageUrl: files.previewImageUrl,
      createdAt: files.createdAt,
      assetVersion: files.assetVersion,
      classification: files.classification,
      access: files.accessLevel,
      metadata: files.metadata,
    })
    .from(files)
    .where(
      and(
        eq(files.orgId, owner.orgId),
        eq(files.userId, owner.userId),
        isNull(files.deletedAt),
        predicate,
        ...other,
      ),
    )
    .orderBy(
      sql`${files.createdAt} DESC NULLS LAST`,
      sql`${files.id} DESC NULLS LAST`,
    )
    .limit(1);
}

function catalogBy(db: ReadonlyDb, owner: Owner, predicate: SQL) {
  return db
    .select({
      id: artifacts.id,
      title: artifacts.title,
      fileId: artifacts.projectionFileId,
      deletedAt: artifacts.deletedAt,
    })
    .from(artifacts)
    .where(
      and(
        eq(artifacts.orgId, owner.orgId),
        eq(artifacts.authorUserId, owner.userId),
        predicate,
      ),
    )
    .limit(1);
}

function siteBy(db: ReadonlyDb, owner: Owner, predicate: SQL) {
  return db
    .select({
      id: hostedSites.id,
      publicSlug: hostedSites.publicSlug,
      layout: hostedSites.linkLayoutSegment,
      activeDeploymentId: hostedSites.activeDeploymentId,
      deletedAt: hostedSites.deletedAt,
    })
    .from(hostedSites)
    .where(
      and(
        eq(hostedSites.orgId, owner.orgId),
        eq(hostedSites.userId, owner.userId),
        predicate,
      ),
    )
    .limit(1);
}

interface PreviewFile {
  url: string;
  filename: string;
  contentType: string;
  previewImageUrl?: string | null;
  artifactKind?: string;
  aliasUrl?: string;
}

export function messageArtifactPreview(
  file: PreviewFile,
): MessageArtifactDetail["preview"] {
  const { url, previewImageUrl } = file;
  const cover = previewImageUrl ? { coverUrl: previewImageUrl } : {};
  if (
    file.artifactKind === "hosted-site" ||
    file.artifactKind === "presentation-html"
  ) {
    return {
      kind:
        file.artifactKind === "hosted-site" ? "website" : "presentation-html",
      pageUrl: url,
      ...cover,
      ...(file.aliasUrl ? { aliasUrl: file.aliasUrl } : {}),
    };
  }
  const kind = classifyMessageArtifact(file);
  switch (kind) {
    case "image": {
      return {
        kind,
        imageUrl: url,
        ...(previewImageUrl ? { thumbnailUrl: previewImageUrl } : {}),
      };
    }
    case "video": {
      return {
        kind,
        playbackUrl: url,
        ...(previewImageUrl ? { posterUrl: previewImageUrl } : {}),
      };
    }
    case "audio": {
      return { kind, playbackUrl: url };
    }
    case "html": {
      return { kind, pageUrl: url, ...cover };
    }
    default: {
      return { kind, fileUrl: url };
    }
  }
}

const referenceTarget$ = command(
  async (
    { get, set },
    owner: Owner,
    address: NonNullable<ReturnType<typeof messageArtifactAddress>>,
    signal: AbortSignal,
  ) => {
    const db = get(db$);
    const { reference, fileId } = address;
    const record =
      reference?.id === null
        ? await set(artifactReferenceRecord$, reference.hash, signal)
        : null;
    if (reference?.id === null && (!record || record.version === 3)) {
      return null;
    }

    let targetId = reference?.id ?? fileId;
    let externalId = fileId;
    let siteId: string | undefined;
    if (record?.version === 2) {
      if (record.target.kind === "file") {
        targetId = record.target.id;
      } else {
        const [deployment] = await db
          .select({ siteId: privateHostedDeployments.siteId })
          .from(privateHostedDeployments)
          .where(
            and(
              eq(privateHostedDeployments.id, record.target.id),
              eq(privateHostedDeployments.orgId, owner.orgId),
              eq(privateHostedDeployments.userId, owner.userId),
            ),
          )
          .limit(1);
        signal.throwIfAborted();
        if (!deployment) {
          return null;
        }
        siteId = deployment.siteId;
        externalId = record.target.id;
      }
    }
    const shareId = record?.version === 1 ? record.shareId : reference?.id;
    return { targetId, externalId, siteId, shareId };
  },
);

type MessageAddress = NonNullable<ReturnType<typeof messageArtifactAddress>>;
type Publication = Awaited<ReturnType<typeof fileBy>>[number];
type CatalogEntry = Awaited<ReturnType<typeof catalogBy>>[number];
type Site = Awaited<ReturnType<typeof siteBy>>[number];

const ownedPublicationForLink$ = command(
  async (
    { get, set },
    owner: Owner,
    address: MessageAddress,
    signal: AbortSignal,
  ) => {
    const target = await set(referenceTarget$, owner, address, signal);
    if (!target) {
      return null;
    }
    const db = get(db$);
    const { targetId, externalId, shareId } = target;
    let siteId = target.siteId;
    let [file] =
      targetId && uuid().safeParse(targetId).success
        ? await fileBy(db, owner, eq(files.id, targetId))
        : [];
    if (!file && externalId) {
      [file] = await fileBy(
        db,
        owner,
        inArray(files.source, [...RUN_UPLOADED_FILE_SOURCES]),
        eq(files.externalId, externalId),
      );
    }
    if (!file && shareId) {
      const [share] = await db
        .select({
          id: artifactShares.targetId,
          kind: artifactShares.targetKind,
        })
        .from(artifactShares)
        .where(
          and(
            eq(artifactShares.id, shareId),
            eq(artifactShares.orgId, owner.orgId),
            eq(artifactShares.userId, owner.userId),
          ),
        )
        .limit(1);
      signal.throwIfAborted();
      if (share?.kind === "file") {
        [file] = await fileBy(db, owner, eq(files.id, share.id));
      } else if (share?.kind === "html") {
        siteId = share.id;
      }
    }
    // Exact publication wins over a mutable site's current projection. Hash narrows the
    // index entry even for long URLs; equality on the stored URL confirms identity.
    if (!file) {
      for (const url of address.urls) {
        [file] = await fileBy(
          db,
          owner,
          sql`md5(${files.url}) = md5(${url}::text)`,
          eq(files.url, url),
        );
        if (file) {
          break;
        }
      }
    }
    signal.throwIfAborted();
    return { file, siteId };
  },
);

async function publicationCatalog(
  db: ReadonlyDb,
  owner: Owner,
  target: {
    file: Publication | undefined;
    site: Site | undefined;
    urls: readonly string[];
  },
  signal: AbortSignal,
) {
  const { file, site, urls } = target;
  let [catalog] = site
    ? await catalogBy(db, owner, eq(artifacts.logicalKey, `site:${site.id}`))
    : file
      ? await catalogBy(db, owner, eq(artifacts.projectionFileId, file.id))
      : [];
  signal.throwIfAborted();
  if (!site && !catalog) {
    const fileUrls = new Set(urls);
    if (file?.url) {
      fileUrls.add(file.url);
      if (URL.canParse(file.url)) {
        const canonical = canonicalOkouArtifactCatalogUrl(new URL(file.url));
        if (canonical) {
          fileUrls.add(canonical);
        }
      }
    }
    [catalog] = await catalogBy(
      db,
      owner,
      inArray(
        artifacts.logicalKey,
        Array.from(fileUrls, (url) => {
          return `file:${url}`;
        }),
      ),
    );
  }
  return catalog;
}

function publicationDetail(
  file: Publication,
  site: Site | undefined,
  catalog: CatalogEntry | undefined,
  address: MessageAddress,
): MessageArtifactDetail {
  const filename = file.filename ?? file.externalId;
  const contentType = file.contentType ?? inferMimetype(filename);
  const stableUrl = file.url ?? address.url.href;
  const aliasUrl =
    site?.activeDeploymentId && typeof file.metadata.aliasUrl === "string"
      ? hostedLinkOrigin(linkLayoutFromSegment(site.layout), site.publicSlug)
      : undefined;
  const artifactKind =
    typeof file.metadata.artifactKind === "string"
      ? file.metadata.artifactKind
      : undefined;
  // User uploads may have file metadata without being manageable catalog artifacts.
  const artifactId =
    catalog?.id ??
    (file.runId && file.classification !== "input" ? file.id : undefined);
  return {
    url: stableUrl,
    filename,
    contentType,
    ...(file.size !== null ? { size: file.size } : {}),
    preview: messageArtifactPreview({
      url: stableUrl,
      filename,
      contentType,
      artifactKind,
      aliasUrl,
      previewImageUrl: file.previewImageUrl,
    }),
    owner: {
      publicationId: file.id,
      fileId:
        file.assetVersion === CANONICAL_ASSET_VERSION &&
        file.classification === "published-output" &&
        file.access === "published"
          ? file.id
          : file.externalId,
      artifactId,
      createdAt: file.createdAt.toISOString(),
      ...(catalog?.title ? { title: catalog.title } : {}),
    },
  };
}

/** Follow the selected publication to its catalog and current site, each by its own identity. */
export const ownedMessageArtifact$ = command(
  async (
    { get, set },
    owner: Owner,
    address: NonNullable<ReturnType<typeof messageArtifactAddress>>,
    signal: AbortSignal,
  ): Promise<MessageArtifactDetail | null> => {
    const publication = await set(
      ownedPublicationForLink$,
      owner,
      address,
      signal,
    );
    if (!publication) {
      return null;
    }
    const db = get(db$);
    const { siteSlug, urls } = address;
    let { file, siteId } = publication;
    const publishedSiteId = uuid().safeParse(file?.metadata.siteId);
    if (publishedSiteId.success) {
      siteId = publishedSiteId.data;
    }
    const [site] = siteId
      ? await siteBy(db, owner, eq(hostedSites.id, siteId))
      : siteSlug
        ? await siteBy(db, owner, eq(hostedSites.publicSlug, siteSlug))
        : [];
    if (site?.deletedAt || (siteId && !site)) {
      return null;
    }
    const catalog = await publicationCatalog(
      db,
      owner,
      { file, site, urls },
      signal,
    );
    if (catalog?.deletedAt) {
      return null;
    }
    if (!file && catalog?.fileId) {
      [file] = await fileBy(db, owner, eq(files.id, catalog.fileId));
    }
    signal.throwIfAborted();
    if (!file) {
      return null;
    }

    return publicationDetail(file, site, catalog, address);
  },
);

/** Provider status is independent of the cheap URL-to-preview read. */
export const messageArtifactDriveStatus$ = command(
  async (
    { get, set },
    owner: Owner,
    publicationId: string,
    threadId: string,
    signal: AbortSignal,
  ) => {
    const context = { ...owner, threadId };
    if (!(await set(ownedGoogleDriveThreadContext$, context, signal))) {
      return null;
    }
    const [file] = await get(db$)
      .select({ fileId: files.externalId, runId: files.runId })
      .from(files)
      .where(
        and(
          eq(files.id, publicationId),
          eq(files.orgId, owner.orgId),
          eq(files.userId, owner.userId),
          isNull(files.deletedAt),
        ),
      )
      .limit(1);
    signal.throwIfAborted();
    if (!file) {
      return null;
    }
    const lookup = await set(
      googleDriveArtifactStatusLookup$,
      { ...context, source: file },
      signal,
    );
    return googleDriveArtifactStatusFields(lookup, file);
  },
);
