import { createHash } from "node:crypto";
import { command, computed } from "ccstate";
import { and, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import { artifactFilenameExtension } from "@okouai/api-contracts/contracts/artifact-delivery";
import {
  artifactShareReferencePath,
  parseArtifactReference,
} from "@okouai/api-contracts/contracts/artifact-references";
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
import { sharedThreadHostedSnapshotFile } from "../../lib/shared-thread-artifact";
import { env } from "../../lib/env";
import { artifactHash } from "../../lib/file-url";
import { db$ } from "../external/db";
import {
  copyArtifactShareObject,
  readHostedSiteSnapshotSource,
  putHostedSitesS3Object,
  readArtifactSharePolicyObject,
} from "../external/s3";
import { settle } from "../utils";
import { mapConcurrent } from "../../lib/map-concurrent";
import {
  recordSharedThreadPhase,
  measureSharedThreadPhase,
} from "./shared-thread-telemetry";
import {
  ARTIFACT_REFERENCE_PATTERN as REFERENCE_PATTERN,
  artifactTextContentType,
  artifactTextReferences,
  MAX_ARTIFACT_TEXT_BYTES as MAX_TEXT_BYTES,
  MAX_ARTIFACT_TOTAL_TEXT_BYTES as MAX_TOTAL_TEXT_BYTES,
} from "../../lib/artifact-text-references";
import {
  collectHostedSiteDependencies$,
  hostedSiteDeliveryManifest,
} from "./hosted-site-dependencies.service";

import {
  artifactFileReference,
  privateArtifactRecord,
} from "./private-artifact-storage.service";
import {
  ArtifactDeliveryAliasConflict,
  registerArtifactDelivery$,
} from "./artifact-delivery.service";
import {
  allocateSharedThreadArtifactReference$,
  artifactReferenceRecord,
} from "./artifact-reference.service";

const MAX_RESOURCES = 100;

export class SharedThreadArtifactUnavailable extends Error {
  constructor() {
    super("A selected artifact or hosted dependency cannot be shared");
  }
}

type SnapshotTarget = SharedThreadArtifactPolicy["resources"][string];

interface SnapshotCopy {
  readonly bucket: string;
  readonly sourceKey: string;
  readonly sourceEtag?: string;
  readonly targetKey: string;
  readonly hosted: boolean;
  readonly body?: Buffer;
  readonly contentType?: string;
}

interface SnapshotResource {
  readonly token: string;
  readonly url: string;
  readonly deliveryUrl: string;
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
  readonly kind?: "file" | "html";
  readonly suffix: string;
  readonly key?: string;
}

type SnapshotSource =
  | ResourceReference
  | { readonly kind: "snapshot"; readonly url: string };

function signedFileReference(url: URL): ResourceReference {
  const [bucket, ...segments] = decodeURIComponent(url.pathname.slice(1)).split(
    "/",
  );
  const key = segments.join("/");
  const id = /^private-artifacts\/([^/]+)\//u.exec(key)?.[1];
  if (bucket !== env("R2_PRIVATE_ARTIFACTS_BUCKET_NAME") || !id) {
    throw new SharedThreadArtifactUnavailable();
  }
  return { id, key, suffix: url.hash };
}

function resourceReference(value: string, signal: AbortSignal) {
  return computed(async (get): Promise<SnapshotSource | null> => {
    const reference = parseArtifactReference(value, env("APP_URL"));
    if (reference) {
      if (reference.id) {
        return { id: reference.id, suffix: reference.fragment };
      }
      const record = await get(artifactReferenceRecord(reference.hash, signal));
      if (record?.version === 3) {
        // Existing public snapshot links retain their original parent grant.
        return { kind: "snapshot", url: new URL(value, env("APP_URL")).href };
      }
      // Legacy share aliases grant viewing only. Source references still have
      // their ownership checked before any independent snapshot is published.
      if (record?.version !== 2) {
        throw new SharedThreadArtifactUnavailable();
      }
      return {
        id: record.target.id,
        kind: record.target.kind,
        suffix: reference.fragment,
      };
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
      return signedFileReference(url);
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
      if (url.pathname.startsWith("//")) {
        throw new SharedThreadArtifactUnavailable();
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

const allocateSnapshotReference$ = command(
  async (
    { set },
    args: SnapshotOwner & {
      readonly id: string;
      readonly kind: "file" | "html";
      readonly filename: string;
      readonly reservedTokens: Set<string>;
    },
    signal: AbortSignal,
  ) => {
    const startedAt = performance.now();
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const token = artifactHash(
        args.threadId,
        `${args.kind}:${args.id}:${attempt}`,
      );
      if (args.reservedTokens.has(token)) {
        continue;
      }
      // Reserve before awaiting storage: aliases with different extensions
      // still share the same token namespace in the snapshot policy.
      args.reservedTokens.add(token);
      const registered = await settle(
        set(
          registerArtifactDelivery$,
          {
            alias:
              args.kind === "file"
                ? `${token}${artifactFilenameExtension(args.filename)}`
                : token,
            targetKind: args.kind,
            record: {
              version: 1,
              kind: "thread-resource",
              publicBrand: args.publicBrand,
              threadId: args.threadId,
              publicToken: token,
              targetKind: args.kind,
              targetId: args.id,
            },
          },
          signal,
        ),
        signal,
      );
      if (registered.ok) {
        const reference = await set(
          allocateSharedThreadArtifactReference$,
          {
            threadId: args.threadId,
            publicBrand: args.publicBrand,
            publicToken: token,
            target: { kind: args.kind, id: args.id },
          },
          signal,
        );
        recordSharedThreadPhase({
          shareId: args.threadId,
          phase: "alias",
          durationMs: Math.round(performance.now() - startedAt),
          attempts: attempt + 1,
        });
        return {
          token,
          url: new URL(
            artifactShareReferencePath(reference, args.filename),
            env("APP_URL"),
          ).href,
        };
      }
      if (!(registered.error instanceof ArtifactDeliveryAliasConflict)) {
        throw registered.error;
      }
    }
    throw new Error(
      "Unable to allocate a unique conversation artifact reference",
    );
  },
);

const privateFileSnapshot$ = command(
  async (
    { get, set },
    args: SnapshotOwner & { readonly reservedTokens: Set<string> },
    reference: ResourceReference,
    signal: AbortSignal,
  ) => {
    if (reference.kind === "html") {
      return null;
    }
    const file = await get(privateArtifactRecord(reference.id));
    signal.throwIfAborted();
    if (file) {
      if (
        file.userId !== args.userId ||
        file.orgId !== args.orgId ||
        file.materializationStatus !== "ready" ||
        (reference.key !== undefined && reference.key !== file.key)
      ) {
        throw new SharedThreadArtifactUnavailable();
      }
      const { token, url } = await set(
        allocateSnapshotReference$,
        { ...args, id: file.id, kind: "file", filename: file.filename },
        signal,
      );
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
        url,
        sourceKey: file.key,
        deliveryUrl: resourceUrl(args.publicBrand, token, target),
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
  },
);

function ownedHostedDeployment(
  args: SnapshotOwner,
  reference: ResourceReference,
  signal: AbortSignal,
) {
  return computed(async (get) => {
    if (
      reference.kind === "file" ||
      !z.uuid().safeParse(reference.id).success ||
      reference.key
    ) {
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

const hostedSnapshotCopies$ = command(
  async (
    { get, set },
    args: {
      readonly threadId: string;
      readonly publicBrand: SharedThreadArtifactPolicy["publicBrand"];
      readonly deployment: typeof privateHostedDeployments.$inferSelect;
      readonly target: Extract<SnapshotTarget, { kind: "html" }>;
      readonly budget: { sourceBytes: number; outputBytes: number };
      readonly rewrite: (content: string) => Promise<string>;
    },
    signal: AbortSignal,
  ) => {
    const { deployment, target, budget, rewrite } = args;
    const copies: SnapshotCopy[] = [];
    const bucket = sharedThreadArtifactsBucket();
    const index = await set(
      collectHostedSiteDependencies$,
      deployment,
      bucket,
      signal,
    );
    if (index.status !== "complete") {
      throw new SharedThreadArtifactUnavailable();
    }
    const prefix = `shared-artifacts/${args.publicBrand}/${args.threadId}/${deployment.id}`;
    for (const [path, entry] of Object.entries(deployment.manifest.files)) {
      signal.throwIfAborted();
      const sourceKey = `${deployment.r2Prefix}${path}`;
      const targetKey = `${prefix}${path}`;
      const copy = { bucket, sourceKey, targetKey, hosted: true };
      if (!artifactTextContentType(entry.contentType)) {
        copies.push(copy);
        continue;
      }
      const indexed = index.files[path];
      if (!indexed || indexed.size > MAX_TEXT_BYTES) {
        throw new SharedThreadArtifactUnavailable();
      }
      budget.sourceBytes += indexed.size;
      if (budget.sourceBytes > MAX_TOTAL_TEXT_BYTES) {
        throw new SharedThreadArtifactUnavailable();
      }
      // Re-resolve ownership at share time. The index contains references,
      // never an authorization grant, and may include recursive dependencies.
      const references = indexed.references.join("\n");
      const rewrittenReferences = await rewrite(references);
      signal.throwIfAborted();
      if (references === rewrittenReferences) {
        budget.outputBytes += indexed.size;
        target.manifest.files[path] = {
          ...entry,
          size: indexed.size,
          sha256: indexed.sha256,
        };
        copies.push({ ...copy, sourceEtag: indexed.etag });
      } else {
        const read = await settle(
          get(
            readHostedSiteSnapshotSource(
              bucket,
              sourceKey,
              signal,
              indexed.etag,
            ),
          ),
          signal,
        );
        if (!read.ok) {
          if (
            read.error instanceof Error &&
            ["NoSuchKey", "PreconditionFailed"].includes(read.error.name)
          ) {
            throw new SharedThreadArtifactUnavailable();
          }
          throw read.error;
        }
        const original = read.value;
        if (
          createHash("sha256").update(original.buffer).digest("hex") !==
          indexed.sha256
        ) {
          throw new SharedThreadArtifactUnavailable();
        }
        const body = Buffer.from(
          await rewrite(original.buffer.toString("utf8")),
        );
        signal.throwIfAborted();
        if (body.byteLength > MAX_TEXT_BYTES) {
          throw new SharedThreadArtifactUnavailable();
        }
        budget.outputBytes += body.byteLength;
        target.manifest.files[path] = {
          ...entry,
          size: body.byteLength,
          sha256: createHash("sha256").update(body).digest("hex"),
        };
        copies.push({ ...copy, body, contentType: entry.contentType });
      }
      if (budget.outputBytes > MAX_TOTAL_TEXT_BYTES) {
        throw new SharedThreadArtifactUnavailable();
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
  },
);

async function rewriteSnapshotMessages(
  sourceMessages: readonly SharedMessage[],
  rewrite: (content: string) => Promise<string>,
  signal: AbortSignal,
): Promise<SharedMessage[]> {
  const messages: SharedMessage[] = [];
  for (const message of sourceMessages) {
    const attachments:
      | NonNullable<SharedMessage["attachments"]>[number][]
      | undefined = message.attachments === undefined ? undefined : [];
    for (const attachment of message.attachments ?? []) {
      attachments?.push({
        ...attachment,
        url: await rewrite(attachment.url),
      });
    }
    messages.push({
      ...message,
      content: await rewrite(message.content),
      ...(attachments === undefined ? {} : { attachments }),
    });
  }
  signal.throwIfAborted();
  return messages;
}

function snapshotPolicy(
  args: SnapshotOwner,
  resources: ReadonlyMap<string, SnapshotResource>,
): SharedThreadArtifactPolicy {
  return sharedThreadArtifactPolicySchema.parse({
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
}

function replaceSnapshotReferences(
  content: string,
  replacements: ReadonlyMap<string, string>,
): string {
  return content.replace(REFERENCE_PATTERN, (match) => {
    const value = match.replace(/[.,;!]+$/u, "");
    return `${replacements.get(value) ?? value}${match.slice(value.length)}`;
  });
}

const rewriteSnapshotContent$ = command(
  async (
    { get, set },
    args: SnapshotOwner & {
      readonly content: string;
      readonly delivery: "reference" | "bytes";
      readonly resolve: (
        reference: ResourceReference,
      ) => Promise<SnapshotResource>;
    },
    signal: AbortSignal,
  ): Promise<string> => {
    const { content, delivery, resolve } = args;
    const replacements = new Map(
      await mapConcurrent(
        artifactTextReferences(content),
        10,
        async (value) => {
          const source = value.replaceAll("&amp;", "&");
          const reference = await get(resourceReference(source, signal));
          signal.throwIfAborted();
          if (!reference) {
            return [value, value] as const;
          }
          if (reference.kind === "snapshot") {
            return [value, reference.url] as const;
          }
          const resource = await resolve(reference);
          signal.throwIfAborted();
          if (delivery === "bytes") {
            return [
              value,
              `${resource.deliveryUrl}${reference.suffix}`,
            ] as const;
          }
          const fragmentIndex = reference.suffix.indexOf("#");
          const path =
            fragmentIndex === -1
              ? reference.suffix
              : reference.suffix.slice(0, fragmentIndex);
          const fragment =
            fragmentIndex === -1 ? "" : reference.suffix.slice(fragmentIndex);
          if (!path) {
            return [value, `${resource.url}${fragment}`] as const;
          }
          if (resource.target.kind !== "html") {
            throw new SharedThreadArtifactUnavailable();
          }
          const previewPath = `/${path}`;
          const file = sharedThreadHostedSnapshotFile(
            resource.target,
            previewPath,
          );
          if (!file) {
            throw new SharedThreadArtifactUnavailable();
          }
          const childReference = await set(
            allocateSharedThreadArtifactReference$,
            {
              threadId: args.threadId,
              publicBrand: args.publicBrand,
              publicToken: resource.token,
              target: { kind: "html", id: resource.target.id },
              previewPath,
            },
            signal,
          );
          const filename = file.path.slice(file.path.lastIndexOf("/") + 1);
          const childUrl = new URL(
            artifactShareReferencePath(childReference, filename),
            env("APP_URL"),
          );
          childUrl.hash = fragment;
          return [value, childUrl.href] as const;
        },
      ),
    );
    signal.throwIfAborted();
    return replaceSnapshotReferences(content, replacements);
  },
);

/** Discover only the selected messages and their managed static dependencies. */
export const prepareSharedThreadArtifacts$ = command(
  async (
    { get, set },
    args: SnapshotOwner & { readonly messages: readonly SharedMessage[] },
    signal: AbortSignal,
  ): Promise<{
    messages: SharedMessage[];
    plan: SharedThreadArtifactPlan | null;
  }> => {
    const resources = new Map<string, SnapshotResource>();
    const pendingResources = new Map<string, Promise<SnapshotResource>>();
    const hostedQueue: {
      deployment: typeof privateHostedDeployments.$inferSelect;
      target: Extract<SnapshotTarget, { kind: "html" }>;
    }[] = [];
    const reservedTokens = new Set<string>();
    const copies: SnapshotCopy[] = [];
    const budget = { sourceBytes: 0, outputBytes: 0 };

    async function allocate(
      reference: ResourceReference,
    ): Promise<SnapshotResource> {
      const file = await set(
        privateFileSnapshot$,
        { ...args, reservedTokens },
        reference,
        signal,
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
      const { token, url } = await set(
        allocateSnapshotReference$,
        {
          ...args,
          id: deployment.id,
          kind: "html",
          filename: "index.html",
          reservedTokens,
        },
        signal,
      );
      const sourceManifest = hostedSiteDeliveryManifest(deployment.manifest);
      const target: Extract<SnapshotTarget, { kind: "html" }> = {
        kind: "html",
        id: deployment.id,
        siteId: deployment.siteId,
        snapshotId: args.threadId,
        deploymentVersion: deployment.deploymentVersion,
        manifest: {
          ...sourceManifest,
          access: "owner-private-v1",
          publicBrand: args.publicBrand,
          files: { ...deployment.manifest.files },
        },
      };
      const resource = {
        token,
        target,
        url,
        deliveryUrl: resourceUrl(args.publicBrand, token, target),
      };
      // Walk dependency bodies after allocation. Cycles need only each other's
      // reserved URL, never a promise for a recursively completed snapshot.
      resources.set(reference.id, resource);
      hostedQueue.push({ deployment, target });
      return resource;
    }

    async function resolve(
      reference: ResourceReference,
    ): Promise<SnapshotResource> {
      let pending = pendingResources.get(reference.id);
      if (!pending) {
        if (pendingResources.size >= MAX_RESOURCES) {
          throw new SharedThreadArtifactUnavailable();
        }
        pending = allocate(reference);
        pendingResources.set(reference.id, pending);
      }
      const resource = await pending;
      signal.throwIfAborted();
      if (reference.key && reference.key !== resource.sourceKey) {
        throw new SharedThreadArtifactUnavailable();
      }
      return resource;
    }

    function rewrite(
      content: string,
      delivery: "reference" | "bytes",
    ): Promise<string> {
      return set(
        rewriteSnapshotContent$,
        { ...args, content, delivery, resolve },
        signal,
      );
    }

    const messages = await rewriteSnapshotMessages(
      args.messages,
      (content) => {
        return rewrite(content, "reference");
      },
      signal,
    );
    if (resources.size === 0) {
      return { messages, plan: null };
    }
    // Processing a site may enqueue more sites. Each deployment is allocated
    // once, so nested, repeated, and cyclic references terminate naturally.
    for (const site of hostedQueue) {
      const bundle = await set(
        hostedSnapshotCopies$,
        {
          ...args,
          ...site,
          budget,
          // HTML and its static dependencies need byte URLs, not App viewers.
          rewrite: (content) => {
            return rewrite(content, "bytes");
          },
        },
        signal,
      );
      signal.throwIfAborted();
      copies.push(...bundle);
    }
    const policy = snapshotPolicy(args, resources);
    return { messages, plan: { messages, policy, copies } };
  },
);

export const copySharedThreadArtifacts$ = command(
  async ({ get }, plan: SharedThreadArtifactPlan, signal: AbortSignal) => {
    const result = await settle(
      measureSharedThreadPhase(
        {
          shareId: plan.policy.threadId,
          phase: "copy",
          copyCount: plan.copies.filter((copy) => {
            return copy.body === undefined;
          }).length,
          uploadCount: plan.copies.filter((copy) => {
            return copy.body !== undefined;
          }).length,
          resourceCount: Object.keys(plan.policy.resources).length,
        },
        mapConcurrent(plan.copies, 10, async (copy) => {
          signal.throwIfAborted();
          await (copy.body !== undefined
            ? get(
                putHostedSitesS3Object(
                  copy.bucket,
                  copy.targetKey,
                  copy.body,
                  copy.contentType ?? "application/octet-stream",
                  signal,
                ),
              )
            : get(copyArtifactShareObject(copy, signal)));
        }),
      ),
      signal,
    );
    if (!result.ok) {
      if (
        result.error instanceof Error &&
        ["NoSuchKey", "PreconditionFailed"].includes(result.error.name)
      ) {
        throw new SharedThreadArtifactUnavailable();
      }
      throw result.error;
    }
    signal.throwIfAborted();
  },
);
