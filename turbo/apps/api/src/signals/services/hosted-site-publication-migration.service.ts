import { randomUUID } from "node:crypto";
import {
  hostedSitePointerNamespace,
  linkLayoutFromSegment,
  linkLayoutSegment,
  storedLinkLayoutSegment,
} from "@okouai/api-contracts/contracts/link-layout";
import { command, computed } from "ccstate";
import { and, eq } from "drizzle-orm";
import {
  artifactDeliveryKey,
  artifactDeliveryRecordSchema,
  type ArtifactDeliveryRecord,
} from "@okouai/api-contracts/contracts/artifact-delivery";
import {
  artifactSharePolicySchema,
  type ArtifactSharePolicy,
} from "@okouai/api-contracts/contracts/artifact-shares";
import type { artifactShares } from "@okouai/db/schema/artifact-share";
import {
  hostedDeployments,
  privateHostedDeployments,
  type hostedSites,
} from "@okouai/db/runtime/hosted-site";
import { legacyHostedDeploymentVersion } from "../../lib/hosted-publication";
import {
  hostedSitePointerSchema,
  type HostedSitePointer,
} from "../../lib/hosted-site-pointer";
import {
  isS3NotFoundError,
  readArtifactSharePolicyObject,
  writeArtifactSharePolicyObject,
} from "../external/s3";
import { settle } from "../utils";
import { ArtifactDeliveryAliasConflict } from "./artifact-delivery.service";

type HostedSite = typeof hostedSites.$inferSelect;

type HostedDeployment = typeof hostedDeployments.$inferSelect;
type HostedShare = typeof artifactShares.$inferSelect;
interface StoredHostedObject {
  readonly buffer: Buffer;
  readonly etag: string;
}

interface SnapshotPolicyContext {
  readonly site: HostedSite;
  readonly bucket: string;
  readonly record: Extract<ArtifactDeliveryRecord, { kind: "publication" }>;
  readonly key: string;
  readonly stored: StoredHostedObject;
  readonly policy: ArtifactSharePolicy;
}

interface HostedPointerPublication {
  readonly site: HostedSite;
  readonly bucket: string;
  readonly key: string;
  readonly pointerKey: string;
  readonly desired: ArtifactDeliveryRecord;
  readonly registry: StoredHostedObject | null;
  readonly active: StoredHostedObject | null;
  readonly previous: ArtifactDeliveryRecord | null;
  readonly pointer: HostedSitePointer;
  readonly retained: boolean;
}

/** A strongly consistent hosted-sites object read; null when the key is absent. */
export function storedObject(bucket: string, key: string, signal: AbortSignal) {
  return computed(async (get) => {
    const result = await settle(
      get(readArtifactSharePolicyObject(bucket, key, signal)),
      signal,
    );
    if (result.ok) {
      return result.value;
    }
    if (isS3NotFoundError(result.error)) {
      return null;
    }
    throw result.error;
  });
}

export function hostedSiteAliasConflict(): never {
  throw new ArtifactDeliveryAliasConflict(
    "Hosted site address belongs to another publication. Choose a different --site value and republish.",
  );
}

function validateSnapshotPolicy(
  policy: ArtifactSharePolicy,
  site: HostedSite,
  record: Extract<ArtifactDeliveryRecord, { kind: "publication" }>,
) {
  // A fresh public upload may replace a revoked old snapshot's named alias.
  // Its token stays revoked; the historical bootstrap only accepts Public.
  const retainedAudience =
    (policy.status === "active" &&
      policy.audience === "public" &&
      policy.publicToken === record.publicToken) ||
    (policy.status === "revoked" &&
      policy.audience === "private" &&
      policy.publicToken === null);
  if (
    policy.shareId !== record.shareId ||
    policy.ownerId !== site.userId ||
    policy.orgId !== site.orgId ||
    policy.publicBrand !== site.linkLayoutSegment ||
    !retainedAudience ||
    (policy.publicSlug !== undefined &&
      policy.publicSlug !== site.publicSlug) ||
    policy.target.kind !== "html" ||
    policy.target.siteId !== site.id ||
    policy.target.manifest.publicSlug !== site.publicSlug
  ) {
    hostedSiteAliasConflict();
  }
}

