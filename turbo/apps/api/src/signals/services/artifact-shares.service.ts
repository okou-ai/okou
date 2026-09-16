import { hostedSiteDeliveryManifest } from "./hosted-site-dependencies.service";
import { nowDate } from "../../lib/time";
import { randomBytes, randomUUID } from "node:crypto";
import { artifactFilenameExtension } from "@okouai/api-contracts/contracts/artifact-delivery";
import { artifactShareReferencePath } from "@okouai/api-contracts/contracts/artifact-references";
import { command, computed } from "ccstate";
import { and, eq, isNull, or } from "drizzle-orm";
import { artifactShares } from "@okouai/db/schema/artifact-share";
import {
  hostedSites,
  privateHostedDeployments,
  type HostedSiteManifest,
} from "@okouai/db/schema/hosted-site";
import {
  artifactSharePolicySchema,
  type ArtifactSharePolicy,
  type ArtifactShareTarget,
  type ArtifactShareStatus,
} from "@okouai/api-contracts/contracts/artifact-shares";
import { settle } from "../utils";
import { env } from "../../lib/env";
import { artifactHash } from "../../lib/file-url";
import { db$, writeDb$ } from "../external/db";
import {
  clerk$,
  isClerkResourceNotFound,
  type ClerkOrganizationMembership,
} from "../external/clerk";
import {
  copyArtifactShareObject,
  readArtifactSharePolicyObject,
  writeArtifactSharePolicyObject,
  generateArtifactPreviewUrl,
  putHostedSitesS3Object,
} from "../external/s3";
import {
  privateArtifactRecord,
  privateArtifactUrl,
} from "./private-artifact-storage.service";
import { createPrivateHostedPreview$ } from "./private-hosted-preview.service";
import { prepareArtifactShareAliases$ } from "./artifact-share-alias.service";

interface ShareCandidate {
  readonly targetId: string;
  readonly publicBrand: "vm0" | "okou";
  readonly candidateVersion: number | null;
  readonly target:
    | Exclude<ArtifactSharePolicy["target"], { kind: "html" }>
    | (Omit<
        Extract<ArtifactSharePolicy["target"], { kind: "html" }>,
        "snapshotId" | "manifest"
      > & {
        readonly manifest: HostedSiteManifest;
      });
}

type ShareIdentity = typeof artifactShares.$inferSelect;

function policyBucket(): string {
  const bucket = env("R2_HOSTED_SITES_BUCKET_NAME");
  if (!bucket) {
    throw new Error("Artifact sharing storage is not configured");
  }
  return bucket;
}

function policyKey(row: ShareIdentity): string {
  return `artifact-shares/${row.publicBrand}/${row.id}.json`;
}

function policyFor(row: ShareIdentity, signal: AbortSignal) {
  return computed(async (get) => {
    const downloaded = await settle(
      get(
        readArtifactSharePolicyObject(policyBucket(), policyKey(row), signal),
      ),
    );
    if (!downloaded.ok) {
      // An allocated identity grants nothing until its policy has been written.
      if (
        downloaded.error instanceof Error &&
        downloaded.error.name === "NoSuchKey"
      ) {
        return null;
      }
      throw downloaded.error;
    }
    const policy = artifactSharePolicySchema.parse(
      JSON.parse(downloaded.value.buffer.toString("utf8")),
    );
    const targetId =
      policy.target.kind === "html" ? policy.target.siteId : policy.target.id;
    if (
      policy.shareId !== row.id ||
      policy.ownerId !== row.userId ||
      policy.orgId !== row.orgId ||
      policy.publicBrand !== row.publicBrand ||
      policy.target.kind !== row.targetKind ||
      targetId !== row.targetId
    ) {
      throw new Error("Artifact share policy does not match its identity");
    }
    return { policy, etag: downloaded.value.etag };
  });
}

