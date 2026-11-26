import { command } from "ccstate";
import { and, eq, isNull } from "drizzle-orm";
import { uuid } from "zod";
import { parseArtifactReference } from "@okouai/api-contracts/contracts/artifact-references";
import { artifactFileShares } from "@okouai/db/schema/artifact-file-share";
import { hostedSiteShares } from "@okouai/db/schema/hosted-site-share";
import {
  hostedSites,
  hostedDeployments,
  privateHostedDeployments,
} from "@okouai/db/runtime/hosted-site";
import { env } from "../../lib/env";
import { hostedLinkDomain, hostedLinkOrigin } from "../../lib/link-layout";
import { db$ } from "../external/db";
import { clerk$, isClerkResourceNotFound } from "../external/clerk";
import { settle } from "../utils";
import { artifactReferenceRecord$ } from "./artifact-reference.service";
import {
  privateArtifactRecord$,
  privateArtifactUrl,
} from "./private-artifact-storage.service";
import {
  readArtifactShare$,
  publicArtifactShareIdentity$,
} from "./artifact-shares.service";
import { getHostedSiteVisibility$ } from "./hosted-site-access.service";
import type { ArtifactSharingResource } from "./artifact-sharing-resource.service";

export interface ChannelSharingResource extends ArtifactSharingResource {
  readonly title: string;
  readonly audience: "private" | "organization" | "public";
  readonly revision: string | null;
  readonly shares: readonly {
    readonly email: string;
    readonly userId: string | null;
  }[];
}

/** Read the current audience and grants, optionally requiring a matching owner. Callers authorize viewers before exposing this metadata. */
export const channelSharingResource$ = command(
  async (
    { get, set },
    args: {
      readonly kind: "file" | "site";
      readonly id: string;
      readonly userId?: string;
    },
    signal: AbortSignal,
  ): Promise<ChannelSharingResource | null> => {
    if (args.kind === "file") {
      const file = await set(privateArtifactRecord$, args.id, signal);
      if (
        !file ||
        (args.userId !== undefined && file.userId !== args.userId) ||
        file.materializationStatus !== "ready"
      ) {
        return null;
      }
      const policy = await set(
        readArtifactShare$,
        {
          target: { kind: "file", id: file.id },
          userId: file.userId,
          orgId: file.orgId,
        },
        signal,
      );
      if (!policy) {
        return null;
      }
      const shares = await get(db$)
        .select({
          email: artifactFileShares.email,
          userId: artifactFileShares.userId,
        })
        .from(artifactFileShares)
        .where(eq(artifactFileShares.fileId, file.id));
      signal.throwIfAborted();
      return {
        kind: "file",
        title: file.filename,
        id: file.id,
        userId: file.userId,
        orgId: file.orgId,
        url: new URL(
          privateArtifactUrl(file.id, file.filename, file.metadata),
          env("APP_URL"),
        ).href,
        audience: policy.audience,
        revision: null,
        shares,
      };
    }
    const [site] = await get(db$)
      .select()
      .from(hostedSites)
      .where(
        and(
          eq(hostedSites.id, args.id),
          args.userId === undefined
            ? undefined
            : eq(hostedSites.userId, args.userId),
          eq(hostedSites.linkLayoutSegment, "okou"),
          isNull(hostedSites.deletedAt),
        ),
      )
      .limit(1);
    signal.throwIfAborted();
    if (!site) {
      return null;
    }
    const membership = await settle(
      get(clerk$).organizations.getOrganizationMembershipList({
        organizationId: site.orgId,
        userId: [site.userId],
        limit: 1,
      }),
      signal,
    );
    if (!membership.ok) {
      if (isClerkResourceNotFound(membership.error)) {
        return null;
      }
      throw membership.error;
    }
    if (
      !membership.value.data.some((member) => {
        return (
          member.organization.id === site.orgId &&
          member.publicUserData?.userId === site.userId
        );
      })
    ) {
      return null;
    }
    const policy = await set(
      getHostedSiteVisibility$,
      { siteId: site.id, userId: site.userId, orgId: site.orgId },
      signal,
    );
    if (!policy) {
      return null;
    }
    const shares = await get(db$)
      .select({
        email: hostedSiteShares.email,
        userId: hostedSiteShares.userId,
      })
      .from(hostedSiteShares)
      .where(eq(hostedSiteShares.siteId, site.id));
    signal.throwIfAborted();
    return {
      kind: "site",
      title: site.publicSlug,
      id: site.id,
      userId: site.userId,
      orgId: site.orgId,
      url: `${hostedLinkOrigin("current", site.publicSlug)}/`,
      audience: policy.visibility,
      revision: policy.revision,
      shares,
    };
  },
);

