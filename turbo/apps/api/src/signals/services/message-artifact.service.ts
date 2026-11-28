import { command } from "ccstate";
import { and, desc, eq, inArray, isNull, or, type SQL } from "drizzle-orm";
import { uuid } from "zod";
import { parseArtifactReference } from "@okouai/api-contracts/validators/artifact-references";
import { classifyMessageArtifact } from "@okouai/api-contracts/validators/message-artifact";
import type { MessageArtifactDetail } from "@okouai/api-contracts/contracts/message-artifact";
import { linkLayoutFromSegment } from "@okouai/api-contracts/contracts/link-layout";
import { derivePlatformServiceOrigin } from "@okouai/core/platform-service-origin";
import { artifacts, imageArtifacts } from "@okouai/db/schema/artifact";
import { files } from "@okouai/db/schema/file";
import {
  hostedDeployments,
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
import type { ArtifactReferenceRecord } from "./artifact-reference.service";
import { probeLegacyArtifactSharePolicy$ } from "./artifact-share-probe.service";
import { siteArtifactIdentityPredicate } from "./hosted-site-artifact.service";
import { resolveFileUrl$ } from "./private-artifact-storage.service";
import {
  googleDriveArtifactStatusFields,
  googleDriveArtifactStatusLookup$,
} from "./google-drive-artifact-sync.service";
import { ownedGoogleDriveThreadContext$ } from "./artifact-google-drive-authorization.service";

interface Owner {
  readonly userId: string;
  readonly orgId: string;
}

const IMMUTABLE_DEPLOYMENT_HOST_PATTERN =
  /^dpl-([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/u;

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

function fileById(db: ReadonlyDb, owner: Owner, id: string) {
  return db
    .select({
      id: files.id,
      storageKey: files.storageKey,
      filename: files.filename,
      contentType: files.contentType,
      sizeBytes: files.sizeBytes,
      origin: files.origin,
      createdAt: files.createdAt,
    })
    .from(files)
    .where(
      and(
        eq(files.id, id),
        eq(files.orgId, owner.orgId),
        eq(files.ownerUserId, owner.userId),
        isNull(files.deletedAt),
      ),
    )
    .limit(1);
}

function catalogBy(db: ReadonlyDb, owner: Owner, predicate: SQL) {
  return db
    .select({
      id: artifacts.id,
      kind: artifacts.kind,
      entityId: artifacts.entityId,
      title: artifacts.title,
      sourceUrl: artifacts.sourceUrl,
      thumbnail: artifacts.thumbnail,
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

type MessageAddress = NonNullable<ReturnType<typeof messageArtifactAddress>> & {
  readonly record: ArtifactReferenceRecord | null;
};

const referenceTarget$ = command(
  async (
    { get },
    owner: Owner,
    address: MessageAddress,
    signal: AbortSignal,
  ) => {
    const db = get(db$);
    const { reference, fileId, record } = address;
    if (reference?.id === null && (!record || record.version === 3)) {
      return null;
    }

    let targetId = reference?.id ?? fileId;
    let siteId: string | undefined;
    let deploymentId: string | undefined;
    if (record?.version === 2) {
      if (record.target.kind === "file") {
        targetId = record.target.id;
      } else {
        const [deployment] = await db
          .select({
            id: privateHostedDeployments.id,
            siteId: privateHostedDeployments.siteId,
          })
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
        deploymentId = deployment.id;
      }
    }
    const shareId = record?.version === 1 ? record.shareId : reference?.id;
    return { targetId, siteId, deploymentId, shareId };
  },
);

async function loadHostedSiteDeploymentForMessage(
  db: ReadonlyDb,
  owner: Owner,
  site: Awaited<ReturnType<typeof siteBy>>[number],
  deploymentId: string | undefined,
  signal: AbortSignal,
) {
  const publicId = deploymentId ?? site.activeDeploymentId;
  const [publicDep] = publicId
    ? await db
        .select()
        .from(hostedDeployments)
        .where(
          and(
            eq(hostedDeployments.id, publicId),
            eq(hostedDeployments.siteId, site.id),
            eq(hostedDeployments.status, "ready"),
          ),
        )
        .limit(1)
    : [];
  signal.throwIfAborted();
  if (publicDep) {
    return { deployment: publicDep, isPublic: true };
  }
  const [privateDep] = await db
    .select()
    .from(privateHostedDeployments)
    .where(
      and(
        eq(privateHostedDeployments.siteId, site.id),
        eq(privateHostedDeployments.orgId, owner.orgId),
        eq(privateHostedDeployments.userId, owner.userId),
        eq(privateHostedDeployments.status, "ready"),
        deploymentId
          ? eq(privateHostedDeployments.id, deploymentId)
          : undefined,
      ),
    )
    .orderBy(desc(privateHostedDeployments.createdAt))
    .limit(1);
  signal.throwIfAborted();
  return privateDep ? { deployment: privateDep, isPublic: false } : null;
}

function formatHostedSiteMessageDetail(
  site: Awaited<ReturnType<typeof siteBy>>[number],
  catalog: Awaited<ReturnType<typeof catalogBy>>[number] | undefined,
  loaded: NonNullable<
    Awaited<ReturnType<typeof loadHostedSiteDeploymentForMessage>>
  >,
  fallbackHref: string,
): MessageArtifactDetail {
  const { deployment, isPublic } = loaded;
  const artifactKind =
    deployment.manifest.artifactKind ??
    (catalog?.kind === "presentation" ? "presentation-html" : "hosted-site");
  const aliasUrl =
    isPublic && site.activeDeploymentId
      ? hostedLinkOrigin(linkLayoutFromSegment(site.layout), site.publicSlug)
      : undefined;
  const stableUrl =
    deployment.artifactUrl ?? aliasUrl ?? catalog?.sourceUrl ?? fallbackHref;
  const filename =
    (catalog?.title ?? deployment.manifest.title ?? site.publicSlug) + ".html";
  const contentType = "text/html";
  return {
    url: stableUrl,
    filename,
    contentType,
    size: deployment.sizeBytes,
    preview: messageArtifactPreview({
      url: stableUrl,
      filename,
      contentType,
      artifactKind,
      aliasUrl,
      previewImageUrl: catalog?.thumbnail?.url ?? null,
    }),
    owner: {
      publicationId: deployment.id,
      fileId: site.id,
      artifactId: catalog?.id,
      createdAt: deployment.createdAt.toISOString(),
      ...(catalog?.title ? { title: catalog.title } : {}),
    },
  };
}

const hostedSiteMessageDetail$ = command(
  async (
    { get },
    args: {
      readonly owner: Owner;
      readonly site: Awaited<ReturnType<typeof siteBy>>[number];
      readonly deploymentId?: string;
      readonly address: MessageAddress;
    },
    signal: AbortSignal,
  ): Promise<MessageArtifactDetail | null> => {
    const { owner, site, address } = args;
    const db = get(db$);
    const [catalog] = await catalogBy(
      db,
      owner,
      siteArtifactIdentityPredicate(site.id),
    );
    signal.throwIfAborted();
    if (catalog?.deletedAt) {
      return null;
    }
    const loaded = await loadHostedSiteDeploymentForMessage(
      db,
      owner,
      site,
      args.deploymentId,
      signal,
    );
    if (!loaded) {
      return null;
    }
    return formatHostedSiteMessageDetail(
      site,
      catalog,
      loaded,
      address.url.href,
    );
  },
);

const lookupCatalogFileByUrls$ = command(
  async (
    { get },
    args: { readonly owner: Owner; readonly urls: readonly string[] },
    signal: AbortSignal,
  ) => {
    if (args.urls.length === 0) {
      return { catalog: undefined, file: undefined };
    }
    const db = get(db$);
    const [catalog] = await catalogBy(
      db,
      args.owner,
      inArray(
        artifacts.logicalKey,
        args.urls.map((url) => {
          return `file:${url}`;
        }),
      ),
    );
    signal.throwIfAborted();
    if (!catalog || catalog.deletedAt) {
      return { catalog, file: undefined };
    }
    let resolvedFileId: string | null = null;
    if (catalog.kind === "file") {
      resolvedFileId = catalog.entityId;
    } else if (catalog.kind === "image") {
      const [img] = await db
        .select({ fileId: imageArtifacts.fileId })
        .from(imageArtifacts)
        .where(eq(imageArtifacts.id, catalog.entityId))
        .limit(1);
      signal.throwIfAborted();
      resolvedFileId = img?.fileId ?? null;
    }
    if (!resolvedFileId) {
      return { catalog, file: undefined };
    }
    const [file] = await fileById(db, args.owner, resolvedFileId);
    signal.throwIfAborted();
    return { catalog, file };
  },
);

const fileMessageDetail$ = command(
  async (
    { get, set },
    args: {
      readonly owner: Owner;
      readonly file: Awaited<ReturnType<typeof fileById>>[number];
      readonly catalog?: Awaited<ReturnType<typeof catalogBy>>[number];
    },
    signal: AbortSignal,
  ): Promise<MessageArtifactDetail | null> => {
    const { owner, file } = args;
    const db = get(db$);
    const [catalog] = args.catalog
      ? [args.catalog]
      : await catalogBy(
          db,
          owner,
          or(
            and(eq(artifacts.kind, "file"), eq(artifacts.entityId, file.id)),
            and(
              eq(artifacts.kind, "image"),
              inArray(
                artifacts.entityId,
                db
                  .select({ id: imageArtifacts.id })
                  .from(imageArtifacts)
                  .where(eq(imageArtifacts.fileId, file.id)),
              ),
            ),
          )!,
        );
    signal.throwIfAborted();

    // Principle 4: soft-deleting a file artifact in Library keeps the underlying
    // `files` record readable in chat for `(ownerUserId, orgId)`, without an
    // active Library `artifactId`.
    if (!file.storageKey || !file.filename) {
      return null;
    }
    const activeCatalog = catalog && !catalog.deletedAt ? catalog : undefined;
    const stableUrl =
      activeCatalog?.sourceUrl ??
      (await set(
        resolveFileUrl$,
        { id: file.id, storageKey: file.storageKey, filename: file.filename },
        signal,
      ));
    const contentType = file.contentType || inferMimetype(file.filename);
    return {
      url: stableUrl,
      filename: file.filename,
      contentType,
      ...(file.sizeBytes !== null ? { size: file.sizeBytes } : {}),
      preview: messageArtifactPreview({
        url: stableUrl,
        filename: file.filename,
        contentType,
        previewImageUrl: activeCatalog?.thumbnail?.url ?? null,
      }),
      owner: {
        publicationId: file.id,
        fileId: file.id,
        artifactId: activeCatalog?.id,
        createdAt: file.createdAt.toISOString(),
        ...(activeCatalog?.title ? { title: activeCatalog.title } : {}),
      },
    };
  },
);

const resolveImmutableDeploymentSite$ = command(
  async (
    { get },
    args: { readonly owner: Owner; readonly siteSlug?: string },
    signal: AbortSignal,
  ) => {
    const dplMatch = args.siteSlug
      ? IMMUTABLE_DEPLOYMENT_HOST_PATTERN.exec(args.siteSlug)
      : null;
    if (!dplMatch?.[1]) {
      return undefined;
    }
    const [dep] = await get(db$)
      .select({ id: hostedDeployments.id, siteId: hostedDeployments.siteId })
      .from(hostedDeployments)
      .where(
        and(
          eq(hostedDeployments.id, dplMatch[1]),
          eq(hostedDeployments.orgId, args.owner.orgId),
          eq(hostedDeployments.userId, args.owner.userId),
        ),
      )
      .limit(1);
    signal.throwIfAborted();
    return dep;
  },
);

const resolveOwnedLegacyShareTarget$ = command(
  async (
    { get, set },
    args: { readonly owner: Owner; readonly shareId: string },
    signal: AbortSignal,
  ) => {
    const policy = await set(
      probeLegacyArtifactSharePolicy$,
      { shareId: args.shareId },
      signal,
    );
    if (
      !policy ||
      policy.ownerId !== args.owner.userId ||
      policy.orgId !== args.owner.orgId
    ) {
      return {};
    }
    if (policy.target.kind === "file") {
      const [file] = await fileById(get(db$), args.owner, policy.target.id);
      signal.throwIfAborted();
      return { file };
    }
    return { siteId: policy.target.siteId, deploymentId: policy.target.id };
  },
);

/** Follow the selected publication to its catalog and current site, each by its own identity. */
export const ownedMessageArtifact$ = command(
  async (
    { get, set },
    owner: Owner,
    address: MessageAddress,
    signal: AbortSignal,
  ): Promise<MessageArtifactDetail | null> => {
    const target = await set(referenceTarget$, owner, address, signal);
    if (!target) {
      return null;
    }
    const db = get(db$);
    let { siteId, deploymentId } = target;
    if (!siteId) {
      const dep = await set(
        resolveImmutableDeploymentSite$,
        { owner, siteSlug: address.siteSlug },
        signal,
      );
      if (dep) {
        siteId = dep.siteId;
        deploymentId = dep.id;
      }
    }

    let [file] =
      target.targetId && uuid().safeParse(target.targetId).success
        ? await fileById(db, owner, target.targetId)
        : [];
    signal.throwIfAborted();

    if (!file && !siteId && target.shareId) {
      const legacy = await set(
        resolveOwnedLegacyShareTarget$,
        { owner, shareId: target.shareId },
        signal,
      );
      file = legacy.file;
      siteId = legacy.siteId;
      deploymentId = legacy.deploymentId;
    }

    // Hosted site branch (never uses file-table placeholder rows).
    const [site] = siteId
      ? await siteBy(db, owner, eq(hostedSites.id, siteId))
      : !file && address.siteSlug
        ? await siteBy(db, owner, eq(hostedSites.publicSlug, address.siteSlug))
        : [];
    signal.throwIfAborted();
    if (site?.deletedAt || (siteId && !site)) {
      return null;
    }
    if (site) {
      return await set(
        hostedSiteMessageDetail$,
        { owner, site, deploymentId, address },
        signal,
      );
    }

    // URL lookup via `artifacts.logicalKey` when URL has no UUID or short ref.
    let catalog: Awaited<ReturnType<typeof catalogBy>>[number] | undefined;
    if (!file) {
      const resolved = await set(
        lookupCatalogFileByUrls$,
        { owner, urls: address.urls },
        signal,
      );
      catalog = resolved.catalog;
      file = resolved.file;
    }

    return file
      ? await set(fileMessageDetail$, { owner, file, catalog }, signal)
      : null;
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
    const db = get(db$);
    const [file] = await db
      .select({ id: files.id })
      .from(files)
      .where(
        and(
          eq(files.id, publicationId),
          eq(files.orgId, owner.orgId),
          eq(files.ownerUserId, owner.userId),
          isNull(files.deletedAt),
        ),
      )
      .limit(1);
    signal.throwIfAborted();
    let driveFileId: string | null = file?.id ?? null;
    if (!driveFileId) {
      const [deployment] = await db
        .select({ id: hostedDeployments.id })
        .from(hostedDeployments)
        .where(
          and(
            eq(hostedDeployments.id, publicationId),
            eq(hostedDeployments.orgId, owner.orgId),
            eq(hostedDeployments.userId, owner.userId),
          ),
        )
        .limit(1);
      signal.throwIfAborted();
      driveFileId = deployment?.id ?? null;
    }
    if (!driveFileId) {
      return null;
    }
    const source = { runId: null, fileId: driveFileId };
    const lookup = await set(
      googleDriveArtifactStatusLookup$,
      { ...context, source },
      signal,
    );
    return googleDriveArtifactStatusFields(lookup, source);
  },
);