function ownedShareTarget(
  target: ArtifactShareTarget,
  userId: string,
  orgId: string,
) {
  return computed(async (get) => {
    if (target.kind === "file") {
      const file = await get(privateArtifactRecord(target.id));
      if (
        !file ||
        file.userId !== userId ||
        file.orgId !== orgId ||
        file.materializationStatus !== "ready"
      ) {
        return null;
      }
      return {
        targetId: file.id,
        ownerUrl: new URL(
          privateArtifactUrl(file.id, file.filename, file.metadata),
          env("APP_URL"),
        ).href,
        publicBrand: file.publicBrand,
        candidateVersion: null,
        target: {
          kind: "file" as const,
          id: file.id,
          key: file.key,
          filename: file.filename,
          contentType: file.contentType,
        },
      };
    }
    const [row] = await get(db$)
      .select({ deployment: privateHostedDeployments })
      .from(privateHostedDeployments)
      .innerJoin(
        hostedSites,
        eq(hostedSites.id, privateHostedDeployments.siteId),
      )
      .where(
        and(
          eq(privateHostedDeployments.id, target.id),
          eq(privateHostedDeployments.userId, userId),
          eq(privateHostedDeployments.orgId, orgId),
          eq(privateHostedDeployments.status, "ready"),
          isNull(hostedSites.deletedAt),
        ),
      )
      .limit(1);
    if (!row) {
      return null;
    }
    const deployment = row.deployment;
    return {
      targetId: deployment.siteId,
      ownerUrl: new URL(deployment.artifactUrl, env("APP_URL")).href,
      publicBrand: deployment.publicBrand,
      candidateVersion: deployment.deploymentVersion,
      target: {
        kind: "html" as const,
        id: deployment.id,
        siteId: deployment.siteId,
        deploymentVersion: deployment.deploymentVersion,
        manifest: hostedSiteDeliveryManifest(deployment.manifest),
      },
    };
  });
}

function shareIdentity(
  targetKind: ArtifactShareTarget["kind"],
  targetId: string,
) {
  return computed(async (get) => {
    const [row] = await get(db$)
      .select()
      .from(artifactShares)
      .where(
        and(
          eq(artifactShares.targetKind, targetKind),
          eq(artifactShares.targetId, targetId),
        ),
      )
      .limit(1);
    return row ?? null;
  });
}

function publicShareUrl(policy: ArtifactSharePolicy): string {
  if (!policy.publicToken) {
    throw new Error("Public artifact has no publication token");
  }
  // Persisted pre-registry grants keep their working URL without a read-time
  // write. Retain until #32492 accounts for every durable old share link.
  if (!policy.delivery) {
    const domain =
      policy.publicBrand === "okou"
        ? env("OKOU_PUBLIC_HOST_DOMAIN")
        : env("ZERO_HOST_DOMAIN");
    const scheme =
      policy.publicBrand === "okou"
        ? env("OKOU_HOST_SCHEME")
        : env("ZERO_HOST_SCHEME");
    if (!domain || !scheme) {
      throw new Error("Legacy public artifact delivery is not configured");
    }
    return `${scheme}://sh-${policy.shareId.replaceAll("-", "")}-${policy.publicToken}.${domain}/`;
  }
  if (policy.target.kind === "file") {
    const origin = env("PUBLIC_ARTIFACT_SHARES_BASE_URL");
    if (!origin) {
      throw new Error(
        "PUBLIC_ARTIFACT_SHARES_BASE_URL is required for file sharing",
      );
    }
    return new URL(
      `/${policy.publicToken}${artifactFilenameExtension(policy.target.filename)}`,
      origin,
    ).href;
  }
  const domain =
    policy.publicBrand === "okou"
      ? env("OKOU_PUBLIC_HOST_DOMAIN")
      : env("ZERO_HOST_DOMAIN");
  const scheme =
    policy.publicBrand === "okou"
      ? env("OKOU_HOST_SCHEME")
      : env("ZERO_HOST_SCHEME");
  if (!domain || !scheme) {
    throw new Error("Public HTML delivery is not configured");
  }
  // Preserve requested durable token links without publishing during reads.
  // Retire only after #32492 accounts for the remaining old share policies.
  return `${scheme}://${policy.publicSlug ?? policy.publicToken}.${domain}/`;
}

function shortShareUrl(policy: ArtifactSharePolicy | null): string | null {
  if (!policy || policy.status !== "active") {
    return null;
  }
  if (policy.audience === "public") {
    return policy.publicSlug ? publicShareUrl(policy) : null;
  }
  if (policy.audience !== "organization" || !policy.organizationReference) {
    return null;
  }
  return new URL(
    artifactShareReferencePath(
      policy.organizationReference,
      policy.target.kind === "file" ? policy.target.filename : "index.html",
    ),
    env("APP_URL"),
  ).href;
}

