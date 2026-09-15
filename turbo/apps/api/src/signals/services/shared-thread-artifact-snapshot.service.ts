import { createHash, randomBytes } from "node:crypto";
import { command, computed } from "ccstate";
import { and, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import { artifactFilenameExtension } from "@okouai/api-contracts/contracts/artifact-delivery";
import { parseArtifactReference } from "@okouai/api-contracts/contracts/artifact-references";
import type { SharedMessage } from "@okouai/api-contracts/contracts/shared-threads";
import {
  sharedThreadArtifactPolicySchema,
  type SharedThreadArtifactPolicy,
} from "@okouai/api-contracts/contracts/shared-thread-artifacts";
import { privateHostedDeploymentId } from "@okouai/core/private-hosted-artifact";
import {
  hostedSites,
  privateHostedDeployments,
} from "@okouai/db/schema/hosted-site";
import { apiBackendUrl } from "../../lib/api-backend-url";
import { env } from "../../lib/env";
import { db$ } from "../external/db";
import {
  copyArtifactShareObject,
  downloadHostedSitesS3Buffer,
  putHostedSitesS3Object,
  readArtifactSharePolicyObject,
} from "../external/s3";
import { settle } from "../utils";
import {
  artifactFileReference,
  privateArtifactRecord,
} from "./private-artifact-storage.service";
import { registerArtifactDelivery$ } from "./artifact-delivery.service";

const MAX_RESOURCES = 100;
const MAX_TEXT_BYTES = 4 * 1024 * 1024;
const MAX_TOTAL_TEXT_BYTES = 32 * 1024 * 1024;
const REFERENCE_PATTERN =
  /https?:\/\/[^\s<>"'`)\]]+|\/artifacts\/[^\s<>"'`)\]]+|\/api\/[^\s<>"'`)\]]+/gu;

export class SharedThreadArtifactUnavailable extends Error {
  constructor() {
    super("A selected artifact or hosted dependency cannot be shared");
  }
}

type SnapshotTarget = SharedThreadArtifactPolicy["resources"][string];

interface SnapshotCopy {
  readonly bucket: string;
  readonly sourceKey: string;
  readonly targetKey: string;
  readonly hosted: boolean;
  readonly body?: Buffer;
  readonly contentType?: string;
}

interface SnapshotResource {
  readonly token: string;
  readonly url: string;
  readonly target: SnapshotTarget;
  readonly sourceKey?: string;
}

export interface SharedThreadArtifactPlan {
  readonly messages: SharedMessage[];
  readonly policy: SharedThreadArtifactPolicy;
  readonly copies: readonly SnapshotCopy[];
}

export function sharedThreadArtifactsBucket(): string {
  const bucket = env("R2_HOSTED_SITES_BUCKET_NAME");
  if (!bucket) {
    throw new Error("Shared conversation artifact storage is not configured");
  }
  return bucket;
}

function resourceUrl(
  publicBrand: SharedThreadArtifactPolicy["publicBrand"],
  token: string,
  target: SnapshotTarget,
): string {
  if (target.kind === "file") {
    const origin = env("PUBLIC_ARTIFACT_SHARES_BASE_URL");
    if (!origin) {
      throw new Error("Public artifact delivery is not configured");
    }
    return new URL(
      `/${token}${artifactFilenameExtension(target.filename)}`,
      origin,
    ).href;
  }
  const domain = env(
    publicBrand === "okou" ? "OKOU_PUBLIC_HOST_DOMAIN" : "ZERO_HOST_DOMAIN",
  );
  const scheme = env(
    publicBrand === "okou" ? "OKOU_HOST_SCHEME" : "ZERO_HOST_SCHEME",
  );
  if (!domain || !scheme) {
    throw new Error("Public site delivery is not configured");
  }
  return `${scheme}://${token}.${domain}/`;
}

interface ResourceReference {
  readonly id: string;
  readonly suffix: string;
  readonly key?: string;
}

function resourceReference(value: string, signal: AbortSignal) {
  return computed(async (get): Promise<ResourceReference | null> => {
    const reference = parseArtifactReference(value, env("APP_URL"));
    if (reference) {
      // Organization links grant viewing, not publication of the source.
      // Snapshotting requires its owner artifact/deployment reference.
      if (reference.id === null) {
        throw new SharedThreadArtifactUnavailable();
      }
      return { id: reference.id, suffix: reference.fragment };
    }
    const file = artifactFileReference(value);
    if (file) {
      return { id: file.id, suffix: "" };
    }
    const apiOrigin = apiBackendUrl();
    const deployment = apiOrigin
      ? privateHostedDeploymentId(value, apiOrigin)
      : null;
    if (deployment) {
      return { id: deployment, suffix: new URL(value).hash };
    }
    if (!URL.canParse(value)) {
      return null;
    }
    const url = new URL(value);
    if (url.username || url.password) {
      throw new SharedThreadArtifactUnavailable();
    }
    // Resolve managed signed dependencies by their owned storage identity;
    // possession of a signature itself never authorizes publication.
    if (url.hostname.endsWith(".r2.cloudflarestorage.com")) {
      const [bucket, ...segments] = decodeURIComponent(
        url.pathname.slice(1),
      ).split("/");
      const key = segments.join("/");
      const id = /^private-artifacts\/([^/]+)\//u.exec(key)?.[1];
      if (bucket === env("R2_PRIVATE_ARTIFACTS_BUCKET_NAME") && id) {
        return { id, key, suffix: url.hash };
      }
      throw new SharedThreadArtifactUnavailable();
    }
    const preview = await get(hostedPreviewReference(url, signal));
    if (preview) {
      return preview;
    }
    if (
      url.searchParams.has("X-Amz-Signature") ||
      (apiOrigin &&
        url.origin === new URL(apiOrigin).origin &&
        url.pathname.startsWith("/api/"))
    ) {
      throw new SharedThreadArtifactUnavailable();
    }
    return null;
  });
}

function hostedPreviewReference(url: URL, signal: AbortSignal) {
  return computed(async (get): Promise<ResourceReference | null> => {
    for (const publicBrand of ["okou", "vm0"] as const) {
      const domain = env(
        publicBrand === "okou" ? "OKOU_PUBLIC_HOST_DOMAIN" : "ZERO_HOST_DOMAIN",
      );
      if (!domain || !url.hostname.endsWith(`.${domain}`)) {
        continue;
      }
      const alias = url.hostname.slice(0, -domain.length - 1);
      if (!/^pv-[a-f0-9]{48}$/u.test(alias)) {
        return null;
      }
      const stored = await settle(
        get(
          readArtifactSharePolicyObject(
            sharedThreadArtifactsBucket(),
            `private-previews/${publicBrand}/${alias.slice(3)}.json`,
            signal,
          ),
        ),
        signal,
      );
      if (!stored.ok) {
        if (
          stored.error instanceof Error &&
          stored.error.name === "NoSuchKey"
        ) {
          throw new SharedThreadArtifactUnavailable();
        }
        throw stored.error;
      }
      const grant = z
        .object({ deploymentId: z.uuid(), publicBrand: z.literal(publicBrand) })
        .parse(JSON.parse(stored.value.buffer.toString("utf8")));
      return {
        id: grant.deploymentId,
        suffix: `${url.pathname.slice(1)}${url.search}${url.hash}`,
      };
    }
    return null;
  });
}

interface SnapshotOwner {
  readonly threadId: string;
  readonly userId: string;
  readonly orgId: string;
  readonly publicBrand: SharedThreadArtifactPolicy["publicBrand"];
}

function privateFileSnapshot(
  args: SnapshotOwner,
  reference: ResourceReference,
  token: string,
  signal: AbortSignal,
) {
  return computed(async (get) => {
    const file = await get(privateArtifactRecord(reference.id));
    signal.throwIfAborted();
    if (file) {
      if (
        file.userId !== args.userId ||
        file.orgId !== args.orgId ||
        file.materializationStatus !== "ready" ||
        file.exclusiveOwner ||
        (reference.key !== undefined && reference.key !== file.key)
      ) {
        throw new SharedThreadArtifactUnavailable();
      }
      const target: SnapshotTarget = {
        kind: "file",
        id: file.id,
        key: `private-artifacts/${file.id}/thread-shares/${args.threadId}/${token}/${encodeURIComponent(file.filename)}`,
        filename: file.filename,
        contentType: file.contentType,
      };
      const resource = {
        token,
        target,
        sourceKey: file.key,
        url: resourceUrl(args.publicBrand, token, target),
      };
      const copy: SnapshotCopy = {
        bucket: file.bucket,
        sourceKey: file.key,
        targetKey: target.key,
        hosted: false,
      };
      return { resource, copy };
    }
    return null;
  });
}

function ownedHostedDeployment(
  args: SnapshotOwner,
  reference: ResourceReference,
  signal: AbortSignal,
) {
  return computed(async (get) => {
    if (!z.uuid().safeParse(reference.id).success || reference.key) {
      throw new SharedThreadArtifactUnavailable();
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
          eq(privateHostedDeployments.id, reference.id),
          eq(privateHostedDeployments.userId, args.userId),
          eq(privateHostedDeployments.orgId, args.orgId),
          eq(privateHostedDeployments.status, "ready"),
          isNull(hostedSites.deletedAt),
        ),
      )
      .limit(1);
    signal.throwIfAborted();
    if (!row || row.deployment.manifest.access !== "owner-private-v1") {
      throw new SharedThreadArtifactUnavailable();
    }
    return row.deployment;
  });
}