/** The owner locks the share before these policy reads. */
export const readHostedSnapshotPolicy$ = command(
  async (
    { get },
    args: {
      readonly site: HostedSite;
      readonly bucket: string;
      readonly record: Extract<ArtifactDeliveryRecord, { kind: "publication" }>;
      readonly share: HostedShare | undefined;
    },
    signal: AbortSignal,
  ): Promise<SnapshotPolicyContext> => {
    const { site, record, share } = args;
    if (
      !share ||
      share.targetKind !== "html" ||
      share.targetId !== site.id ||
      share.orgId !== site.orgId ||
      share.userId !== site.userId ||
      share.linkLayoutSegment !== site.linkLayoutSegment ||
      record.targetKind !== "html" ||
      record.publicBrand !== site.linkLayoutSegment ||
      record.publicToken === site.publicSlug
    ) {
      hostedSiteAliasConflict();
    }
    const key = `artifact-shares/${site.linkLayoutSegment}/${share.id}.json`;
    const stored = await get(storedObject(args.bucket, key, signal));
    signal.throwIfAborted();
    if (!stored) {
      hostedSiteAliasConflict();
    }
    const policy = artifactSharePolicySchema.parse(
      JSON.parse(stored.buffer.toString("utf8")),
    );
    validateSnapshotPolicy(policy, site, record);
    return { site, bucket: args.bucket, record, key, stored, policy };
  },
);

/** Source admission stays between the owner's policy and token reads. */
export const preserveHostedSnapshotToken$ = command(
  async ({ get }, args: SnapshotPolicyContext, signal: AbortSignal) => {
    const { site, record, key, stored, policy } = args;
    const token = await get(
      storedObject(
        args.bucket,
        artifactDeliveryKey(
          storedLinkLayoutSegment(site.linkLayoutSegment),
          "html",
          record.publicToken,
        ),
        signal,
      ),
    );
    signal.throwIfAborted();
    if (
      !token ||
      JSON.stringify(
        artifactDeliveryRecordSchema.parse(
          JSON.parse(token.buffer.toString("utf8")),
        ),
      ) !== JSON.stringify(record)
    ) {
      hostedSiteAliasConflict();
    }
    if (policy.publicSlug !== undefined) {
      // The old alias still works through its token during this step. Do this
      // before the registry transition, so retries never advertise the site as
      // the old snapshot. An absent slug also makes this step resumable.
      const { publicSlug: _publicSlug, ...snapshot } = policy;
      await get(
        writeArtifactSharePolicyObject(
          args.bucket,
          key,
          JSON.stringify({ ...snapshot, revision: randomUUID() }),
          stored.etag,
          signal,
        ),
      );
    }
    signal.throwIfAborted();
  },
);

function retainedPointer(
  site: HostedSite,
  current: HostedSitePointer,
  next: HostedSitePointer,
): HostedSitePointer {
  if (
    current.siteId !== site.id ||
    current.publicSlug !== site.publicSlug ||
    // Pointers written before the layout marker are legacy-layout pointers.
    (current.publicBrand ?? linkLayoutSegment("legacy")) !==
      site.linkLayoutSegment
  ) {
    hostedSiteAliasConflict();
  }
  if (
    current.deploymentVersion !== undefined &&
    current.deploymentVersion === next.deploymentVersion &&
    current.deploymentId !== next.deploymentId
  ) {
    throw new Error("Hosted site has conflicting deployment versions");
  }
  if (
    current.deploymentVersion === undefined ||
    (next.deploymentVersion !== undefined &&
      current.deploymentVersion <= next.deploymentVersion)
  ) {
    return next;
  }
  return current;
}

export function retainedHostedDeploymentCondition(
  site: HostedSite,
  current: HostedSitePointer,
) {
  return and(
    eq(hostedDeployments.id, current.deploymentId),
    eq(hostedDeployments.siteId, site.id),
    eq(hostedDeployments.orgId, site.orgId),
    eq(hostedDeployments.userId, site.userId),
    eq(hostedDeployments.linkLayoutSegment, site.linkLayoutSegment),
  );
}

