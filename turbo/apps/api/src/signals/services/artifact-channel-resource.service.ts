import { command } from "ccstate";
import { and, eq, isNull } from "drizzle-orm";
import { uuid } from "zod";
import { parseArtifactReference } from "@okouai/api-contracts/contracts/artifact-references";
import { artifactUserShares } from "@okouai/db/schema/artifact-user-share";
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
  resolvePrivateArtifactUrl$,
} from "./private-artifact-storage.service";
import { findActiveArtifactForFile$ } from "./artifact-file-share-access.service";
import { probeLegacyArtifactSharePolicy$ } from "./artifact-share-probe.service";
import {
  getHostedSiteVisibility$,
  readHostedSitePolicy$,
} from "./hosted-site-access.service";

export interface ChannelSharingResource {
  readonly kind: "file" | "site";
  readonly id: string;
  readonly artifactId: string;
  readonly userId: string;
  readonly orgId: string;
  readonly url: string;
  readonly title: string;
  readonly audience: "private" | "organization" | "public";
  readonly revision: string | null;
  readonly shares: readonly {
    readonly email: string;
    readonly userId: string;
  }[];
}

const ownerInOrg$ = command(
  async (
    { get },
    args: { readonly orgId: string; readonly userId: string },
    signal: AbortSignal,
  ): Promise<boolean> => {
    const membership = await settle(
      get(clerk$).organizations.getOrganizationMembershipList({
        organizationId: args.orgId,
        userId: [args.userId],
        limit: 1,
      }),
      signal,
    );
    if (!membership.ok) {
      if (isClerkResourceNotFound(membership.error)) {
        return false;
      }
      throw membership.error;
    }
    return membership.value.data.some((member) => {
      return (
        member.organization.id === args.orgId &&
        member.publicUserData?.userId === args.userId
      );
    });
  },
);

/** Read the current audience and grants, optionally requiring a matching owner. Callers authorize viewers before exposing this metadata. */
const fileChannelSharingResource$ = command(
  async (
    { get, set },
    args: { readonly id: string; readonly userId?: string },
    signal: AbortSignal,
  ): Promise<ChannelSharingResource | null> => {
    const file = await set(privateArtifactRecord$, args.id, signal);
    if (
      !file ||
      (args.userId !== undefined && file.userId !== args.userId) ||
      !file.isReady
    ) {
      return null;
    }
    const artifact = await set(findActiveArtifactForFile$, file, signal);
    if (!artifact) {
      return null;
    }
    if (
      !(await set(
        ownerInOrg$,
        { orgId: file.orgId, userId: file.userId },
        signal,
      ))
    ) {
      return null;
    }
    const [url, shares] = await Promise.all([
      set(
        resolvePrivateArtifactUrl$,
        { id: file.id, filename: file.filename },
        signal,
      ),
      get(db$)
        .select({
          email: artifactUserShares.email,
          userId: artifactUserShares.userId,
        })
        .from(artifactUserShares)
        .where(
          and(
            eq(artifactUserShares.artifactId, artifact.id),
            eq(artifactUserShares.orgId, file.orgId),
          ),
        ),
    ]);
    signal.throwIfAborted();
    return {
      kind: "file",
      title: file.filename,
      id: file.id,
      artifactId: artifact.id,
      userId: file.userId,
      orgId: file.orgId,
      url,
      audience: artifact.visibility,
      revision: null,
      shares,
    };
  },
);

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
      return await set(fileChannelSharingResource$, args, signal);
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
    if (
      !(await set(
        ownerInOrg$,
        { orgId: site.orgId, userId: site.userId },
        signal,
      ))
    ) {
      return null;
    }
    const [policy, livePolicy] = await Promise.all([
      set(
        getHostedSiteVisibility$,
        { siteId: site.id, userId: site.userId, orgId: site.orgId },
        signal,
      ),
      set(readHostedSitePolicy$, site.id, signal),
    ]);
    signal.throwIfAborted();
    if (!policy || !livePolicy?.artifactId) {
      return null;
    }
    const shares = await get(db$)
      .select({
        email: artifactUserShares.email,
        userId: artifactUserShares.userId,
      })
      .from(artifactUserShares)
      .where(
        and(
          eq(artifactUserShares.artifactId, livePolicy.artifactId),
          eq(artifactUserShares.orgId, site.orgId),
        ),
      );
    signal.throwIfAborted();
    return {
      kind: "site",
      title: site.publicSlug,
      id: site.id,
      artifactId: livePolicy.artifactId,
      userId: site.userId,
      orgId: site.orgId,
      url: `${hostedLinkOrigin("current", site.publicSlug)}/`,
      audience: policy.visibility,
      revision: policy.revision,
      shares,
    };
  },
);

const resolveLegacyShareChannelResource$ = command(
  async (
    { set },
    args: { readonly shareId: string; readonly userId?: string },
    signal: AbortSignal,
  ): Promise<ChannelSharingResource | null> => {
    const policy = await set(
      probeLegacyArtifactSharePolicy$,
      { shareId: args.shareId },
      signal,
    );
    if (
      !policy ||
      (args.userId !== undefined && policy.ownerId !== args.userId)
    ) {
      return null;
    }
    return set(
      channelSharingResource$,
      {
        kind: policy.target.kind === "file" ? "file" : "site",
        id:
          policy.target.kind === "file"
            ? policy.target.id
            : policy.target.siteId,
        userId: policy.ownerId,
      },
      signal,
    );
  },
);

const resolveDeploymentChannelResource$ = command(
  async (
    { get, set },
    args: { readonly deploymentId: string; readonly userId?: string },
    signal: AbortSignal,
  ): Promise<ChannelSharingResource | null> => {
    const [deployment] = await get(db$)
      .select({
        siteId: privateHostedDeployments.siteId,
        userId: privateHostedDeployments.userId,
      })
      .from(privateHostedDeployments)
      .where(
        and(
          eq(privateHostedDeployments.id, args.deploymentId),
          args.userId === undefined
            ? undefined
            : eq(privateHostedDeployments.userId, args.userId),
          eq(privateHostedDeployments.status, "ready"),
        ),
      )
      .limit(1);
    signal.throwIfAborted();
    if (!deployment) {
      return null;
    }
    return set(
      channelSharingResource$,
      { kind: "site", id: deployment.siteId, userId: deployment.userId },
      signal,
    );
  },
);

const resolveAppChannelArtifact$ = command(
  async (
    { set },
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
    if (kind === "share" || kind === undefined) {
      const share = await set(
        resolveLegacyShareChannelResource$,
        { shareId: id, userId: args.userId },
        signal,
      );
      if (share) {
        return share;
      }
    }
    if (kind === "html" || kind === undefined) {
      return set(
        resolveDeploymentChannelResource$,
        { deploymentId: id, userId: args.userId },
        signal,
      );
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