function shareStatus(args: {
  readonly policy: ArtifactSharePolicy | null;
  readonly organization: ArtifactShareStatus["organization"];
  readonly ownerUrl: string;
  readonly candidateVersion: number | null;
}): ArtifactShareStatus {
  const policy = args.policy;
  const shortUrl = shortShareUrl(policy);
  return {
    ownerUrl: args.ownerUrl,
    shareId: policy?.shareId ?? null,
    audience: policy?.audience ?? "private",
    organization: args.organization,
    candidateVersion: args.candidateVersion,
    selectedTarget: policy
      ? { kind: policy.target.kind, id: policy.target.id }
      : null,
    selectedVersion:
      policy?.target.kind === "html" ? policy.target.deploymentVersion : null,
    shortUrl,
    url:
      !policy || policy.status === "revoked"
        ? null
        : policy.audience === "public"
          ? publicShareUrl(policy)
          : shortUrl,
  };
}

// Reuse the embedded organization name only within this request. Every status,
// update and resolve still reads current membership; renames follow that fresh
// Clerk response without a separate display lookup or cross-request cache.
const currentShareMember$ = command(
  async (
    { get },
    orgId: string,
    userId: string,
    signal: AbortSignal,
  ): Promise<ClerkOrganizationMembership | null> => {
    const memberships = await settle(
      get(clerk$).organizations.getOrganizationMembershipList(
        { organizationId: orgId, userId: [userId], limit: 1 },
        undefined,
        signal,
      ),
      signal,
    );
    if (!memberships.ok) {
      // The durable share may outlive its original Clerk organization.
      if (isClerkResourceNotFound(memberships.error)) {
        return null;
      }
      throw memberships.error;
    }
    return (
      memberships.value.data.find((member) => {
        return member.publicUserData?.userId === userId;
      }) ?? null
    );
  },
);

export const readArtifactShare$ = command(
  async (
    { get, set },
    args: {
      readonly target: ArtifactShareTarget;
      readonly userId: string;
      readonly orgId: string;
    },
    signal: AbortSignal,
  ) => {
    const candidate = await get(
      ownedShareTarget(args.target, args.userId, args.orgId),
    );
    signal.throwIfAborted();
    if (!candidate) {
      return null;
    }
    const member = await set(
      currentShareMember$,
      args.orgId,
      args.userId,
      signal,
    );
    if (!member) {
      return null;
    }
    const row = await get(shareIdentity(args.target.kind, candidate.targetId));
    signal.throwIfAborted();
    const stored = row ? await get(policyFor(row, signal)) : null;
    signal.throwIfAborted();
    return shareStatus({
      policy: stored?.policy ?? null,
      organization: { id: args.orgId, name: member.organization.name },
      ownerUrl: candidate.ownerUrl,
      candidateVersion: candidate.candidateVersion,
    });
  },
);

const snapshotTarget$ = command(
  async ({ get }, candidate: ShareCandidate, signal: AbortSignal) => {
    const target = candidate.target;
    const snapshotId = randomUUID();
    if (target.kind === "file") {
      const file = await get(privateArtifactRecord(target.id));
      signal.throwIfAborted();
      if (!file) {
        throw new Error("Shared artifact disappeared");
      }
      const key = `private-artifacts/${target.id}/shares/${snapshotId}/${encodeURIComponent(target.filename)}`;
      await get(
        copyArtifactShareObject(
          {
            bucket: file.bucket,
            sourceKey: target.key,
            targetKey: key,
            hosted: false,
          },
          signal,
        ),
      );
      signal.throwIfAborted();
      return { ...target, key };
    }
    const prefix = `shared-artifacts/${candidate.publicBrand}/${snapshotId}/${target.id}`;
    const files = Object.keys(target.manifest.files);
    // Bound storage concurrency; publish no policy until every object is copied.
    for (let start = 0; start < files.length; start += 10) {
      await Promise.all(
        files.slice(start, start + 10).map((path) => {
          return get(
            copyArtifactShareObject(
              {
                bucket: policyBucket(),
                sourceKey: `private-sites/${candidate.publicBrand}/${target.id}${path}`,
                targetKey: `${prefix}${path}`,
                hosted: true,
              },
              signal,
            ),
          );
        }),
      );
      signal.throwIfAborted();
    }
    await get(
      putHostedSitesS3Object(
        policyBucket(),
        `${prefix}/manifest.json`,
        JSON.stringify(target.manifest),
        "application/json",
      ),
    );
    signal.throwIfAborted();
    return { ...target, snapshotId };
  },
);