function hostedSnapshotCopies(
  args: {
    readonly threadId: string;
    readonly publicBrand: SharedThreadArtifactPolicy["publicBrand"];
    readonly deployment: typeof privateHostedDeployments.$inferSelect;
    readonly target: Extract<SnapshotTarget, { kind: "html" }>;
    readonly budget: { sourceBytes: number; outputBytes: number };
    readonly rewrite: (content: string) => Promise<string>;
  },
  signal: AbortSignal,
) {
  return computed(async (get) => {
    const { deployment, target, budget, rewrite } = args;
    const copies: SnapshotCopy[] = [];
    const bucket = sharedThreadArtifactsBucket();
    const prefix = `shared-artifacts/${args.publicBrand}/${args.threadId}/${deployment.id}`;
    for (const [path, entry] of Object.entries(deployment.manifest.files)) {
      signal.throwIfAborted();
      const sourceKey = `${deployment.r2Prefix}${path}`;
      const targetKey = `${prefix}${path}`;
      if (
        /^(?:text\/(?:html|css)|(?:application|text)\/(?:javascript|json))(?:;|$)/u.test(
          entry.contentType,
        )
      ) {
        if (
          entry.size > MAX_TEXT_BYTES ||
          budget.sourceBytes + entry.size > MAX_TOTAL_TEXT_BYTES
        ) {
          throw new SharedThreadArtifactUnavailable();
        }
        const original = await get(
          downloadHostedSitesS3Buffer(
            bucket,
            sourceKey,
            {
              maxBytes: MAX_TEXT_BYTES,
            },
            signal,
          ),
        );
        signal.throwIfAborted();
        budget.sourceBytes += original.byteLength;
        if (
          original.byteLength > MAX_TEXT_BYTES ||
          budget.sourceBytes > MAX_TOTAL_TEXT_BYTES
        ) {
          throw new SharedThreadArtifactUnavailable();
        }
        const body = Buffer.from(await rewrite(original.toString("utf8")));
        if (
          body.byteLength > MAX_TEXT_BYTES ||
          budget.outputBytes + body.byteLength > MAX_TOTAL_TEXT_BYTES
        ) {
          throw new SharedThreadArtifactUnavailable();
        }
        budget.outputBytes += body.byteLength;
        target.manifest.files[path] = {
          ...entry,
          size: body.byteLength,
          sha256: createHash("sha256").update(body).digest("hex"),
        };
        copies.push({
          bucket,
          sourceKey,
          targetKey,
          hosted: true,
          body,
          contentType: entry.contentType,
        });
      } else {
        copies.push({ bucket, sourceKey, targetKey, hosted: true });
      }
    }
    copies.push({
      bucket,
      sourceKey: `${deployment.r2Prefix}/manifest.json`,
      targetKey: `${prefix}/manifest.json`,
      hosted: true,
      body: Buffer.from(JSON.stringify(target.manifest)),
      contentType: "application/json",
    });
    return copies;
  });
}

