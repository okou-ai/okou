import { createHash } from "node:crypto";
import { command, computed } from "ccstate";
import {
  and,
  desc,
  eq,
  inArray,
  isNotNull,
  isNull,
  or,
  sql,
} from "drizzle-orm";
import { z } from "zod";
import { artifactFilenameExtension } from "@okouai/api-contracts/contracts/artifact-delivery";
import {
  artifactShareReferencePath,
  artifactReferencePath,
  parseArtifactReference,
} from "@okouai/api-contracts/contracts/artifact-references";
import type { SharedMessage } from "@okouai/api-contracts/contracts/shared-threads";
import {
  sharedThreadArtifactPolicySchema,
  type SharedThreadArtifactPolicy,
} from "@okouai/api-contracts/contracts/shared-thread-artifacts";
import {
  hostedSites,
  privateHostedDeployments,
} from "@okouai/db/runtime/hosted-site";
import { runUploadedFiles } from "@okouai/db/schema/run-uploaded-file";
import { apiBackendUrl } from "../../lib/api-backend-url";
import { sharedThreadHostedSnapshotFile } from "../../lib/shared-thread-artifact";
import { env } from "../../lib/env";
import { artifactHash } from "../../lib/file-url";
import { legacyPrivateHostedDeploymentVersion } from "../../lib/hosted-publication";
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
  privateArtifactUrl,
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
  readonly reference: string;
  readonly url: string;
  readonly deliveryUrl: string;
  readonly target: SnapshotTarget;
  readonly sourceKey?: string;
  readonly previewImageUrl?: string | null;
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
      // Hosted sites are public publications. Their links are shared as links,
      // never copied into a conversation snapshot.
      if (record.target.kind === "html") {
        return null;
      }
      return { id: record.target.id, suffix: reference.fragment };
    }
    const file = artifactFileReference(value);
    if (file) {
      return { id: file.id, suffix: "" };
    }
    const apiOrigin = apiBackendUrl();
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
          reference,
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
      const {
        token,
        reference: snapshotReference,
        url,
      } = await set(
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
        reference: snapshotReference,
        target,
        url,
        sourceKey: file.key,
        previewImageUrl: await get(
          privateFileSnapshotPreviewImage(file, signal),
        ),
        deliveryUrl: resourceUrl(args.publicBrand, token, target),
      };
      signal.throwIfAborted();
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

function privateFileSnapshotPreviewImage(
  file: Pick<
    typeof runUploadedFiles.$inferSelect,
    "id" | "userId" | "metadata" | "previewImageUrl"
  > & {
    readonly orgId: string;
    readonly filename: string;
    readonly contentType: string;
  },
  signal: AbortSignal,
) {
  return computed(async (get) => {
    if (file.previewImageUrl || !file.contentType.startsWith("video/")) {
      return file.previewImageUrl;
    }
    const paths = [
      privateArtifactUrl(file.id, file.filename, file.metadata),
      artifactReferencePath(file.id, file.filename),
    ];
    // Run associations can be separate from the private storage identity.
    // Match that exact file, never another artifact with the same filename.
    const [row] = await get(db$)
      .select({ previewImageUrl: runUploadedFiles.previewImageUrl })
      .from(runUploadedFiles)
      .where(
        and(
          eq(runUploadedFiles.userId, file.userId),
          eq(runUploadedFiles.orgId, file.orgId),
          isNotNull(runUploadedFiles.previewImageUrl),
          or(
            eq(runUploadedFiles.externalId, file.id),
            inArray(
              runUploadedFiles.url,
              paths.flatMap((path) => {
                return [path, new URL(path, env("APP_URL")).href];
              }),
            ),
          ),
        ),
      )
      .orderBy(desc(runUploadedFiles.updatedAt), desc(runUploadedFiles.id))
      .limit(1);
    signal.throwIfAborted();
    return row?.previewImageUrl ?? null;
  });
}

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
  previews: NonNullable<SharedThreadArtifactPolicy["previews"]>,
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
    ...(Object.keys(previews).length ? { previews } : {}),
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
          if (path) {
            // Only a site could address a path below an artifact, and sites
            // are no longer copied into a snapshot.
            throw new SharedThreadArtifactUnavailable();
          }
          return [value, `${resource.url}${fragment}`] as const;
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
      if (!file) {
        throw new SharedThreadArtifactUnavailable();
      }
      resources.set(reference.id, file.resource);
      copies.push(file.copy);
      return file.resource;
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
    const previews: NonNullable<SharedThreadArtifactPolicy["previews"]> = {};
    for (const resource of resources.values()) {
      if (!resource.previewImageUrl) {
        continue;
      }
      const reference = await get(
        resourceReference(resource.previewImageUrl, signal),
      );
      signal.throwIfAborted();
      if (!reference || reference.kind === "snapshot") {
        throw new SharedThreadArtifactUnavailable();
      }
      const preview = await resolve(reference);
      signal.throwIfAborted();
      if (
        preview.target.kind !== "file" ||
        !preview.target.contentType.startsWith("image/")
      ) {
        throw new SharedThreadArtifactUnavailable();
      }
      previews[resource.token] = {
        token: preview.token,
        reference: preview.reference,
      };
    }
    const policy = snapshotPolicy(args, resources, previews);
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