export function validateRetainedHostedDeployment(
  deployment: HostedDeployment | undefined,
  current: HostedSitePointer,
) {
  if (
    !deployment ||
    deployment.manifest.access ||
    (deployment.status !== "uploading" && deployment.status !== "ready") ||
    legacyHostedDeploymentVersion(deployment.manifest) !==
      current.deploymentVersion ||
    deployment.r2Prefix !== current.prefix ||
    current.manifestKey !== `${deployment.r2Prefix}/manifest.json`
  ) {
    throw new Error(
      "Hosted site pointer has an invalid public deployment binding",
    );
  }
}

/** Publish prepared public bytes before changing a same-site historical alias. */
export const readHostedPointerPublication$ = command(
  async (
    { get },
    args: {
      readonly bucket: string;
      readonly site: HostedSite;
      readonly pointer: HostedSitePointer;
    },
    signal: AbortSignal,
  ): Promise<HostedPointerPublication> => {
    const { site } = args;
    const segment = storedLinkLayoutSegment(site.linkLayoutSegment);
    const namespace = hostedSitePointerNamespace(
      linkLayoutFromSegment(segment),
    );
    const pointerKey = `${namespace}/${site.publicSlug}/active.json`;
    const key = artifactDeliveryKey(segment, "html", site.publicSlug);
    const desired: ArtifactDeliveryRecord = {
      version: 1,
      kind: "legacy-site",
      publicBrand: segment,
      audience: "public",
      pointerKey,
    };
    const registry = await get(storedObject(args.bucket, key, signal));
    signal.throwIfAborted();
    const previous = registry
      ? artifactDeliveryRecordSchema.parse(
          JSON.parse(registry.buffer.toString("utf8")),
        )
      : null;
    if (
      previous &&
      previous.kind !== "publication" &&
      JSON.stringify(previous) !== JSON.stringify(desired)
    ) {
      hostedSiteAliasConflict();
    }
    const active = await get(storedObject(args.bucket, pointerKey, signal));
    signal.throwIfAborted();
    const pointer = active
      ? retainedPointer(
          site,
          hostedSitePointerSchema.parse(
            JSON.parse(active.buffer.toString("utf8")),
          ),
          args.pointer,
        )
      : args.pointer;
    return {
      site,
      bucket: args.bucket,
      key,
      pointerKey,
      desired,
      registry,
      active,
      previous,
      pointer,
      retained: pointer !== args.pointer,
    };
  },
);

export function hostedSnapshotSourceCondition(snapshot: SnapshotPolicyContext) {
  const { site, policy } = snapshot;
  return and(
    eq(privateHostedDeployments.id, policy.target.id),
    eq(privateHostedDeployments.siteId, site.id),
    eq(privateHostedDeployments.userId, site.userId),
    eq(privateHostedDeployments.orgId, site.orgId),
    eq(privateHostedDeployments.linkLayoutSegment, site.linkLayoutSegment),
    eq(privateHostedDeployments.status, "ready"),
  );
}

/** Remote writes remain inside the owner's existing transaction. */
export const writeHostedPointerPublication$ = command(
  async (
    { get },
    args: HostedPointerPublication,
    signal: AbortSignal,
  ): Promise<HostedSitePointer> => {
    const { pointer, pointerKey, key, desired, registry, active, previous } =
      args;
    await get(
      writeArtifactSharePolicyObject(
        args.bucket,
        pointerKey,
        JSON.stringify(pointer),
        active?.etag ?? null,
        signal,
      ),
    );
    signal.throwIfAborted();
    if (previous?.kind !== "legacy-site") {
      const written = await settle(
        get(
          writeArtifactSharePolicyObject(
            args.bucket,
            key,
            JSON.stringify(desired),
            registry?.etag ?? null,
            signal,
          ),
        ),
        signal,
      );
      if (!written.ok) {
        if (
          !(written.error instanceof Error) ||
          written.error.name !== "PreconditionFailed"
        ) {
          throw written.error;
        }
        const current = await get(storedObject(args.bucket, key, signal));
        signal.throwIfAborted();
        if (
          !current ||
          JSON.stringify(
            artifactDeliveryRecordSchema.parse(
              JSON.parse(current.buffer.toString("utf8")),
            ),
          ) !== JSON.stringify(desired)
        ) {
          hostedSiteAliasConflict();
        }
      }
    }
    signal.throwIfAborted();
    return pointer;
  },
);
