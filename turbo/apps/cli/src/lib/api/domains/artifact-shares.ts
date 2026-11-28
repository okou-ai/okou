import { initClient } from "@okouai/api-contracts/contracts/trpc-contract";
import {
  artifactAccessContract,
  type ArtifactVisibilityResponse,
  type ArtifactVisibilityValue,
} from "@okouai/api-contracts/contracts/artifact-access";
import {
  artifactReferencesContract,
  parseArtifactReference,
} from "@okouai/api-contracts/contracts/artifact-references";
import {
  artifactShareTargetSchema,
  type ArtifactShareTarget,
} from "@okouai/api-contracts/contracts/artifact-shares";
import { getPlatformOrigin } from "../../platform-url";
import { getClientConfig, handleError } from "../core/client-factory";

export interface ArtifactShareStatus {
  readonly ownerUrl: string;
  readonly shareId: string | null;
  readonly audience: ArtifactVisibilityValue;
  readonly organization: { readonly id: string; readonly name: string };
  readonly selectedTarget: ArtifactShareTarget | null;
  readonly selectedVersion: number | null;
  readonly candidateVersion: number | null;
  readonly url: string | null;
  readonly shortUrl: string | null;
}

function toShareStatus(
  target: ArtifactShareTarget,
  response: ArtifactVisibilityResponse,
): ArtifactShareStatus {
  return {
    ownerUrl: response.ownerUrl,
    shareId: null,
    audience: response.visibility,
    organization: response.organization,
    selectedTarget: response.visibility === "private" ? null : target,
    selectedVersion: null,
    candidateVersion: null,
    url: response.shareUrl,
    shortUrl: response.shortUrl,
  };
}

export type ResolvedArtifactShareTarget = ArtifactShareTarget & {
  readonly artifactId?: string;
};

async function readArtifactVisibility(
  target: ResolvedArtifactShareTarget,
): Promise<{
  readonly artifactId: string;
  readonly status: ArtifactShareStatus;
}> {
  const client = initClient(artifactAccessContract, await getClientConfig());
  const response = await client.getVisibility({
    params: { artifactId: target.artifactId ?? target.id },
  });
  if (response.status !== 200) {
    handleError(response, "Could not read artifact sharing");
  }
  return {
    artifactId: response.body.artifactId,
    status: toShareStatus(target, response.body),
  };
}

export async function resolveArtifactShareTarget(
  artifact: string,
  kind: ArtifactShareTarget["kind"] | undefined,
): Promise<ResolvedArtifactShareTarget> {
  if (kind) {
    return artifactShareTargetSchema.parse({ kind, id: artifact });
  }
  const reference = parseArtifactReference(artifact, await getPlatformOrigin());
  if (!reference) {
    throw new Error(
      "Use an owned /artifacts/<reference> path or an artifact URL from OKOU_APP_URL. For a file or deployment UUID, add --kind file or --kind html.",
    );
  }
  const client = initClient(
    artifactReferencesContract,
    await getClientConfig(),
  );
  const response = await client.resolve({
    params: { reference: `${reference.hash}${reference.extension}` },
    query: { kind: "artifact" },
  });
  if (response.status !== 200) {
    handleError(response, "Artifact is not available to its owner");
  }
  return {
    ...response.body.target,
    ...(response.body.artifactId
      ? { artifactId: response.body.artifactId }
      : {}),
  };
}

export async function getArtifactShareStatus(
  target: ResolvedArtifactShareTarget,
): Promise<ArtifactShareStatus> {
  return (await readArtifactVisibility(target)).status;
}

export async function setArtifactAudience(
  target: ResolvedArtifactShareTarget,
  audience: ArtifactShareStatus["audience"],
): Promise<ArtifactShareStatus> {
  const { artifactId, status } = await readArtifactVisibility(target);
  if (audience === "private" && status.audience === "private") {
    return status;
  }
  if (
    status.audience === audience &&
    status.url &&
    status.selectedTarget?.kind === target.kind &&
    status.selectedTarget.id === target.id &&
    !(
      (audience === "organization" || target.kind === "html") &&
      status.shortUrl === null
    )
  ) {
    return status;
  }
  const client = initClient(artifactAccessContract, await getClientConfig());
  const response = await client.updateVisibility({
    params: { artifactId },
    body: { visibility: audience },
  });
  if (response.status !== 200) {
    handleError(
      response,
      "Could not change artifact visibility. Rerun without --visibility before retrying; the change may have applied.",
    );
  }
  return toShareStatus(target, response.body);
}
