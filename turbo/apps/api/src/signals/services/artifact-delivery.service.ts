import { command, computed } from "ccstate";
import {
  artifactDeliveryKey,
  artifactDeliveryRecordSchema,
  type ArtifactDeliveryRecord,
} from "@okouai/api-contracts/contracts/artifact-delivery";
import { env } from "../../lib/env";
import {
  isS3NotFoundError,
  readArtifactSharePolicyObject,
  writeArtifactSharePolicyObject,
} from "../external/s3";
import { settle } from "../utils";

export class ArtifactDeliveryAliasConflict extends Error {}

/** Registry entries identify an alias; publication access still requires its live policy. */
export function artifactDeliveryRecord(
  brand: "vm0" | "okou",
  kind: "file" | "html",
  alias: string,
  signal: AbortSignal,
) {
  return computed(async (get) => {
    const bucket = env("R2_HOSTED_SITES_BUCKET_NAME");
    if (!bucket) {
      throw new Error("Artifact delivery registry storage is not configured");
    }
    const result = await settle(
      get(
        readArtifactSharePolicyObject(
          bucket,
          artifactDeliveryKey(brand, kind, alias),
          signal,
        ),
      ),
      signal,
    );
    if (!result.ok) {
      if (isS3NotFoundError(result.error)) {
        return null;
      }
      throw result.error;
    }
    const record = artifactDeliveryRecordSchema.parse(
      JSON.parse(result.value.buffer.toString("utf8")),
    );
    if (record.publicBrand !== brand) {
      throw new Error("Artifact delivery alias has an inconsistent brand");
    }
    return record;
  });
}

/** Immutable alias ownership survives revocation; only the share policy changes. */
export const registerArtifactDelivery$ = command(
  async (
    { get },
    args: {
      readonly alias: string;
      readonly targetKind: "file" | "html";
      readonly record: ArtifactDeliveryRecord;
    },
    signal: AbortSignal,
  ) => {
    const record = artifactDeliveryRecordSchema.parse(args.record);
    const bucket = env("R2_HOSTED_SITES_BUCKET_NAME");
    if (!bucket) {
      throw new Error("Artifact delivery registry storage is not configured");
    }
    const key = artifactDeliveryKey(
      record.publicBrand,
      args.targetKind,
      args.alias,
    );
    if (
      (record.kind === "publication" || record.kind === "thread-resource") &&
      args.targetKind === "html"
    ) {
      const namespace =
        record.publicBrand === "okou" ? "sites/brands/okou" : "sites";
      const legacy = await settle(
        get(
          readArtifactSharePolicyObject(
            bucket,
            `${namespace}/${args.alias}/active.json`,
            signal,
          ),
        ),
        signal,
      );
      if (legacy.ok) {
        throw new ArtifactDeliveryAliasConflict(
          "Publication alias conflicts with a historical site alias",
        );
      }
      if (
        !(legacy.error instanceof Error) ||
        legacy.error.name !== "NoSuchKey"
      ) {
        throw legacy.error;
      }
    }
    const body = JSON.stringify(record);
    const written = await settle(
      get(writeArtifactSharePolicyObject(bucket, key, body, null, signal)),
      signal,
    );
    if (written.ok) {
      return;
    }
    if (
      !(written.error instanceof Error) ||
      written.error.name !== "PreconditionFailed"
    ) {
      throw written.error;
    }
    const existing = await get(
      readArtifactSharePolicyObject(bucket, key, signal),
    );
    signal.throwIfAborted();
    const previous = artifactDeliveryRecordSchema.parse(
      JSON.parse(existing.buffer.toString("utf8")),
    );
    if (JSON.stringify(previous) !== body) {
      throw new ArtifactDeliveryAliasConflict(
        "Artifact delivery alias is already allocated",
      );
    }
  },
);

export const registerLegacyArtifactFile$ = command(
  async (
    { set },
    args: {
      readonly key: string;
      readonly filename: string;
      readonly contentType: string;
      readonly publicBrand: "vm0" | "okou";
    },
    signal: AbortSignal,
  ) => {
    if (!args.key.startsWith("artifacts/")) {
      throw new Error(
        "A private object cannot be registered as a legacy public file",
      );
    }
    await set(
      registerArtifactDelivery$,
      {
        alias: args.key.slice("artifacts/".length),
        targetKind: "file",
        record: {
          version: 1,
          kind: "legacy-file",
          audience: "public",
          ...args,
        },
      },
      signal,
    );
  },
);

export const registerLegacyHostedSite$ = command(
  (
    { set },
    args: {
      readonly alias: string;
      readonly publicBrand: "vm0" | "okou";
      readonly pointerKey: string;
    },
    signal: AbortSignal,
  ) => {
    return set(
      registerArtifactDelivery$,
      {
        alias: args.alias,
        targetKind: "html",
        record: {
          version: 1,
          kind: "legacy-site",
          audience: "public",
          publicBrand: args.publicBrand,
          pointerKey: args.pointerKey,
        },
      },
      signal,
    );
  },
);