/** Discover only the selected messages and their managed static dependencies. */
export const prepareSharedThreadArtifacts$ = command(
  async (
    { get },
    args: SnapshotOwner & { readonly messages: readonly SharedMessage[] },
    signal: AbortSignal,
  ): Promise<SharedThreadArtifactPlan | null> => {
    const resources = new Map<string, SnapshotResource>();
    const copies: SnapshotCopy[] = [];
    const budget = { sourceBytes: 0, outputBytes: 0 };

    async function resolve(
      reference: ResourceReference,
    ): Promise<SnapshotResource> {
      const existing = resources.get(reference.id);
      if (existing) {
        if (reference.key && reference.key !== existing.sourceKey) {
          throw new SharedThreadArtifactUnavailable();
        }
        return existing;
      }
      if (resources.size >= MAX_RESOURCES) {
        throw new SharedThreadArtifactUnavailable();
      }
      const token = randomBytes(12).toString("hex");
      const file = await get(
        privateFileSnapshot(args, reference, token, signal),
      );
      signal.throwIfAborted();
      if (file) {
        resources.set(reference.id, file.resource);
        copies.push(file.copy);
        return file.resource;
      }
      const deployment = await get(
        ownedHostedDeployment(args, reference, signal),
      );
      signal.throwIfAborted();
      const target: Extract<SnapshotTarget, { kind: "html" }> = {
        kind: "html",
        id: deployment.id,
        siteId: deployment.siteId,
        snapshotId: args.threadId,
        deploymentVersion: deployment.deploymentVersion,
        manifest: {
          ...deployment.manifest,
          access: "owner-private-v1",
          publicBrand: args.publicBrand,
          files: { ...deployment.manifest.files },
        },
      };
      const resource = {
        token,
        target,
        url: resourceUrl(args.publicBrand, token, target),
      };
      // Register before walking dependencies so self references and cycles share
      // one pinned deployment instead of recursively creating new snapshots.
      resources.set(reference.id, resource);
      const bundle = await get(
        hostedSnapshotCopies(
          {
            ...args,
            deployment,
            target,
            budget,
            rewrite,
          },
          signal,
        ),
      );
      signal.throwIfAborted();
      copies.push(...bundle);
      return resource;
    }

    async function rewrite(content: string): Promise<string> {
      const replacements = new Map<string, string>();
      for (const match of content.matchAll(REFERENCE_PATTERN)) {
        const value = match[0].replace(/[.,;!]+$/u, "");
        if (replacements.has(value)) {
          continue;
        }
        const source = value.replaceAll("&amp;", "&");
        const reference = await get(resourceReference(source, signal));
        signal.throwIfAborted();
        if (!reference) {
          continue;
        }
        const resource = await resolve(reference);
        signal.throwIfAborted();
        replacements.set(value, `${resource.url}${reference.suffix}`);
      }
      return content.replace(REFERENCE_PATTERN, (match) => {
        const value = match.replace(/[.,;!]+$/u, "");
        return `${replacements.get(value) ?? value}${match.slice(value.length)}`;
      });
    }

    const messages: SharedMessage[] = [];
    for (const message of args.messages) {
      messages.push({ ...message, content: await rewrite(message.content) });
    }
    if (resources.size === 0) {
      return null;
    }
    const policy = sharedThreadArtifactPolicySchema.parse({
      version: 1,
      threadId: args.threadId,
      ownerId: args.userId,
      orgId: args.orgId,
      publicBrand: args.publicBrand,
      status: "preparing",
      resources: Object.fromEntries(
        [...resources.values()].map((resource) => {
          return [resource.token, resource.target];
        }),
      ),
    });
    return { messages, policy, copies };
  },
);

