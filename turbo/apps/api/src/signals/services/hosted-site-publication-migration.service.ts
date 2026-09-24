import { randomUUID } from "node:crypto";
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
import { artifactShares } from "@okouai/db/schema/artifact-share";
import {
  hostedDeployments,
  privateHostedDeployments,
  type hostedSites,
} from "@okouai/db/runtime/hosted-site";
import type { Tx } from "../../lib/db-types";
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

function storedObject(bucket: string, key: string, signal: AbortSignal) {
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

function aliasConflict(): never {
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
    policy.publicBrand !== site.publicBrand ||
    !retainedAudience ||
    (policy.publicSlug !== undefined &&
      policy.publicSlug !== site.publicSlug) ||
    policy.target.kind !== "html" ||
    policy.target.siteId !== site.id ||
    policy.target.manifest.publicSlug !== site.publicSlug
  ) {
    aliasConflict();
  }
}

/** The caller holds the site row; lock its share next, also used by the backfill. */
const preserveSnapshotToken$ = command(
  async (
    { get },
    args: {
      readonly tx: Tx;
      readonly site: HostedSite;
      readonly bucket: string;
      readonly record: Extract<ArtifactDeliveryRecord, { kind: "publication" }>;
    },
    signal: AbortSignal,
  ) => {
    const { site, record } = args;
    const [share] = await args.tx
      .select()
      .from(artifactShares)
      .where(eq(artifactShares.id, record.shareId))
      .for("update");
    signal.throwIfAborted();
    if (
      !share ||
      share.targetKind !== "html" ||
      share.targetId !== site.id ||
      share.orgId !== site.orgId ||
      share.userId !== site.userId ||
      share.publicBrand !== site.publicBrand ||
      record.targetKind !== "html" ||
      record.publicBrand !== site.publicBrand ||
      record.publicToken === site.publicSlug
    ) {
      aliasConflict();
    }
    const key = `artifact-shares/${site.publicBrand}/${share.id}.json`;
    const stored = await get(storedObject(args.bucket, key, signal));
    signal.throwIfAborted();
    if (!stored) {
      aliasConflict();
    }
    const policy = artifactSharePolicySchema.parse(
      JSON.parse(stored.buffer.toString("utf8")),
    );
    validateSnapshotPolicy(policy, site, record);
    const [source] = await args.tx
      .select({ id: privateHostedDeployments.id })
      .from(privateHostedDeployments)
      .where(
        and(
          eq(privateHostedDeployments.id, policy.target.id),
          eq(privateHostedDeployments.siteId, site.id),
          eq(privateHostedDeployments.userId, site.userId),
          eq(privateHostedDeployments.orgId, site.orgId),
          eq(privateHostedDeployments.publicBrand, site.publicBrand),
          eq(privateHostedDeployments.status, "ready"),
        ),
      );
    signal.throwIfAborted();
    if (!source) {
      aliasConflict();
    }
    const token = await get(
      storedObject(
        args.bucket,
        artifactDeliveryKey(site.publicBrand, "html", record.publicToken),
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
      aliasConflict();
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

async function retainedPointer(
  tx: Tx,
  site: HostedSite,
  current: HostedSitePointer,
  next: HostedSitePointer,
): Promise<HostedSitePointer> {
  if (
    current.siteId !== site.id ||
    current.publicSlug !== site.publicSlug ||
    (current.publicBrand ?? "vm0") !== site.publicBrand
  ) {
    aliasConflict();
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
  // R2 may be ahead of the DB after an interrupted completion transaction.
  // Retain that acknowledged content instead of publishing an older retry.
  const [deployment] = await tx
    .select()
    .from(hostedDeployments)
    .where(
      and(
        eq(hostedDeployments.id, current.deploymentId),
        eq(hostedDeployments.siteId, site.id),
        eq(hostedDeployments.orgId, site.orgId),
        eq(hostedDeployments.userId, site.userId),
        eq(hostedDeployments.publicBrand, site.publicBrand),
      ),
    );
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
  return current;
}

/** Publish prepared public bytes before changing a same-site historical alias. */
export const publishHostedSitePointer$ = command(
  async (
    { get, set },
    args: {
      readonly tx: Tx;
      readonly bucket: string;
      readonly site: HostedSite;
      readonly pointer: HostedSitePointer;
    },
    signal: AbortSignal,
  ): Promise<HostedSitePointer> => {
    const { site } = args;
    const namespace =
      site.publicBrand === "okou" ? "sites/brands/okou" : "sites";
    const pointerKey = `${namespace}/${site.publicSlug}/active.json`;
    const key = artifactDeliveryKey(site.publicBrand, "html", site.publicSlug);
    const desired: ArtifactDeliveryRecord = {
      version: 1,
      kind: "legacy-site",
      publicBrand: site.publicBrand,
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
      aliasConflict();
    }
    const active = await get(storedObject(args.bucket, pointerKey, signal));
    signal.throwIfAborted();
    const pointer = active
      ? await retainedPointer(
          args.tx,
          site,
          hostedSitePointerSchema.parse(
            JSON.parse(active.buffer.toString("utf8")),
          ),
          args.pointer,
        )
      : args.pointer;
    signal.throwIfAborted();
    if (previous?.kind === "publication") {
      await set(preserveSnapshotToken$, { ...args, record: previous }, signal);
    }
    signal.throwIfAborted();
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
          aliasConflict();
        }
      }
    }
    signal.throwIfAborted();
    return pointer;
  },
);