export const updateArtifactShare$ = command(
  async (
    { get, set },
    args: {
      readonly target: ArtifactShareTarget;
      readonly userId: string;
      readonly orgId: string;
      readonly audience: ArtifactSharePolicy["audience"];
    },
    signal: AbortSignal,
  ) => {
    const candidate = await get(
      ownedShareTarget(args.target, args.userId, args.orgId),
    );
    signal.throwIfAborted();
    if (!candidate) {
      return null;
    }
    const member = await set(
      currentShareMember$,
      args.orgId,
      args.userId,
      signal,
    );
    if (!member) {
      return null;
    }
    const db = set(writeDb$);
    // Commit the durable identity before publishing. A failed later operation
    // leaves an inert identity; it cannot leave an unowned public object.
    await db
      .insert(artifactShares)
      .values({
        userId: args.userId,
        orgId: args.orgId,
        publicBrand: candidate.publicBrand,
        targetKind: args.target.kind,
        targetId: candidate.targetId,
      })
      .onConflictDoNothing({
        target: [artifactShares.targetKind, artifactShares.targetId],
      });
    signal.throwIfAborted();
    const policy = await db.transaction(async (tx) => {
      const [row] = await tx
        .select()
        .from(artifactShares)
        .where(
          and(
            eq(artifactShares.targetKind, args.target.kind),
            eq(artifactShares.targetId, candidate.targetId),
          ),
        )
        .for("update");
      if (!row || row.userId !== args.userId || row.orgId !== args.orgId) {
        return null;
      }
      const stored = await get(policyFor(row, signal));
      const previous = stored?.policy;
      signal.throwIfAborted();
      if (args.audience === "private" && !previous) {
        return null;
      }
      const target =
        previous &&
        (args.audience === "private" ||
          previous.target.id === candidate.target.id)
          ? previous.target
          : await set(snapshotTarget$, candidate, signal);
      const next = artifactSharePolicySchema.parse({
        version: 1,
        delivery: "artifact-registry-v1",
        revision: randomUUID(),
        shareId: row.id,
        ownerId: row.userId,
        orgId: row.orgId,
        publicBrand: row.publicBrand,
        audience: args.audience,
        status: args.audience === "private" ? "revoked" : "active",
        publicToken:
          args.audience === "public"
            ? (previous?.publicToken ??
              (target.kind === "file"
                ? artifactHash(randomUUID())
                : randomBytes(12).toString("hex")))
            : null,
        target,
      });
      if (next.publicToken) {
        publicShareUrl(next);
      }
      const prepared = await set(
        prepareArtifactShareAliases$,
        { policy: next, previous },
        signal,
      );
      // R2 is the only mutable authority. Acknowledge only after its strongly
      // consistent write completes. No database commit can resurrect old scope.
      // The row lock serializes owner changes, including different site versions.
      await get(
        writeArtifactSharePolicyObject(
          policyBucket(),
          policyKey(row),
          JSON.stringify(prepared),
          stored?.etag ?? null,
          signal,
        ),
      );
      return prepared;
    });
    signal.throwIfAborted();
    if (!policy && args.audience !== "private") {
      return null;
    }
    return shareStatus({
      policy,
      organization: { id: args.orgId, name: member.organization.name },
      ownerUrl: candidate.ownerUrl,
      candidateVersion: candidate.candidateVersion,
    });
  },
);