const resolveAppChannelArtifact$ = command(
  async (
    { get, set },
    args: { readonly path: string; readonly userId?: string },
    signal: AbortSignal,
  ): Promise<ChannelSharingResource | null> => {
    const parsed = parseArtifactReference(args.path);
    if (!parsed) {
      return null;
    }
    let id = parsed.id;
    let kind: "file" | "html" | "share" | undefined;
    if (id === null) {
      const record = await set(artifactReferenceRecord$, parsed.hash, signal);
      if (!record || record.version === 3) {
        return null;
      }
      id = record.version === 1 ? record.shareId : record.target.id;
      kind = record.version === 1 ? "share" : record.target.kind;
    }
    if (kind === undefined || kind === "file") {
      const file = await set(
        channelSharingResource$,
        { kind: "file", id, userId: args.userId },
        signal,
      );
      if (file) {
        return file;
      }
    }
    const identity = await set(
      publicArtifactShareIdentity$,
      { id, kind },
      signal,
    );
    if (
      identity &&
      (args.userId === undefined || identity.userId === args.userId)
    ) {
      return set(
        channelSharingResource$,
        {
          kind: identity.targetKind === "file" ? "file" : "site",
          id: identity.targetId,
          userId: identity.userId,
        },
        signal,
      );
    }
    if (kind === "html" || kind === undefined) {
      const [deployment] = await get(db$)
        .select({
          siteId: privateHostedDeployments.siteId,
          userId: privateHostedDeployments.userId,
        })
        .from(privateHostedDeployments)
        .where(
          and(
            eq(privateHostedDeployments.id, id),
            args.userId === undefined
              ? undefined
              : eq(privateHostedDeployments.userId, args.userId),
            eq(privateHostedDeployments.status, "ready"),
          ),
        )
        .limit(1);
      signal.throwIfAborted();
      if (deployment) {
        return set(
          channelSharingResource$,
          { kind: "site", id: deployment.siteId, userId: deployment.userId },
          signal,
        );
      }
    }
    return null;
  },
);

/** Resolve only first-party artifact identities; never fetch a user-provided URL. */
export const resolveChannelSharingResource$ = command(
  async (
    { get, set },
    args: { readonly url: string; readonly userId?: string },
    signal: AbortSignal,
  ): Promise<ChannelSharingResource | null> => {
    if (!URL.canParse(args.url)) {
      return null;
    }
    const url = new URL(args.url);
    if (
      url.username ||
      url.password ||
      !["http:", "https:"].includes(url.protocol)
    ) {
      return null;
    }
    if (url.origin === new URL(env("APP_URL")).origin) {
      return set(
        resolveAppChannelArtifact$,
        { path: url.pathname, userId: args.userId },
        signal,
      );
    }
    const suffix = `.${hostedLinkDomain("current")}`;
    if (
      url.port ||
      !url.hostname.endsWith(suffix) ||
      !["/", "/index.html"].includes(url.pathname)
    ) {
      return null;
    }
    const alias = url.hostname.slice(0, -suffix.length);
    if (!alias || alias.includes(".")) {
      return null;
    }
    const deploymentId = alias.startsWith("dpl-")
      ? uuid().safeParse(alias.slice(4))
      : null;
    if (deploymentId && !deploymentId.success) {
      return null;
    }
    const [row] = await get(db$)
      .select({ siteId: hostedSites.id, userId: hostedSites.userId })
      .from(hostedSites)
      .innerJoin(
        hostedDeployments,
        eq(hostedDeployments.siteId, hostedSites.id),
      )
      .where(
        and(
          args.userId === undefined
            ? undefined
            : eq(hostedSites.userId, args.userId),
          eq(hostedDeployments.status, "ready"),
          isNull(hostedSites.deletedAt),
          deploymentId?.success
            ? eq(hostedDeployments.id, deploymentId.data)
            : and(
                eq(hostedSites.publicSlug, alias),
                eq(hostedSites.activeDeploymentId, hostedDeployments.id),
              ),
        ),
      )
      .limit(1);
    signal.throwIfAborted();
    return row
      ? set(
          channelSharingResource$,
          { kind: "site", id: row.siteId, userId: row.userId },
          signal,
        )
      : null;
  },
);
