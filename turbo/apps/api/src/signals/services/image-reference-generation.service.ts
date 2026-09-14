import { command } from "ccstate";
import { isFeatureEnabled } from "@okouai/core/feature-switch";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";

import { db$ } from "../external/db";
import { generatePrivatePresignedGetUrl } from "../external/s3";
import { settle } from "../utils";
import { loadUserFeatureSwitchContext } from "./feature-switches.service";
import { loadAccessibleImageReference } from "./image-reference-data.service";
import {
  IMAGE_REFERENCE_EXCLUSIVE_OWNER,
  privateArtifactRecord,
} from "./private-artifact-storage.service";

const IMAGE_REFERENCE_PROVIDER_URL_TTL_SECONDS = 60 * 60;
const IMAGE_REFERENCE_SOURCE_MARKER =
  "https://image-reference.invalid/provider-source";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Reuse the ordinary source-image parser without teaching it about catalog ids.
 * The marker is parse-only and must be removed before resolution, persistence,
 * or response serialization.
 */
export function withImageReferenceSourceMarker(
  request: unknown,
): Record<string, unknown> {
  if (!isRecord(request)) {
    throw new Error("Image generation request must be an object");
  }
  const current = request.sourceImageUrls;
  const sourceImageUrls =
    current === undefined || current === null || current === ""
      ? []
      : Array.isArray(current)
        ? current
        : [current];
  return {
    ...request,
    sourceImageUrls: [...sourceImageUrls, IMAGE_REFERENCE_SOURCE_MARKER],
  };
}

export function withoutImageReferenceSourceMarker(
  sourceImageUrls: readonly string[],
): readonly string[] {
  if (sourceImageUrls.at(-1) !== IMAGE_REFERENCE_SOURCE_MARKER) {
    throw new Error("Image reference source marker is missing");
  }
  return sourceImageUrls.slice(0, -1);
}

export type ImageReferenceGenerationFailure =
  | { readonly kind: "disabled" }
  | { readonly kind: "not-found" }
  | { readonly kind: "unavailable" };

interface AuthorizedImageReference {
  readonly kind: "authorized";
  readonly bucket: string;
  readonly key: string;
  readonly referenceSource: "owner" | "organization";
}

type ImageReferenceGenerationAccess =
  | Exclude<ImageReferenceGenerationFailure, { readonly kind: "unavailable" }>
  | AuthorizedImageReference;

type ResolvedImageReferenceProviderUrl =
  | ImageReferenceGenerationFailure
  | {
      readonly kind: "resolved";
      readonly url: string;
      readonly referenceSource: "owner" | "organization";
    };

export const authorizeImageReferenceForGeneration$ = command(
  async (
    { get },
    args: {
      readonly orgId: string;
      readonly userId: string;
      readonly referenceId: string;
    },
    signal: AbortSignal,
  ): Promise<ImageReferenceGenerationAccess> => {
    const db = get(db$);
    const featureContext = await loadUserFeatureSwitchContext(
      db,
      args.orgId,
      args.userId,
    );
    signal.throwIfAborted();
    if (!isFeatureEnabled(FeatureSwitchKey.ReferenceImages, featureContext)) {
      return { kind: "disabled" };
    }

    const reference = await loadAccessibleImageReference(db, args);
    signal.throwIfAborted();
    if (!reference) {
      return { kind: "not-found" };
    }

    const source = await get(privateArtifactRecord(reference.sourceFileId));
    signal.throwIfAborted();
    if (!source) {
      return { kind: "not-found" };
    }
    if (
      source.userId !== reference.ownerUserId ||
      source.orgId !== args.orgId ||
      source.accessLevel !== "private" ||
      source.materializationStatus !== "ready" ||
      source.sizeBytes === null ||
      source.exclusiveOwner !== IMAGE_REFERENCE_EXCLUSIVE_OWNER ||
      source.key !== reference.sourceStorageKey ||
      source.filename !== reference.sourceFilename ||
      source.contentType !== reference.sourceContentType
    ) {
      throw new Error("Image reference source invariant violated");
    }

    return {
      kind: "authorized",
      bucket: source.bucket,
      key: source.key,
      referenceSource:
        reference.ownerUserId === args.userId ? "owner" : "organization",
    };
  },
);

export const resolveImageReferenceProviderUrl$ = command(
  async (
    { get, set },
    args: {
      readonly orgId: string;
      readonly userId: string;
      readonly referenceId: string;
    },
    signal: AbortSignal,
  ): Promise<ResolvedImageReferenceProviderUrl> => {
    const access = await set(
      authorizeImageReferenceForGeneration$,
      args,
      signal,
    );
    if (access.kind !== "authorized") {
      return access;
    }

    const urlResult = await settle(
      get(
        generatePrivatePresignedGetUrl(
          access.bucket,
          access.key,
          IMAGE_REFERENCE_PROVIDER_URL_TTL_SECONDS,
        ),
      ),
      signal,
    );
    if (!urlResult.ok) {
      return { kind: "unavailable" };
    }
    return {
      kind: "resolved",
      url: urlResult.value,
      referenceSource: access.referenceSource,
    };
  },
);