export const copySharedThreadArtifacts$ = command(
  async ({ get, set }, plan: SharedThreadArtifactPlan, signal: AbortSignal) => {
    for (let start = 0; start < plan.copies.length; start += 10) {
      // Drain every started copy before cleanup can remove its destination.
      const results = await Promise.allSettled(
        plan.copies.slice(start, start + 10).map((copy) => {
          return copy.body !== undefined
            ? get(
                putHostedSitesS3Object(
                  copy.bucket,
                  copy.targetKey,
                  copy.body,
                  copy.contentType ?? "application/octet-stream",
                  signal,
                ),
              )
            : get(
                copyArtifactShareObject(
                  copy.bucket,
                  copy.sourceKey,
                  copy.targetKey,
                  copy.hosted,
                  signal,
                ),
              );
        }),
      );
      signal.throwIfAborted();
      const failed = results.find((result) => {
        return result.status === "rejected";
      });
      if (failed?.status === "rejected") {
        if (
          failed.reason instanceof Error &&
          failed.reason.name === "NoSuchKey"
        ) {
          throw new SharedThreadArtifactUnavailable();
        }
        throw failed.reason;
      }
      signal.throwIfAborted();
    }
    for (const [token, target] of Object.entries(plan.policy.resources)) {
      await set(
        registerArtifactDelivery$,
        {
          alias:
            target.kind === "file"
              ? `${token}${artifactFilenameExtension(target.filename)}`
              : token,
          targetKind: target.kind,
          record: {
            version: 1,
            kind: "thread-resource",
            publicBrand: plan.policy.publicBrand,
            threadId: plan.policy.threadId,
            publicToken: token,
            targetKind: target.kind,
          },
        },
        signal,
      );
    }
  },
);
