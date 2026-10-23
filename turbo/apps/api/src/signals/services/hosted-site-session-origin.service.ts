import { command } from "ccstate";
import { and, eq } from "drizzle-orm";
import * as z from "zod";
import {
  hostedDeployments,
  privateHostedDeployments,
} from "@okouai/db/runtime/hosted-site";
import type { ArtifactDeliveryRecord } from "@okouai/api-contracts/contracts/artifact-delivery";
import { artifactSharePolicySchema } from "@okouai/api-contracts/contracts/artifact-shares";
import {
  sharedThreadArtifactPolicyKey,
  sharedThreadArtifactPolicySchema,
} from "@okouai/api-contracts/contracts/shared-thread-artifacts";
import { env } from "../../lib/env";
import { nowDate } from "../../lib/time";
import { db$ } from "../external/db";
import {
  isS3NotFoundError,
  readArtifactSharePolicyObject$,
} from "../external/s3";
import { settle } from "../utils";
import { readArtifactDeliveryRecord$ } from "./artifact-delivery.service";

const readObject$ = command(
  async ({ set }, key: string, signal: AbortSignal): Promise<unknown> => {
    const bucket = env("R2_HOSTED_SITES_BUCKET_NAME");
    if (!bucket) {
      throw new Error("Hosted site storage is not configured");
    }
    const result = await settle(
      set(readArtifactSharePolicyObject$, { bucket, key }, signal),
      signal,
    );
    if (!result.ok) {
      if (isS3NotFoundError(result.error)) {
        return null;
      }
      throw result.error;
    }
    const object: unknown = JSON.parse(result.value.buffer.toString("utf8"));
    return object;
  },
);

const previewSchema = z.object({
  version: z.literal(1),
  publicBrand: z.literal("okou"),
  deploymentId: z.uuid(),
  expiresAt: z.iso.datetime(),
  snapshotId: z.uuid().optional(),
});
const manifestIdentitySchema = z.object({
  deploymentId: z.uuid(),
  siteId: z.uuid(),
  publicBrand: z.literal("okou"),
  access: z.literal("owner-private-v1"),
});

const deploymentOrigin$ = command(
  async (
    { get },
    siteId: string,
    deploymentId: string,
    signal: AbortSignal,
  ) => {
    const [deployment] = await get(db$)
      .select({ id: hostedDeployments.id })
      .from(hostedDeployments)
      .where(
        and(
          eq(hostedDeployments.id, deploymentId),
          eq(hostedDeployments.siteId, siteId),
          eq(hostedDeployments.status, "ready"),
        ),
      )
      .unionAll(
        get(db$)
          .select({ id: privateHostedDeployments.id })
          .from(privateHostedDeployments)
          .where(
            and(
              eq(privateHostedDeployments.id, deploymentId),
              eq(privateHostedDeployments.siteId, siteId),
              eq(privateHostedDeployments.status, "ready"),
            ),
          ),
      );
    signal.throwIfAborted();
    return !!deployment;
  },
);

const previewOrigin$ = command(
  async (
    { set },
    args: {
      readonly siteId: string;
      readonly token: string;
      readonly shared: boolean;
    },
    signal: AbortSignal,
  ) => {
    const object = await set(
      readObject$,
      `${args.shared ? "shared-previews" : "private-previews"}/okou/${args.token}.json`,
      signal,
    );
    if (!object) {
      return false;
    }
    const grant = previewSchema.parse(object);
    if (
      Date.parse(grant.expiresAt) <= nowDate().getTime() ||
      args.shared !== !!grant.snapshotId
    ) {
      return false;
    }
    const prefix = args.shared
      ? `shared-artifacts/okou/${grant.snapshotId}/${grant.deploymentId}`
      : `private-sites/okou/${grant.deploymentId}`;
    const manifest = await set(readObject$, `${prefix}/manifest.json`, signal);
    if (!manifest) {
      return false;
    }
    const identity = manifestIdentitySchema.parse(manifest);
    return (
      identity.siteId === args.siteId &&
      identity.deploymentId === grant.deploymentId
    );
  },
);

const threadResourceOrigin$ = command(
  async (
    { set },
    siteId: string,
    record: Extract<
      ArtifactDeliveryRecord,
      { readonly kind: "thread-resource" }
    >,
    signal: AbortSignal,
  ) => {
    if (record.targetKind !== "html") {
      return false;
    }
    const object = await set(
      readObject$,
      sharedThreadArtifactPolicyKey("okou", record.threadId),
      signal,
    );
    if (!object) {
      return false;
    }
    const policy = sharedThreadArtifactPolicySchema.parse(object);
    const target = policy.resources[record.publicToken];
    return (
      policy.threadId === record.threadId &&
      policy.publicBrand === "okou" &&
      policy.status === "active" &&
      target?.kind === "html" &&
      target.siteId === siteId &&
      (record.targetId === undefined || record.targetId === target.id)
    );
  },
);

const publicationOrigin$ = command(
  async (
    { set },
    args: {
      readonly siteId: string;
      readonly shareId: string;
      readonly token: string;
    },
    signal: AbortSignal,
  ) => {
    const object = await set(
      readObject$,
      `artifact-shares/okou/${args.shareId}.json`,
      signal,
    );
    if (!object) {
      return false;
    }
    const policy = artifactSharePolicySchema.parse(object);
    return (
      policy.shareId === args.shareId &&
      policy.publicBrand === "okou" &&
      policy.status === "active" &&
      policy.publicToken === args.token &&
      policy.target.kind === "html" &&
      policy.target.siteId === args.siteId
    );
  },
);

/** A Site cannot delegate even its scoped credential to another publisher's host. */
export const hostedSiteSessionOrigin$ = command(
  async (
    { set },
    args: {
      readonly siteId: string;
      readonly publicSlug: string;
      readonly label: string;
    },
    signal: AbortSignal,
  ) => {
    if (args.label === args.publicSlug) {
      return true;
    }
    const deploymentId = z
      .uuid()
      .safeParse(args.label.startsWith("dpl-") ? args.label.slice(4) : null);
    if (deploymentId.success) {
      return set(deploymentOrigin$, args.siteId, deploymentId.data, signal);
    }
    const preview = /^(pv|ps)-([a-f0-9]{48})$/u.exec(args.label);
    if (preview) {
      return set(
        previewOrigin$,
        {
          siteId: args.siteId,
          shared: preview[1] === "ps",
          token: preview[2]!,
        },
        signal,
      );
    }
    const record = await set(
      readArtifactDeliveryRecord$,
      { layout: "current", kind: "html", alias: args.label },
      signal,
    );
    signal.throwIfAborted();
    if (record?.kind === "thread-resource") {
      return set(threadResourceOrigin$, args.siteId, record, signal);
    }
    if (record?.kind === "publication") {
      return (
        record.targetKind === "html" &&
        set(
          publicationOrigin$,
          {
            siteId: args.siteId,
            shareId: record.shareId,
            token: record.publicToken,
          },
          signal,
        )
      );
    }
    const legacy = /^sh-([a-f0-9]{32})-([a-f0-9]{24})$/u.exec(args.label);
    const shareId = legacy?.[1]?.replace(
      /^(.{8})(.{4})(.{4})(.{4})(.{12})$/u,
      "$1-$2-$3-$4-$5",
    );
    const token = legacy?.[2];
    if (!shareId || !token) {
      return false;
    }
    return set(
      publicationOrigin$,
      { siteId: args.siteId, shareId, token },
      signal,
    );
  },
);