export const resolveArtifactShare$ = command(
  async (
    { get, set },
    args: {
      readonly id: string;
      readonly userId: string;
      readonly expectedTarget?: ArtifactShareTarget;
      readonly allowPrivateOwner?: boolean;
    },
    signal: AbortSignal,
  ) => {
    const [row] = await get(db$)
      .select()
      .from(artifactShares)
      .where(eq(artifactShares.id, args.id))
      .limit(1);
    signal.throwIfAborted();
    if (!row) {
      return null;
    }
    const stored = await get(policyFor(row, signal));
    signal.throwIfAborted();
    const policy = stored?.policy;
    if (
      !policy ||
      (policy.status !== "active" &&
        !(args.allowPrivateOwner && policy.ownerId === args.userId)) ||
      (args.expectedTarget &&
        (policy.target.kind !== args.expectedTarget.kind ||
          policy.target.id !== args.expectedTarget.id))
    ) {
      return null;
    }
    // No active-org assumption and no membership cache: removal is observed at
    // the next resolve. Already issued delivery credentials expire in two days;
    // content already downloaded into a browser cache can remain available.
    if (!(await set(currentShareMember$, row.orgId, args.userId, signal))) {
      return null;
    }
    if (policy.target.kind === "html") {
      const preview = await set(
        createPrivateHostedPreview$,
        {
          deploymentId: policy.target.id,
          userId: row.userId,
          orgId: row.orgId,
          snapshotId: policy.target.snapshotId,
        },
        signal,
      );
      return preview
        ? {
            ...preview,
            filename: "index.html",
            contentType: "text/html",
            target: { kind: "html" as const, id: policy.target.id },
          }
        : null;
    }
    const file = await get(privateArtifactRecord(policy.target.id));
    signal.throwIfAborted();
    if (
      !file ||
      file.userId !== row.userId ||
      file.orgId !== row.orgId ||
      file.materializationStatus !== "ready"
    ) {
      return null;
    }
    const preview = await get(
      generateArtifactPreviewUrl(file.bucket, policy.target.key, {
        signingDate: nowDate(),
        filename: file.filename,
      }),
    );
    signal.throwIfAborted();
    return {
      ...preview,
      filename: file.filename,
      contentType: file.contentType,
      target: { kind: "file" as const, id: policy.target.id },
    };
  },
);

/** A version reference must never follow a site's share to a different version. */
export const resolveArtifactTargetShare$ = command(
  async (
    { get, set },
    args: {
      readonly target: ArtifactShareTarget;
      readonly targetId: string;
      readonly userId: string;
    },
    signal: AbortSignal,
  ) => {
    const row = await get(shareIdentity(args.target.kind, args.targetId));
    signal.throwIfAborted();
    return row
      ? await set(
          resolveArtifactShare$,
          { id: row.id, userId: args.userId, expectedTarget: args.target },
          signal,
        )
      : null;
  },
);

/** Public references disclose only an already published URL, never private bytes. */
export const resolvePublicArtifactUrl$ = command(
  async (
    { get },
    args: { readonly id: string; readonly kind?: "file" | "html" | "share" },
    signal: AbortSignal,
  ) => {
    const [direct] =
      args.kind === "html"
        ? []
        : await get(db$)
            .select()
            .from(artifactShares)
            .where(
              or(
                args.kind === undefined || args.kind === "share"
                  ? eq(artifactShares.id, args.id)
                  : undefined,
                args.kind === undefined || args.kind === "file"
                  ? and(
                      eq(artifactShares.targetKind, "file"),
                      eq(artifactShares.targetId, args.id),
                    )
                  : undefined,
              ),
            )
            .limit(1);
    signal.throwIfAborted();
    let row = direct;
    if (!row && (args.kind === undefined || args.kind === "html")) {
      const [deployment] = await get(db$)
        .select({ siteId: privateHostedDeployments.siteId })
        .from(privateHostedDeployments)
        .innerJoin(
          hostedSites,
          eq(hostedSites.id, privateHostedDeployments.siteId),
        )
        .where(
          and(
            eq(privateHostedDeployments.id, args.id),
            isNull(hostedSites.deletedAt),
          ),
        )
        .limit(1);
      signal.throwIfAborted();
      row = deployment
        ? ((await get(shareIdentity("html", deployment.siteId))) ?? undefined)
        : undefined;
      signal.throwIfAborted();
    }
    if (!row) {
      return null;
    }
    const stored = await get(policyFor(row, signal));
    signal.throwIfAborted();
    const policy = stored?.policy;
    if (
      !policy ||
      policy.status !== "active" ||
      policy.audience !== "public" ||
      (row.id !== args.id &&
        args.kind !== "share" &&
        policy.target.id !== args.id)
    ) {
      return null;
    }
    // A removed artifact must not become discoverable through an old reference.
    const target = await get(
      ownedShareTarget(policy.target, row.userId, row.orgId),
    );
    signal.throwIfAborted();
    return target ? { url: publicShareUrl(policy) } : null;
  },
);
