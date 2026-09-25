import type { HostedSiteManifest } from "@okouai/db/jsonb-contracts/hosted-site";
import { command } from "ccstate";
import {
  linkLayoutSegment,
  type LinkLayout,
} from "@okouai/api-contracts/contracts/link-layout";
import { hostedDeployments, hostedSites } from "@okouai/db/runtime/hosted-site";
import { and, eq, isNull } from "drizzle-orm";

import { badRequestMessage } from "../../lib/error";
import { env } from "../../lib/env";
import { hostedLinkDomain, hostedLinkScheme } from "../../lib/link-layout";
import { nowDate } from "../../lib/time";
import { db$, type ReadonlyDb } from "../external/db";
import {
  generateHostedSitesPresignedGetUrl,
  generatePresignedGetUrl,
} from "../external/s3";
import { safeUriComponentDecode, safeUrlParse } from "../utils";
import { resolveOwnedPublicArtifactKey$ } from "./artifact-storage.service";
import { resolveArtifactPreviewUrl$ } from "./artifact-preview-url.service";
import { resolveArtifactFileReference } from "./private-artifact-storage.service";
import { uploadedArtifactObject } from "./uploaded-artifact.service";

const IMMUTABLE_DEPLOYMENT_HOST_PATTERN =
  /^dpl-([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/u;
const PUBLIC_SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/u;

interface ProviderReferenceUrlsArgs {
  readonly orgId: string;
  readonly userId: string;
  readonly urls: readonly string[];
}

interface HostedSiteUrlTarget {
  // A hosted link's host selects the layout it was issued in.
  readonly layout: LinkLayout;
  readonly publicSlug: string;
  readonly path: string;
}

interface HostedSiteDeploymentTarget {
  readonly manifest: HostedSiteManifest;
  readonly r2Prefix: string;
}

function publicSlugFromHostname(
  hostname: string,
  domain: string,
): string | null {
  const suffix = `.${domain.toLowerCase()}`;
  if (!hostname.endsWith(suffix)) {
    return null;
  }
  const publicSlug = hostname.slice(0, -suffix.length);
  return PUBLIC_SLUG_PATTERN.test(publicSlug) ? publicSlug : null;
}

function normalizeHostedSitePath(pathname: string): string | null {
  const decoded = safeUriComponentDecode(pathname);
  if (
    !decoded ||
    !decoded.startsWith("/") ||
    decoded.startsWith("//") ||
    decoded.includes("\\") ||
    decoded.includes("\0")
  ) {
    return null;
  }
  const segments = decoded.split("/").filter(Boolean);
  if (
    segments.some((segment) => {
      return segment === "." || segment === "..";
    })
  ) {
    return null;
  }
  return segments.length === 0 ? "/index.html" : `/${segments.join("/")}`;
}

function hostedSiteUrlTarget(value: string): HostedSiteUrlTarget | null {
  const url = safeUrlParse(value);
  if (!url || url.port) {
    return null;
  }
  const path = normalizeHostedSitePath(url.pathname);
  if (!path) {
    return null;
  }
  const hostname = url.hostname.toLowerCase();
  const matches = (["legacy", "current"] as const).flatMap((layout) => {
    if (url.protocol !== `${hostedLinkScheme(layout)}:`) {
      return [];
    }
    const publicSlug = publicSlugFromHostname(
      hostname,
      hostedLinkDomain(layout),
    );
    return publicSlug ? [{ layout, publicSlug, path }] : [];
  });
  return matches.length === 1 ? (matches[0] ?? null) : null;
}

async function loadHostedSiteDeployment(
  db: ReadonlyDb,
  orgId: string,
  target: HostedSiteUrlTarget,
): Promise<HostedSiteDeploymentTarget | null> {
  const deploymentId = IMMUTABLE_DEPLOYMENT_HOST_PATTERN.exec(
    target.publicSlug,
  )?.[1];
  if (deploymentId) {
    const [deployment] = await db
      .select({
        manifest: hostedDeployments.manifest,
        r2Prefix: hostedDeployments.r2Prefix,
        siteId: hostedDeployments.siteId,
      })
      .from(hostedDeployments)
      .where(
        and(
          eq(hostedDeployments.id, deploymentId),
          eq(hostedDeployments.orgId, orgId),
          eq(hostedDeployments.publicBrand, linkLayoutSegment(target.layout)),
          eq(hostedDeployments.status, "ready"),
        ),
      )
      .limit(1);
    if (!deployment) {
      return null;
    }
    const [site] = await db
      .select({ id: hostedSites.id })
      .from(hostedSites)
      .where(
        and(
          eq(hostedSites.id, deployment.siteId),
          eq(hostedSites.orgId, orgId),
          eq(hostedSites.publicBrand, linkLayoutSegment(target.layout)),
          isNull(hostedSites.deletedAt),
        ),
      )
      .limit(1);
    return site ? deployment : null;
  }

  const [site] = await db
    .select({
      id: hostedSites.id,
      activeDeploymentId: hostedSites.activeDeploymentId,
    })
    .from(hostedSites)
    .where(
      and(
        eq(hostedSites.publicSlug, target.publicSlug),
        eq(hostedSites.orgId, orgId),
        eq(hostedSites.publicBrand, linkLayoutSegment(target.layout)),
        isNull(hostedSites.deletedAt),
      ),
    )
    .limit(1);
  if (!site?.activeDeploymentId) {
    return null;
  }
  const [deployment] = await db
    .select({
      manifest: hostedDeployments.manifest,
      r2Prefix: hostedDeployments.r2Prefix,
    })
    .from(hostedDeployments)
    .where(
      and(
        eq(hostedDeployments.id, site.activeDeploymentId),
        eq(hostedDeployments.siteId, site.id),
        eq(hostedDeployments.orgId, orgId),
        eq(hostedDeployments.publicBrand, linkLayoutSegment(target.layout)),
        eq(hostedDeployments.status, "ready"),
      ),
    )
    .limit(1);
  return deployment ?? null;
}

export const resolveProviderReferenceUrls$ = command(
  async (
    { get, set },
    args: ProviderReferenceUrlsArgs,
    signal: AbortSignal,
  ): Promise<readonly string[] | ReturnType<typeof badRequestMessage>> => {
    const db = get(db$);
    const resolved: string[] = [];
    for (const url of args.urls) {
      const reference = await get(resolveArtifactFileReference(url, signal));
      signal.throwIfAborted();
      if (reference) {
        const object = await get(
          uploadedArtifactObject({
            id: reference.id,
            userId: args.userId,
            orgId: args.orgId,
          }),
        );
        signal.throwIfAborted();
        if (!object) {
          return badRequestMessage(
            "Artifact reference is not available to the current user and organization",
          );
        }
        const fetchUrl = object.isPrivate
          ? (
              await set(
                resolveArtifactPreviewUrl$,
                {
                  bucket: object.bucket,
                  key: object.key,
                  signingDate: nowDate(),
                },
                signal,
              )
            ).url
          : await get(
              generatePresignedGetUrl(
                object.bucket,
                object.key,
                undefined,
                true,
              ),
            );
        resolved.push(fetchUrl);
        signal.throwIfAborted();
        continue;
      }
      const artifactKey = await set(
        resolveOwnedPublicArtifactKey$,
        { userId: args.userId, url },
        signal,
      );
      if (artifactKey) {
        resolved.push(
          await get(
            generatePresignedGetUrl(
              env("R2_USER_ARTIFACTS_BUCKET_NAME"),
              artifactKey,
              undefined,
              true,
            ),
          ),
        );
        signal.throwIfAborted();
        continue;
      }

      const hostedTarget = hostedSiteUrlTarget(url);
      const hostedBucket = env("R2_HOSTED_SITES_BUCKET_NAME");
      if (!hostedTarget || !hostedBucket) {
        resolved.push(url);
        continue;
      }
      const deployment = await loadHostedSiteDeployment(
        db,
        args.orgId,
        hostedTarget,
      );
      signal.throwIfAborted();
      if (!deployment?.manifest.files[hostedTarget.path]) {
        resolved.push(url);
        continue;
      }
      resolved.push(
        await get(
          generateHostedSitesPresignedGetUrl(
            hostedBucket,
            `${deployment.r2Prefix}${hostedTarget.path}`,
            true,
          ),
        ),
      );
      signal.throwIfAborted();
    }
    return resolved;
  },
);
